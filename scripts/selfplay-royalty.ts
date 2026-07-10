#!/usr/bin/env tsx
// Royalty-focused self-play data generator for the royalty value network.
//
// Usage:
//   npx tsx scripts/selfplay-royalty.ts [--games N] [--out path] [--seed N] [--mcts-sims N]
//
// Writes binary training data in OFCD format. Label = own royalties + bonus EV
// constant (if top row qualifies for bonus) — NOT net game score.
//
// A "dummy opponent" randomly consumes cards from the deck, simulating the cards
// the bot would see on an opponent's visible board during normal play. The bot
// never plays against the opponent strategically — opponents exist only to remove
// cards from the available deck and provide dead-card context for the encoding.
//
// Training rewards:
//   non-foul board: royalties + BONUS_EV (if QQ/KK/AA+/trips on top)
//   foul board: -6 (penalty)
//
// Bonus EV constants come from bestBonusBoard simulations (see compute-bonus-ev.ts):
//   QQ (13 cards): avg_royalties=9.0 → net=7.0 (avg minus 2 for side-game opponent)
//   KK (14 cards): avg_royalties=12.7 → net=10.7
//   AA/trips (15 cards): avg_royalties=19.2 → net=17.2

import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { Deck } from '../src/engine/deck'
import type { Card, PartialBoard, Board } from '../src/engine/types'
import { applyPlacement } from '../src/engine/placement'
import { heuristicPlacement } from '../src/engine/heuristic'
import { isFoul, royalties, bonusTrigger } from '../src/engine/rules'
import { encodeBoardState, ENCODE_DIM } from '../src/engine/encode'
import { royaltyMctsPickPlacement, royaltyNnMctsPickPlacement } from '../src/engine/royaltyMcts'
import { createJSModel, createWasmModel } from '../src/engine/wasmModel'
import type { NNModel } from '../src/engine/wasmModel'
import { initSync, MlpModel } from '../src/engine/wasm/ofc_nn.js'
import type { InfoState } from '../src/engine/mc'

// ── Bonus EV reward shaping constants ────────────────────────────────────────
// Computed from bestBonusBoard simulations: avg royalties over random deals,
// minus 2 (side-game opponent's expected score against the bonus board).

const BONUS_EV_QQ        = 7.0
const BONUS_EV_KK        = 10.7
const BONUS_EV_AA_TRIPS  = 17.2

function computeRoyaltyLabel(board: Board): number {
  if (isFoul(board)) return -6
  const base = royalties(board)
  const q = bonusTrigger(board)
  const bonus = q === 'QQ' ? BONUS_EV_QQ : q === 'KK' ? BONUS_EV_KK : q === 'AA_OR_TRIPS' ? BONUS_EV_AA_TRIPS : 0
  return base + bonus
}

// ── WASM init ─────────────────────────────────────────────────────────────────

const __dir = path.dirname(fileURLToPath(import.meta.url))
const wasmBinPath = path.resolve(__dir, '../src/engine/wasm/ofc_nn_bg.wasm')

let wasmAvailable = false
try {
  const wasmBytes = fs.readFileSync(wasmBinPath)
  initSync({ module: wasmBytes })
  wasmAvailable = true
} catch (e) {
  console.warn(`[selfplay-royalty] WASM init failed (${e instanceof Error ? e.message : e}) — using JS fallback`)
}

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 ? (args[idx + 1] ?? defaultVal) : defaultVal
}

const NUM_GAMES  = parseInt(getArg('games', '5000'), 10)
const OUT_PATH   = getArg('out', 'data-royalty/train.bin')
const SEED       = parseInt(getArg('seed', String(Date.now() & 0x7fffffff)), 10)
const MODEL_PATH = getArg('model', 'models/royalty_nn.bin')
const MCTS_SIMS  = parseInt(getArg('mcts-sims', '0'), 10)

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
// Same OFCD format as selfplay.ts; label is own royalties instead of net score.

const HEADER_BYTES = 16
const SAMPLE_BYTES = (ENCODE_DIM + 1) * 4

const outDir = path.dirname(OUT_PATH)
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

const FLUSH_EVERY = 500
// Per game: 1 player × 5 decisions. Mix of 2- and 3-player games, so at most 5 decisions.
const BUF_SAMPLES = FLUSH_EVERY * 5
const writeBuf = Buffer.allocUnsafe(BUF_SAMPLES * SAMPLE_BYTES)
let bufOffset = 0
let totalSamples = 0

const fd = fs.openSync(OUT_PATH, 'w')
const header = Buffer.alloc(HEADER_BYTES)
header.write('OFCD', 0, 'ascii')
header.writeUInt32LE(1, 4)
header.writeUInt32LE(ENCODE_DIM, 8)
header.writeUInt32LE(0, 12)
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

// ── Model loading ─────────────────────────────────────────────────────────────

