// Web Worker entry point — all engine compute runs here, never on the UI thread.
// The worker only imports from the engine boundary (src/engine/).

import { runMC, getBotMove, legalPlacements } from '../engine/mc'
import type { InfoState, ScoredPlacement } from '../engine/mc'
import type { WorkerRequest, WorkerResponse } from './types'
import type { NNModel } from '../engine/wasmModel'
import { createJSModel, createWasmModel } from '../engine/wasmModel'
import { nnRankCandidates } from '../engine/nnPolicy'
import { ENCODE_DIM } from '../engine/encode'
import { mctsPickPlacement, mctsScoredPlacements } from '../engine/mcts'
import type { MCTSOptions } from '../engine/mcts'
import initWasm, { MlpModel } from '../engine/wasm/ofc_nn.js'

// Seeded RNG (mulberry32) — reproduced here to avoid circular import.
function makeRNG(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Begin WASM init at module load. We await this inside handleMessage before
// using MlpModel so any startup latency doesn't block the worker from receiving
// messages. If WASM init fails we fall back to the pure-JS model.
const wasmReady: Promise<void> = initWasm().then(() => undefined).catch((err: unknown) => {
  console.warn('[worker] WASM init failed, falling back to JS inference:', err)
})

// Active model — null until LOAD_MODEL completes.
let loadedModel: NNModel | null = null

// nnOpponents is enabled because WASM makes opponent NN calls cheap enough to
// be net-faster than heuristic opponents even including the extra forward passes.
const COACH_MCTS_OPTS: MCTSOptions    = { nSims: 500, maxDepth: 2, nnOpponents: true }
const ANALYSIS_MCTS_OPTS: MCTSOptions = { nSims: 500, maxDepth: 2, nnOpponents: true }
const BOT_MCTS_OPTS: MCTSOptions      = { nSims: 50,  maxDepth: 2, nnOpponents: true }

// Instant depth-1 NN baseline using a single batched forward pass.
// Shown to the user before MCTS results are ready.
function evalCandidatesNN(model: NNModel, state: InfoState): ScoredPlacement[] {
  const candidates = legalPlacements(state.board, state.hand, state.street)
  const ranked = nnRankCandidates(
    model, candidates, state.board, state.street,
    state.revealedOpponentBoards, state.discards ?? [],
  )
  const scale = model.outputScale
  return ranked.map(({ pl, val }) => ({ placement: pl, ev: val * scale, variance: 0, n: 0 }))
}

const handleMessage = async (event: MessageEvent<WorkerRequest>): Promise<void> => {
  await wasmReady   // no-op once WASM is initialised (Promise already settled)
  const msg = event.data
  try {
    if (msg.type === 'GET_EV') {
      const { state, totalRollouts, batchSize, seed } = msg.payload
      const rng = makeRNG(seed)

      if (loadedModel) {
        // Step 1: instant depth-1 NN pass so the UI has something to show immediately.
        const nnResults = evalCandidatesNN(loadedModel, state)
        self.postMessage({ id: msg.id, type: 'EV_PROGRESS', payload: nnResults } as WorkerResponse)

        // Step 2: MCTS refinement — depth-2 search averaged over sampled worlds.
        const mctsResults = mctsScoredPlacements(state, loadedModel, COACH_MCTS_OPTS, rng)
        self.postMessage({ id: msg.id, type: 'EV_PROGRESS', payload: mctsResults } as WorkerResponse)
        self.postMessage({ id: msg.id, type: 'EV_DONE',     payload: mctsResults } as WorkerResponse)
      } else {
        // No model loaded: fall back to MC with heuristic rollouts.
        const fallbackRng = makeRNG(seed)
        let lastResults: ScoredPlacement[] | null = null
        for (const results of runMC(state, { totalRollouts, batchSize }, fallbackRng)) {
          lastResults = results
          self.postMessage({ id: msg.id, type: 'EV_PROGRESS', payload: results } as WorkerResponse)
        }
        self.postMessage({ id: msg.id, type: 'EV_DONE', payload: lastResults ?? [] } as WorkerResponse)
      }

    } else if (msg.type === 'GET_BOT_MOVE') {
      const { state, rollouts, seed } = msg.payload
      const placement = loadedModel
        ? mctsPickPlacement(state, loadedModel, BOT_MCTS_OPTS, makeRNG(seed))
        : getBotMove(state, rollouts, makeRNG(seed))
      self.postMessage({ id: msg.id, type: 'BOT_MOVE', payload: placement } as WorkerResponse)

    } else if (msg.type === 'ANALYZE_POSITIONS') {
      const { positions, rollouts = 0, seed = 0 } = msg.payload
      const total = positions.length
      const opts: MCTSOptions = rollouts > 0
        ? { ...ANALYSIS_MCTS_OPTS, nSims: Math.max(rollouts, ANALYSIS_MCTS_OPTS.nSims) }
        : ANALYSIS_MCTS_OPTS
      const allResults: Array<{ id: string; candidates: ScoredPlacement[]; hasModel: boolean }> = []

      for (let i = 0; i < total; i++) {
        const { id, state } = positions[i]!
        if (!loadedModel) {
          const item = { id, candidates: [], hasModel: false }
          allResults.push(item)
          self.postMessage({ id: msg.id, type: 'ANALYSIS_PROGRESS', payload: { done: i + 1, total, item } } as WorkerResponse)
          continue
        }

        const rng = makeRNG((seed + i * 1000003) >>> 0)
        const candidates = mctsScoredPlacements(state, loadedModel, opts, rng)
        const item = { id, candidates, hasModel: true }
        allResults.push(item)
        self.postMessage({ id: msg.id, type: 'ANALYSIS_PROGRESS', payload: { done: i + 1, total, item } } as WorkerResponse)
      }

      self.postMessage({ id: msg.id, type: 'ANALYSIS_DONE', payload: allResults } as WorkerResponse)

    } else if (msg.type === 'LOAD_MODEL') {
      try {
        let model: NNModel
        try {
          // Try WASM backend first (SIMD-accelerated, 5-15× faster than JS).
          model = createWasmModel(new MlpModel(new Uint8Array(msg.payload)))
        } catch {
          // WASM construction failed — use pure-JS fallback.
          model = createJSModel(msg.payload)
        }
        if (model.inputDim !== ENCODE_DIM && model.inputDim !== 473) {
          throw new Error(`Unsupported model dim ${model.inputDim} (expected ${ENCODE_DIM} or 473)`)
        }
        loadedModel = model
        self.postMessage({ id: msg.id, type: 'MODEL_LOADED', payload: { ok: true, inputDim: model.inputDim } } as WorkerResponse)
      } catch (e) {
        self.postMessage({
          id: msg.id,
          type: 'MODEL_LOADED',
          payload: { ok: false, error: e instanceof Error ? e.message : String(e) },
        } as WorkerResponse)
      }
    }
  } catch (err) {
    self.postMessage({
      id: msg.id,
      type: 'ERROR',
      payload: err instanceof Error ? err.message : String(err),
    } as WorkerResponse)
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => { void handleMessage(event) }
