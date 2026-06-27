// Web Worker entry point — all engine compute runs here, never on the UI thread.
// The worker only imports from the engine boundary (src/engine/).

import { runMC, getBotMove, legalPlacements } from '../engine/mc'
import type { InfoState, ScoredPlacement } from '../engine/mc'
import type { WorkerRequest, WorkerResponse } from './types'
import { parseMLPWeights } from '../engine/mlpInference'
import type { MLPWeights } from '../engine/mlpInference'
import { nnPickPlacement, nnValue } from '../engine/nnPolicy'
import { applyPlacement } from '../engine/placement'
import { ENCODE_DIM } from '../engine/encode'

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

// Evaluate all legal placements instantly using V(next_state).
// One forward pass per candidate — no MC rollouts, no combinatorial blowup.
// Returns results pre-sorted best-first so the UI can display immediately.
function evalCandidatesNN(weights: MLPWeights, state: InfoState, totalRollouts: number): ScoredPlacement[] {
  const candidates = legalPlacements(state.board, state.hand, state.street)
  const priorDiscards = state.discards ?? []
  return candidates.map(placement => {
    const boardAfter = applyPlacement(state.board, placement)
    const allDiscards = placement.discard ? [...priorDiscards, placement.discard] : priorDiscards
    const ev = nnValue(weights, boardAfter, state.street, state.revealedOpponentBoards, allDiscards) * weights.outputScale
    return { placement, ev, variance: 0, n: totalRollouts }
  })
}

// Number of top candidates (by NN ranking) to refine with MC rollouts.
const MC_REFINE_TOP_K = 15

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  try {
    if (msg.type === 'GET_EV') {
      const { state, totalRollouts, batchSize, seed } = msg.payload

      if (loadedWeights) {
        // Step 1: instant NN pass — emit all candidates immediately with n=0.
        const nnResults = evalCandidatesNN(loadedWeights, state, 0)
        self.postMessage({ id: msg.id, type: 'EV_PROGRESS', payload: nnResults } as WorkerResponse)

        // Step 2: refine the top K candidates with MC rollouts.
        // Pruning from ~232 to 15 makes each MC batch ~15× faster.
        const topK = Math.min(MC_REFINE_TOP_K, nnResults.length)
        const topCandidates = [...nnResults]
          .sort((a, b) => b.ev - a.ev)
          .slice(0, topK)
          .map(r => r.placement)

        const rng = makeRNG(seed)
        let lastResults: typeof nnResults = nnResults

        for (const mcResults of runMC(state, { totalRollouts, batchSize }, rng, topCandidates)) {
          // Merge: MC-refined estimates for top K, NN estimates for the rest.
          // Placement objects are the same references as in nnResults, so Map lookup is exact.
          const refined = new Map(mcResults.map(r => [r.placement, r]))
          const merged = nnResults.map(nr => refined.get(nr.placement) ?? nr)
          lastResults = merged
          self.postMessage({ id: msg.id, type: 'EV_PROGRESS', payload: merged } as WorkerResponse)
        }

        self.postMessage({ id: msg.id, type: 'EV_DONE', payload: lastResults } as WorkerResponse)
      } else {
        // No NN: fall back to MC with heuristic rollouts across all candidates.
        const rng = makeRNG(seed)
        let lastResults = null
        for (const results of runMC(state, { totalRollouts, batchSize }, rng)) {
          lastResults = results
          const progress: WorkerResponse = { id: msg.id, type: 'EV_PROGRESS', payload: results }
          self.postMessage(progress)
        }
        const done: WorkerResponse = { id: msg.id, type: 'EV_DONE', payload: lastResults ?? [] }
        self.postMessage(done)
      }

    } else if (msg.type === 'GET_BOT_MOVE') {
      const { state, rollouts, seed } = msg.payload
      // NN loaded: use V(next_state) directly — one forward pass per candidate, instant.
      // Falls back to MC with heuristic when no model is loaded.
      const placement = loadedWeights
        ? nnPickPlacement(loadedWeights, state.board, state.hand, state.street, state.revealedOpponentBoards, state.discards)
        : getBotMove(state, rollouts, makeRNG(seed))
      const resp: WorkerResponse = { id: msg.id, type: 'BOT_MOVE', payload: placement }
      self.postMessage(resp)

    } else if (msg.type === 'ANALYZE_POSITIONS') {
      // NN-only bulk evaluation — one evalCandidatesNN call per position, no MC.
      // Fast enough for full-session analysis (<1 s for 300 positions with model loaded).
      const results = msg.payload.positions.map(({ id, state }) => {
        if (!loadedWeights) return { id, candidates: [], hasModel: false }
        const sorted = evalCandidatesNN(loadedWeights, state, 0).sort((a, b) => b.ev - a.ev)
        return { id, candidates: sorted, hasModel: true }
      })
      self.postMessage({ id: msg.id, type: 'ANALYSIS_DONE', payload: results } as WorkerResponse)

    } else if (msg.type === 'LOAD_MODEL') {
      try {
        const weights = parseMLPWeights(msg.payload)
        if (weights.inputDim !== ENCODE_DIM) {
          throw new Error(`Model input dim ${weights.inputDim} ≠ expected ${ENCODE_DIM} — needs retraining`)
        }
        loadedWeights = weights
        // Rollouts intentionally keep using heuristic — NN forward passes inside rollouts
        // are ~100x slower. The NN is only used for direct V(next_state) evaluation above.
        const resp: WorkerResponse = { id: msg.id, type: 'MODEL_LOADED', payload: { ok: true } }
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