let loadedModel: NNModel | null = null
if (fs.existsSync(MODEL_PATH)) {
  try {
    const buf = fs.readFileSync(MODEL_PATH)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    loadedModel = wasmAvailable
      ? createWasmModel(new MlpModel(new Uint8Array(ab)))
      : createJSModel(ab)
    const backend = wasmAvailable ? 'WASM+SIMD' : 'JS'
    console.log(`Policy: Royalty NN MCTS (${MCTS_SIMS || 'disabled'} sims, ${backend})  (${MODEL_PATH})`)
  } catch (e) {
    console.log(`Warning: royalty model invalid (${e instanceof Error ? e.message : e}) — using heuristic royalty MCTS`)
  }
} else {
  console.log(`Policy: heuristic royalty MCTS (no royalty model at ${MODEL_PATH})`)
}

// ── Per-game simulation ───────────────────────────────────────────────────────

interface DecisionLog {
  boardAfter: PartialBoard
  street: number
  discards: Card[]
  oppBoards: PartialBoard[]
}

function runRoyaltyGame(
  playerCount: 2 | 3,
  gameSeed: number,
  rng: () => number,
): { samples: { features: Float32Array; outcome: number }[] } {
  const deck = new Deck(gameSeed)
  const streetSizes = [5, 3, 3, 3, 3] as const

  // Pre-deal all streets for all players.
  const dealt: Card[][][] = Array.from({ length: playerCount }, () => [])
  for (let s = 0; s <= 4; s++) {
    for (let p = 0; p < playerCount; p++) {
      dealt[p]!.push(deck.deal(streetSizes[s]!))
    }
  }

  // Player 0 = our royalty bot. Players 1+ = dummy opponents (heuristic, card consumers).
  const boards: PartialBoard[] = Array.from({ length: playerCount }, () =>
    ({ top: [], middle: [], bottom: [] })
  )
  const playerDiscards: Card[][] = Array.from({ length: playerCount }, () => [])
  const decisionLog: DecisionLog[] = []

  const mctsRng = mulberry32(((gameSeed ^ 0xA5A5A5A5) + 1) >>> 0)

  for (let s = 0; s <= 4; s++) {
    const snapshots: PartialBoard[] = boards.map(b =>
      ({ top: [...b.top], middle: [...b.middle], bottom: [...b.bottom] })
    )

    // Dummy opponents place first (using heuristic) so we see their boards.
    for (let p = 1; p < playerCount; p++) {
      const oppBoardsForP = snapshots.filter((_, j) => j !== p)
      const pl = heuristicPlacement(snapshots[p]!, dealt[p]![s]!, s, oppBoardsForP)
      boards[p] = applyPlacement(snapshots[p]!, pl)
      if (pl.discard) playerDiscards[p]!.push(pl.discard)
    }

    // Our bot sees opponent boards from PREVIOUS street (snapshot before current moves).
    const revealedOppBoards = snapshots.slice(1)

    // Pick placement for our bot (player 0).
    const hand = dealt[0]![s]!
    const ourBoard = snapshots[0]!
    const ourDiscards = [...playerDiscards[0]!]

    const infoState: InfoState = {
      board: ourBoard,
      hand,
      street: s,
      revealedOpponentBoards: revealedOppBoards,
      discards: ourDiscards,
    }

    let pl: ReturnType<typeof heuristicPlacement>
    if (MCTS_SIMS > 0 && loadedModel) {
      pl = royaltyNnMctsPickPlacement(infoState, loadedModel, MCTS_SIMS, mctsRng)
    } else if (MCTS_SIMS > 0) {
      pl = royaltyMctsPickPlacement(infoState, MCTS_SIMS, mctsRng)
    } else {
      pl = heuristicPlacement(ourBoard, hand, s, revealedOppBoards)
    }

    const boardAfter = applyPlacement(ourBoard, pl)
    boards[0] = boardAfter
    const allDiscards = pl.discard ? [...ourDiscards, pl.discard] : ourDiscards
    decisionLog.push({ boardAfter, street: s, discards: allDiscards, oppBoards: revealedOppBoards })
    if (pl.discard) playerDiscards[0]!.push(pl.discard)
  }

  const outcome = computeRoyaltyLabel(boards[0] as Board)

  const samples = decisionLog.map(d => ({
    features: encodeBoardState(d.boardAfter, d.street, d.oppBoards, d.discards),
    outcome,
  }))

  return { samples }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

const rng = mulberry32(SEED)
const progressEvery = Math.max(1, Math.floor(NUM_GAMES / 20))

console.log(`Royalty self-play: ${NUM_GAMES} games → ${OUT_PATH}`)
console.log(`Feature dim: ${ENCODE_DIM}, seed: ${SEED}, mcts-sims: ${MCTS_SIMS}`)

const t0 = Date.now()

for (let g = 0; g < NUM_GAMES; g++) {
  const gameSeed = (rng() * 0x7fffffff) | 0
  // Alternate between 2-player (1 dummy opp) and 3-player (2 dummy opps) games
  // so the NN learns to handle both 1-opponent and 2-opponent dead-card patterns.
  const playerCount: 2 | 3 = rng() < 0.5 ? 2 : 3

  const { samples } = runRoyaltyGame(playerCount, gameSeed, rng)
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
const finalHeader = Buffer.alloc(4)
finalHeader.writeUInt32LE(totalSamples, 0)
fs.writeSync(fd, finalHeader, 0, 4, 12)
fs.closeSync(fd)

const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\nDone: ${totalSamples} samples in ${elapsed}s → ${OUT_PATH}`)
console.log(`File size: ${(fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(1)} MB`)
