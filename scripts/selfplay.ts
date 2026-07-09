#!/usr/bin/env tsx
// Self-play data generator for the OFC value network.
//
// Usage:
//   npx tsx scripts/selfplay.ts [--games N] [--out path] [--seed N]
//
// Writes binary training data in OFCD format. Each sample encodes the board
// state after a placement decision (525 float32 features) + the player's
// final net score (1 float32 label). Run repeatedly to accumulate more data.
//
// Typical flow:
//   npx tsx scripts/selfplay.ts --games 10000 --out data/train_001.bin
//   python scripts/train.py --data data/ --out models/policy.bin
//   firebase storage:cp models/policy.bin gs://hiinakas-355.firebasestorage.app/models/policy.bin

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { runGame, heuristicPolicy } from '../src/engine/simulate'
import type { SimPolicy } from '../src/engine/simulate'
import { ENCODE_DIM } from '../src/engine/encode'
import { createJSModel, createWasmModel } from '../src/engine/wasmModel'
import type { NNModel } from '../src/engine/wasmModel'
import { nnPickPlacement } from '../src/engine/nnPolicy'
import { mctsPickPlacement } from '../src/engine/mcts'
import { getBotMove } from '../src/engine/mc'
import { initSync, MlpModel } from '../src/engine/wasm/ofc_nn.js'

// ── WASM init ─────────────────────────────────────────────────────────────────
// Node.js doesn't support the fetch-based async init, so we read the .wasm
// binary from disk and use initSync. WebAssembly.Module compilation is
// synchronous for the 22 KB ofc-nn binary.

const __selfplayDir = path.dirname(fileURLToPath(import.meta.url))
const wasmBinPath = path.resolve(__selfplayDir, '../src/engine/wasm/ofc_nn_bg.wasm')

let wasmAvailable = false
try {
  const wasmBytes = fs.readFileSync(wasmBinPath)
  initSync({ module: wasmBytes })
  wasmAvailable = true
} catch (e) {
  console.warn(`[selfplay] WASM init failed (${e instanceof Error ? e.message : e}) — using JS fallback`)
}

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 ? (args[idx + 1] ?? defaultVal) : defaultVal
}

const NUM_GAMES    = parseInt(getArg('games', '5000'), 10)
const OUT_PATH     = getArg('out', 'data/train.bin')
const SEED         = parseInt(getArg('seed', String(Date.now() & 0x7fffffff)), 10)
const PLAYER_COUNT = parseInt(getArg('players', '2'), 10) as 2 | 3
const MODEL_PATH   = getArg('model', 'models/policy.bin')
// MCTS simulations per decision (0 = disabled, use depth-1 NN).
// CI uses 150: with ROOT_TOP_K=35 this gives ~4-5 avg visits/candidate so
// MCTS actually explores flush draws and scoring top pairs, not just the NN's
// depth-1 ranking. Lower values (≤100) effectively collapse to NN depth-1 at K=35.
const MCTS_SIMS    = parseInt(getArg('mcts-sims', '0'), 10)
// Heuristic MC rollouts per decision for BOTH seats (0 = disabled). Takes
// priority over the NN/MCTS policy below — used to distill a strong,
// NN-free teacher's self-play outcomes into the value net as a warm-start,
// since heuristicPolicy (the no-model fallback below) is a cheap one-shot
// heuristic with no rollouts, much weaker than getBotMove's N-rollout search.
const HEURISTIC_MC_SIMS = parseInt(getArg('heuristic-mc-sims', '0'), 10)
// Diagnostic flag: exclude bonusGameValue from the teacher's rollout scoring.
// Hypothesis being tested: with only HEURISTIC_MC_SIMS rollouts, the large
// (+7..+17) bonus-EV term may make the teacher gamble on top-heavy lines that
// sometimes foul, producing training data the value net learns badly from.
const NO_BONUS_EV = args.includes('--no-bonus-ev')

// ── Seeded RNG ────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Binary format ─────────────────────────────────────────────────────────────
//
// Header (16 bytes):
//   magic:       u8[4]  "OFCD"
//   version:     u32 LE = 1
//   feature_dim: u32 LE = 525
//   num_samples: u32 LE  (written at end)
//
// Per sample (525 + 1 float32 = 2104 bytes):
//   features: f32[525]
//   outcome:  f32

const HEADER_BYTES = 16
const SAMPLE_BYTES = (ENCODE_DIM + 1) * 4

const outDir = path.dirname(OUT_PATH)
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

// Pre-allocate a write buffer, flushed every FLUSH_EVERY games (configurable —
// long unattended runs should flush often so a kill/crash only loses a few
// minutes of samples instead of the whole buffer).
const FLUSH_EVERY  = parseInt(getArg('flush-every', '500'), 10)
const BUF_SAMPLES  = FLUSH_EVERY * PLAYER_COUNT * 5  // 5 decisions per player per game
const writeBuf = Buffer.allocUnsafe(BUF_SAMPLES * SAMPLE_BYTES)
let bufOffset = 0
let totalSamples = 0

const fd = fs.openSync(OUT_PATH, 'w')

