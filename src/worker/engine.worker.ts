// Web Worker entry point — all engine compute runs here, never on the UI thread.
// The worker only imports from the engine boundary (src/engine/).

import { runMC, getBotMove, legalPlacements } from '../engine/mc'
import type { InfoState, ScoredPlacement } from '../engine/mc'
import type { WorkerRequest, WorkerResponse } from './types'
import { parseMLPWeights } from '../engine/mlpInference'
import type { MLPWeights } from '../engine/mlpInference'
import { nnValue } from '../engine/nnPolicy'
import { applyPlacement } from '../engine/placement'
import { ENCODE_DIM } from '../engine/encode'
import { mctsPickPlacement, mctsScoredPlacements } from '../engine/mcts'
import type { MCTSOptions } from '../engine/mcts'

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

// Module-level weights reference.
let loadedWeights: MLPWeights | null = null

// MCTS config for the live coach (GET_EV). Fewer sims for responsiveness.
const COACH_MCTS_OPTS: MCTSOptions = { nSims: 100, maxDepth: 2, nnOpponents: false }
// MCTS config for session analysis — more sims since the user waits explicitly.
const ANALYSIS_MCTS_OPTS: MCTSOptions = { nSims: 200, maxDepth: 2, nnOpponents: false }
// MCTS config for bot moves.
const BOT_MCTS_OPTS: MCTSOptions = { nSims: 50, maxDepth: 2, nnOpponents: false }

// Depth-1 NN evaluation of all legal placements. Used as the instant baseline
// before MCTS results are ready (keeps the "best so far" UX snappy).
function evalCandidatesNN(weights: MLPWeights, state: InfoState): ScoredPlacement[] {
  const candidates = legalPlacements(state.board, state.hand, state.street)
  const priorDiscards = state.discards ?? []
  return candidates.map(placement => {
    const boardAfter = applyPlacement(state.board, placement)
    const allDiscards = placement.discard ? [...priorDiscards, placement.discard] : priorDiscards
    const ev = nnValue(weights, boardAfter, state.street, state.revealedOpponentBoards, allDiscards) * weights.outputScale
    return { placement, ev, variance: 0, n: 0 }
  }).sort((a, b) => b.ev - a.ev)
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  try {
    if (msg.type === 'GET_EV') {
      const { state, totalRollouts, batchSize, seed } = msg.payload
      const rng = makeRNG(seed)

      if (loadedWeights) {
        // Step 1: instant depth-1 NN pass so the UI has something to show immediately.
        const nnResults = evalCandidatesNN(loadedWeights, state)
        self.postMessage({ id: msg.id, type: 'EV_PROGRESS', payload: nnResults } as WorkerResponse)

        // Step 2: MCTS refinement — depth-2 search averaged over sampled worlds.
        const mctsResults = mctsScoredPlacements(state, loadedWeights, COACH_MCTS_OPTS, rng)
        self.postMessage({ id: msg.id, type: 'EV_PROGRESS', payload: mctsResults } as WorkerResponse)
        self.postMessage({ id: msg.id, type: 'EV_DONE',     payload: mctsResults } as WorkerResponse)
      } else {
        // No model loaded: fall back to MC with heuristic rollouts.
        let lastResults = null
        const fallbackRng = makeRNG(seed)
        for (const results of runMC(state, { totalRollouts, batchSize }, fallbackRng)) {
          lastResults = results
          self.postMessage({ id: msg.id, type: 'EV_PROGRESS', payload: results } as WorkerResponse)
        }
        self.postMessage({ id: msg.id, type: 'EV_DONE', payload: lastResults ?? [] } as WorkerResponse)
      }

    } else if (msg.type === 'GET_BOT_MOVE') {
      const { state, rollouts, seed } = msg.payload
      const placement = loadedWeights
        ? mctsPickPlacement(state, loadedWeights, BOT_MCTS_OPTS, makeRNG(seed))
        : getBotMove(state, rollouts, makeRNG(seed))
      self.postMessage({ id: msg.id, type: 'BOT_MOVE', payload: placement } as WorkerResponse)

    } else if (msg.type === 'ANALYZE_POSITIONS') {
      const { positions, rollouts = 0, seed = 0 } = msg.payload
      const total = positions.length
      // `rollouts` is kept in the message signature for back-compat but the
      // analysis now always uses MCTS when a model is loaded.
      const opts: MCTSOptions = rollouts > 0
        ? { ...ANALYSIS_MCTS_OPTS, nSims: Math.max(rollouts, ANALYSIS_MCTS_OPTS.nSims) }
        : ANALYSIS_MCTS_OPTS
      const allResults: Array<{ id: string; candidates: ScoredPlacement[]; hasModel: boolean }> = []

      for (let i = 0; i < total; i++) {
        const { id, state } = positions[i]!
        if (!loadedWeights) {
          const item = { id, candidates: [], hasModel: false }
          allResults.push(item)
          self.postMessage({ id: msg.id, type: 'ANALYSIS_PROGRESS', payload: { done: i + 1, total, item } } as WorkerResponse)
          continue
        }

        const rng = makeRNG((seed + i * 1000003) >>> 0)
        const candidates = mctsScoredPlacements(state, loadedWeights, opts, rng)
        const item = { id, candidates, hasModel: true }
        allResults.push(item)
        self.postMessage({ id: msg.id, type: 'ANALYSIS_PROGRESS', payload: { done: i + 1, total, item } } as WorkerResponse)
      }

      self.postMessage({ id: msg.id, type: 'ANALYSIS_DONE', payload: allResults } as WorkerResponse)

    } else if (msg.type === 'LOAD_MODEL') {
      try {
        const weights = parseMLPWeights(msg.payload)
        if (weights.inputDim !== ENCODE_DIM && weights.inputDim !== 473) {
          throw new Error(`Unsupported model dim ${weights.inputDim} (expected ${ENCODE_DIM} or 473)`)
        }
        loadedWeights = weights
        const resp: WorkerResponse = { id: msg.id, type: 'MODEL_LOADED', payload: { ok: true, inputDim: weights.inputDim } }
        self.postMessage(resp)
      } catch (e) {
        const resp: WorkerResponse = {
          id: msg.id,
          type: 'MODEL_LOADED',
          payload: { ok: false, error: e instanceof Error ? e.message : String(e) },
        }
        self.postMessage(resp)
      }
    }
  } catch (err) {
    const error: WorkerResponse = {
      id: msg.id,
      type: 'ERROR',
      payload: err instanceof Error ? err.message : String(err),
    }
    self.postMessage(error)
  }
}
