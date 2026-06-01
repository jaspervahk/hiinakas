// Web Worker entry point — all engine compute runs here, never on the UI thread.
// The worker only imports from the engine boundary (src/engine/).

import { runMC, getBotMove, setRolloutPolicy } from '../engine/mc'
import type { WorkerRequest, WorkerResponse } from './types'
import { parseMLPWeights } from '../engine/mlpInference'
import { nnPickPlacement } from '../engine/nnPolicy'

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

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  try {
    if (msg.type === 'GET_EV') {
      const { state, totalRollouts, batchSize, seed } = msg.payload
      const rng = makeRNG(seed)
      let lastResults = null
      for (const results of runMC(state, { totalRollouts, batchSize }, rng)) {
        lastResults = results
        const progress: WorkerResponse = { id: msg.id, type: 'EV_PROGRESS', payload: results }
        self.postMessage(progress)
      }
      const done: WorkerResponse = { id: msg.id, type: 'EV_DONE', payload: lastResults ?? [] }
      self.postMessage(done)

    } else if (msg.type === 'GET_BOT_MOVE') {
      const { state, rollouts, seed } = msg.payload
      const rng = makeRNG(seed)
      const placement = getBotMove(state, rollouts, rng)
      const resp: WorkerResponse = { id: msg.id, type: 'BOT_MOVE', payload: placement }
      self.postMessage(resp)

    } else if (msg.type === 'LOAD_MODEL') {
      try {
        const weights = parseMLPWeights(msg.payload)
        // Install the NN policy — future rollouts use NN instead of heuristic for actor moves.
        setRolloutPolicy((board, hand, street, oppBoards) =>
          nnPickPlacement(weights, board, hand, street, oppBoards)
        )
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