// Reserve space for the header; we'll fill num_samples at the end.
const header = Buffer.alloc(HEADER_BYTES)
header.write('OFCD', 0, 'ascii')
header.writeUInt32LE(1, 4)
header.writeUInt32LE(ENCODE_DIM, 8)
header.writeUInt32LE(0, 12)  // placeholder
fs.writeSync(fd, header)

function flushBuf() {
  if (bufOffset === 0) return
  fs.writeSync(fd, writeBuf, 0, bufOffset)
  bufOffset = 0
}

function writeSample(features: Float32Array, outcome: number) {
  if (bufOffset + SAMPLE_BYTES > writeBuf.length) flushBuf()
  for (let i = 0; i < ENCODE_DIM; i++) {
    writeBuf.writeFloatLE(features[i]!, bufOffset)
    bufOffset += 4
  }
  writeBuf.writeFloatLE(outcome, bufOffset)
  bufOffset += 4
  totalSamples++
}

// ── Main loop ─────────────────────────────────────────────────────────────────

const rng = mulberry32(SEED)
const progressEvery = Math.max(1, Math.floor(NUM_GAMES / 20))

console.log(`Self-play: ${NUM_GAMES} games × ${PLAYER_COUNT} players → ${OUT_PATH}`)
console.log(`Feature dim: ${ENCODE_DIM}, seed: ${SEED}`)

// Load NN policy if a trained model is available; otherwise fall back to heuristic.
// Skipped entirely in heuristic-mc mode — that path never touches the model.
let loadedModel: NNModel | null = null
let basePolicy: SimPolicy = heuristicPolicy
if (HEURISTIC_MC_SIMS > 0) {
  console.log(`Policy: Heuristic MC (${HEURISTIC_MC_SIMS} rollouts/decision, both seats, bonusEV=${!NO_BONUS_EV}) — distillation teacher, no model used`)
} else if (fs.existsSync(MODEL_PATH)) {
  try {
    const buf = fs.readFileSync(MODEL_PATH)
    const modelBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    if (wasmAvailable) {
      loadedModel = createWasmModel(new MlpModel(new Uint8Array(modelBuf)))
    } else {
      loadedModel = createJSModel(modelBuf)
    }
    const backend = wasmAvailable ? 'WASM+SIMD' : 'JS'
    basePolicy = (info) => nnPickPlacement(loadedModel!, info.board, info.hand, info.street, info.revealedOpponentBoards, info.discards)
    const policyName = MCTS_SIMS > 0 ? `MCTS depth-2 (${MCTS_SIMS} sims, heuristic opponents, ${backend})` : `NN depth-1 (${backend})`
    console.log(`Policy: ${policyName}  (${MODEL_PATH})`)
  } catch (e) {
    console.log(`Warning: model at ${MODEL_PATH} is invalid (${e instanceof Error ? e.message : e}) — using heuristic`)
  }
} else {
  console.log('Policy: heuristic (no model found at ' + MODEL_PATH + ')')
  if (MCTS_SIMS > 0) console.log('Note: MCTS requires a model — falling back to heuristic')
}

const t0 = Date.now()

for (let g = 0; g < NUM_GAMES; g++) {
  const gameSeed = (rng() * 0x7fffffff) | 0

  // When MCTS/heuristic-MC is enabled, create a per-game policy closure capturing
  // a fresh RNG. The RNG is seeded independently from the deck so that search
  // decisions are reproducible given the same SEED argument but vary across games.
  const policy: SimPolicy = HEURISTIC_MC_SIMS > 0
    ? (() => {
        const hmcRng = mulberry32((gameSeed ^ 0xB4C3A2D1) >>> 0)
        return (info: Parameters<SimPolicy>[0]) => getBotMove(info, HEURISTIC_MC_SIMS, hmcRng, !NO_BONUS_EV)
      })()
    : (MCTS_SIMS > 0 && loadedModel)
    ? (() => {
        const mctsRng = mulberry32((gameSeed ^ 0xA5A5A5A5) >>> 0)
        const m = loadedModel!
        return (info: Parameters<SimPolicy>[0]) =>
          // nnOpponents: false in selfplay — heuristic opponents keep throughput high
          // (nnOpponents adds ~6× overhead in Node.js, capping at 0.2 g/s vs ~3 g/s).
          // The browser worker uses nnOpponents: true since WASM makes it fast there.
          mctsPickPlacement(info, m, { nSims: MCTS_SIMS, maxDepth: 2, nnOpponents: false }, mctsRng)
      })()
    : basePolicy

  const { samples } = runGame(PLAYER_COUNT, gameSeed, policy)
  for (const s of samples) {
    writeSample(s.features, s.outcome)
  }

  if ((g + 1) % progressEvery === 0 || g === NUM_GAMES - 1) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const gps = ((g + 1) / ((Date.now() - t0) / 1000)).toFixed(0)
    process.stdout.write(`\r  ${g + 1}/${NUM_GAMES} games, ${totalSamples} samples, ${elapsed}s (${gps} g/s)  `)
  }
}

flushBuf()

// Write the actual num_samples into the header.
const finalHeader = Buffer.alloc(4)
finalHeader.writeUInt32LE(totalSamples, 0)
fs.writeSync(fd, finalHeader, 0, 4, 12)
fs.closeSync(fd)

const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\nDone: ${totalSamples} samples in ${elapsed}s → ${OUT_PATH}`)
console.log(`File size: ${(fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(1)} MB`)
