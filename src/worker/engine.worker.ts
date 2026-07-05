// Web Worker entry point — all engine compute runs here, never on the UI thread.
// The worker only imports from the engine boundary (src/engine/).

import { runMatchHand } from '../engine/matchSimulator'
import type { MatchHandRecord } from '../engine/matchTypes'
import { runMC, getBotMove, legalPlacements } from '../engine/mc'
import type { InfoState, ScoredPlacement } from '../engine/mc'
import type { WorkerRequest, WorkerResponse } from './types'
import type { NNModel } from '../engine/wasmModel'
import { createJSModel, createWasmModel } from '../engine/wasmModel'
import { nnRankCandidates } from '../engine/nnPolicy'
import { ENCODE_DIM } from '../engine/encode'
import { mctsPickPlacement, mctsScoredPlacements } from '../engine/mcts'
import type { MCTSOptions } from '../engine/mcts'
import {
  royaltyMctsScoredPlacements, royaltyMctsPickPlacement, ROYALTY_MCTS_SIMS,
  royaltyNnMctsScoredPlacements, royaltyNnMctsPickPlacement,
} from '../engine/royaltyMcts'
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
// Royalty NN model — null until LOAD_ROYALTY_MODEL completes.
let royaltyNnModel: NNModel | null = null

// nnOpponents is enabled because WASM makes opponent NN calls cheap enough to
// be net-faster than heuristic opponents even including the extra forward passes.
const COACH_MCTS_OPTS: MCTSOptions    = { nSims: 500, maxDepth: 2, nnOpponents: true }
const ANALYSIS_MCTS_OPTS: MCTSOptions = { nSims: 500, maxDepth: 2, nnOpponents: true }
const BOT_MCTS_OPTS: MCTSOptions      = { nSims: 500, maxDepth: 2, nnOpponents: true }

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
      const { state, totalRollouts, batchSize, seed, policy } = msg.payload
      const rng = makeRNG(seed)
      console.log(`[worker] GET_EV street=${state.street} policy=${policy} hasModel=${!!loadedModel}`)

      if (policy === 'royalty-nn' && royaltyNnModel) {
        // Royalty NN MCTS — uses learned royalty value function + domination filter.
        const results = royaltyNnMctsScoredPlacements(state, royaltyNnModel, ROYALTY_MCTS_SIMS, rng)
        self.postMessage({ id: msg.id, type: 'EV_PROGRESS', payload: results } as WorkerResponse)
        self.postMessage({ id: msg.id, type: 'EV_DONE',     payload: results } as WorkerResponse)
      } else if (policy === 'royalty' || policy === 'royalty-nn') {
        // Heuristic royalty MCTS (no NN loaded yet).
        const results = royaltyMctsScoredPlacements(state, ROYALTY_MCTS_SIMS, rng)
        self.postMessage({ id: msg.id, type: 'EV_PROGRESS', payload: results } as WorkerResponse)
        self.postMessage({ id: msg.id, type: 'EV_DONE',     payload: results } as WorkerResponse)
      } else if (policy === 'heuristic') {
        // Brute-force heuristic MC rollouts, chosen explicitly regardless of any loaded NN model.
        let lastResults: ScoredPlacement[] = []
        for (const results of runMC(state, { totalRollouts, batchSize }, rng)) {
          lastResults = results
          self.postMessage({ id: msg.id, type: 'EV_PROGRESS', payload: results } as WorkerResponse)
        }
        self.postMessage({ id: msg.id, type: 'EV_DONE', payload: lastResults } as WorkerResponse)
      } else if (loadedModel) {
        // Step 1: instant depth-1 NN pass so the UI has something to show immediately.
        const nnResults = evalCandidatesNN(loadedModel, state)
        console.log(`[worker] depth-1 NN done: ${nnResults.length} candidates`)
        self.postMessage({ id: msg.id, type: 'EV_PROGRESS', payload: nnResults } as WorkerResponse)

        // Step 2: MCTS refinement — depth-2 search averaged over sampled worlds.
        const mctsResults = mctsScoredPlacements(state, loadedModel, COACH_MCTS_OPTS, rng)
        console.log(`[worker] MCTS done: ${mctsResults.length} candidates`)
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
      const { state, rollouts, seed, policy } = msg.payload
      const placement = (policy === 'royalty-nn' && royaltyNnModel)
        ? royaltyNnMctsPickPlacement(state, royaltyNnModel, rollouts || ROYALTY_MCTS_SIMS, makeRNG(seed))
        : (policy === 'royalty' || policy === 'royalty-nn')
        ? royaltyMctsPickPlacement(state, rollouts || ROYALTY_MCTS_SIMS, makeRNG(seed))
        : policy === 'heuristic'
        ? getBotMove(state, rollouts, makeRNG(seed))
        : loadedModel
          ? mctsPickPlacement(state, loadedModel, { ...BOT_MCTS_OPTS, nSims: rollouts || BOT_MCTS_OPTS.nSims }, makeRNG(seed))
          : getBotMove(state, rollouts, makeRNG(seed))
      self.postMessage({ id: msg.id, type: 'BOT_MOVE', payload: placement } as WorkerResponse)

    } else if (msg.type === 'ANALYZE_POSITIONS') {
      const { positions, rollouts = 0, seed = 0, policy } = msg.payload
      const total = positions.length
      const opts: MCTSOptions = rollouts > 0
        ? { ...ANALYSIS_MCTS_OPTS, nSims: Math.max(rollouts, ANALYSIS_MCTS_OPTS.nSims) }
        : ANALYSIS_MCTS_OPTS
      const allResults: Array<{ id: string; candidates: ScoredPlacement[]; hasModel: boolean }> = []

      for (let i = 0; i < total; i++) {
        const { id, state } = positions[i]!
        const rng = makeRNG((seed + i * 1000003) >>> 0)

        try {
          let candidates: ScoredPlacement[]

          if (policy === 'royalty-nn' && royaltyNnModel) {
            candidates = royaltyNnMctsScoredPlacements(state, royaltyNnModel, ROYALTY_MCTS_SIMS, rng)
          } else if (policy === 'royalty' || policy === 'royalty-nn') {
            candidates = royaltyMctsScoredPlacements(state, ROYALTY_MCTS_SIMS, rng)
          } else if (policy === 'heuristic') {
            let lastResults: ScoredPlacement[] = []
            for (const results of runMC(state, { totalRollouts: rollouts > 0 ? rollouts : 200, batchSize: 10 }, rng)) {
              lastResults = results
            }
            candidates = [...lastResults].sort((a, b) => b.ev - a.ev)
          } else if (!loadedModel) {
            const item = { id, candidates: [], hasModel: false }
            allResults.push(item)
            self.postMessage({ id: msg.id, type: 'ANALYSIS_PROGRESS', payload: { done: i + 1, total, item } } as WorkerResponse)
            continue
          } else {
            candidates = mctsScoredPlacements(state, loadedModel, opts, rng)
          }

          const item = { id, candidates: candidates!, hasModel: true }
          allResults.push(item)
          self.postMessage({ id: msg.id, type: 'ANALYSIS_PROGRESS', payload: { done: i + 1, total, item } } as WorkerResponse)
        } catch (err) {
          // Skip bad positions rather than crashing the entire analysis run.
          console.error(`[worker] ANALYZE_POSITIONS: position ${id} failed`, err)
          const item = { id, candidates: [], hasModel: true }
          allResults.push(item)
          self.postMessage({ id: msg.id, type: 'ANALYSIS_PROGRESS', payload: { done: i + 1, total, item } } as WorkerResponse)
        }
      }

      self.postMessage({ id: msg.id, type: 'ANALYSIS_DONE', payload: allResults } as WorkerResponse)

    } else if (msg.type === 'RUN_MATCH') {
      const { totalHands, baseSeed, botA, botB } = msg.payload
      if ((botA.kind === 'nn-mcts' || botB.kind === 'nn-mcts') && !loadedModel) {
        self.postMessage({ id: msg.id, type: 'ERROR', payload: 'No NN model loaded' } as WorkerResponse)
        return
      }
      if ((botA.kind === 'royalty-nn' || botB.kind === 'royalty-nn') && !royaltyNnModel) {
        self.postMessage({ id: msg.id, type: 'ERROR', payload: 'No royalty NN model loaded' } as WorkerResponse)
        return
      }
      const models = { nn: loadedModel ?? undefined, royaltyNn: royaltyNnModel ?? undefined }
      const allHands: MatchHandRecord[] = []
      for (let i = 0; i < totalHands; i++) {
        const seed = ((baseSeed + i * 1_664_525 + 1_013_904_223) >>> 0)
        const hand = runMatchHand(i, seed, botA, botB, models)
        allHands.push(hand)
        // Send every hand so the UI counter increments smoothly.
        self.postMessage({
          id: msg.id,
          type: 'MATCH_PROGRESS',
          payload: { done: i + 1, total: totalHands, hands: [hand] },
        } as WorkerResponse)
      }
      self.postMessage({ id: msg.id, type: 'MATCH_DONE', payload: { hands: allHands } } as WorkerResponse)

    } else if (msg.type === 'LOAD_MODEL') {
      try {
        let model: NNModel
        try {
          model = createWasmModel(new MlpModel(new Uint8Array(msg.payload)))
        } catch {
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

    } else if (msg.type === 'LOAD_ROYALTY_MODEL') {
      try {
        let model: NNModel
        try {
          model = createWasmModel(new MlpModel(new Uint8Array(msg.payload)))
        } catch {
          model = createJSModel(msg.payload)
        }
        if (model.inputDim !== ENCODE_DIM) {
          throw new Error(`Royalty model dim ${model.inputDim} (expected ${ENCODE_DIM})`)
        }
        royaltyNnModel = model
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
    console.error('[worker] unhandled error in message handler:', err)
    self.postMessage({
      id: msg.id,
      type: 'ERROR',
      payload: err instanceof Error ? err.message : String(err),
    } as WorkerResponse)
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => { void handleMessage(event) }
