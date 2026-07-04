import type { InfoState, ScoredPlacement } from '../engine/mc'
import type { MatchHandRecord } from '../engine/matchTypes'
export type { ScoredPlacement, MatchHandRecord }

export type BotPolicy = 'nn' | 'royalty' | 'royalty-nn'

export interface WorkerRequestGetEV {
  id: string
  type: 'GET_EV'
  payload: {
    state: InfoState
    totalRollouts: number
    batchSize?: number
    seed: number
    policy?: BotPolicy
  }
}

export interface WorkerRequestGetBotMove {
  id: string
  type: 'GET_BOT_MOVE'
  payload: {
    state: InfoState
    rollouts: number
    seed: number
    policy?: BotPolicy
  }
}

// Load NN weights into the worker. Payload is a binary ArrayBuffer in OFCW format.
export interface WorkerRequestLoadModel {
  id: string
  type: 'LOAD_MODEL'
  payload: ArrayBuffer
}

// Load royalty NN weights (separate model trained on royalty labels).
export interface WorkerRequestLoadRoyaltyModel {
  id: string
  type: 'LOAD_ROYALTY_MODEL'
  payload: ArrayBuffer
}

export interface WorkerRequestAnalyzePositions {
  id: string
  type: 'ANALYZE_POSITIONS'
  // rollouts > 0 → NN + MC hybrid (same as live coach); 0 → NN-only (fast, legacy)
  payload: { positions: Array<{ id: string; state: InfoState }>; rollouts?: number; seed?: number; policy?: BotPolicy }
}

export interface WorkerRequestRunMatch {
  id: string
  type: 'RUN_MATCH'
  payload: {
    totalHands: number
    baseSeed: number
    nnSims: number
    royaltySims: number
    rootTopK?: number
    royaltyPolicy?: 'mcts' | 'nn'  // 'nn' uses royalty NN model if loaded, else falls back to MCTS
  }
}

export type WorkerRequest =
  | WorkerRequestGetEV
  | WorkerRequestGetBotMove
  | WorkerRequestLoadModel
  | WorkerRequestLoadRoyaltyModel
  | WorkerRequestAnalyzePositions
  | WorkerRequestRunMatch

export interface WorkerResponseProgress {
  id: string
  type: 'EV_PROGRESS'
  payload: ScoredPlacement[]
}

export interface WorkerResponseDone {
  id: string
  type: 'EV_DONE'
  payload: ScoredPlacement[]
}

export interface WorkerResponseBotMove {
  id: string
  type: 'BOT_MOVE'
  payload: import('../engine/placement').Placement
}

export interface WorkerResponseError {
  id: string
  type: 'ERROR'
  payload: string
}

export interface WorkerResponseModelLoaded {
  id: string
  type: 'MODEL_LOADED'
  payload: { ok: true; inputDim?: number } | { ok: false; error: string }
}

export interface WorkerResponseAnalysisDone {
  id: string
  type: 'ANALYSIS_DONE'
  payload: Array<{ id: string; candidates: ScoredPlacement[]; hasModel: boolean }>
}

// Streamed one-at-a-time during thorough (NN+MC) analysis.
export interface WorkerResponseAnalysisProgress {
  id: string
  type: 'ANALYSIS_PROGRESS'
  payload: { done: number; total: number; item: { id: string; candidates: ScoredPlacement[]; hasModel: boolean } }
}

export interface WorkerResponseMatchProgress {
  id: string
  type: 'MATCH_PROGRESS'
  payload: { done: number; total: number; hands: MatchHandRecord[] }
}

export interface WorkerResponseMatchDone {
  id: string
  type: 'MATCH_DONE'
  payload: { hands: MatchHandRecord[] }
}

export type WorkerResponse =
  | WorkerResponseProgress
  | WorkerResponseDone
  | WorkerResponseBotMove
  | WorkerResponseError
  | WorkerResponseModelLoaded
  | WorkerResponseAnalysisDone
  | WorkerResponseAnalysisProgress
  | WorkerResponseMatchProgress
  | WorkerResponseMatchDone
