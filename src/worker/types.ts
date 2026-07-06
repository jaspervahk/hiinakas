import type { InfoState, ScoredPlacement } from '../engine/mc'
import type { MatchHandRecord, BotSpec } from '../engine/matchTypes'
import type { Card, Board } from '../engine/types'
export type { ScoredPlacement, MatchHandRecord, BotSpec }

export type BotPolicy = 'nn' | 'royalty' | 'royalty-nn' | 'heuristic'

export interface WorkerRequestGetEV {
  id: string
  type: 'GET_EV'
  payload: {
    state: InfoState
    totalRollouts: number
    batchSize?: number
    seed: number
    policy?: BotPolicy
    rootTopK?: number
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
    rootTopK?: number
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
  payload: { positions: Array<{ id: string; state: InfoState }>; rollouts?: number; seed?: number; policy?: BotPolicy; rootTopK?: number }
}

export interface WorkerRequestRunMatch {
  id: string
  type: 'RUN_MATCH'
  payload: {
    totalHands: number
    baseSeed: number
    botA: BotSpec
    botB: BotSpec
  }
}

// One-shot bonus-round board analysis — no streets, no opponents, solved via
// exhaustive search (bestBonusBoard), so it's a separate request type from
// ANALYZE_POSITIONS's street-based InfoState candidates.
export interface WorkerRequestAnalyzeBonus {
  id: string
  type: 'ANALYZE_BONUS'
  payload: { positions: Array<{ id: string; cards: Card[]; numDiscard: number; actualBoard: Board }> }
}

export type WorkerRequest =
  | WorkerRequestGetEV
  | WorkerRequestGetBotMove
  | WorkerRequestLoadModel
  | WorkerRequestLoadRoyaltyModel
  | WorkerRequestAnalyzePositions
  | WorkerRequestRunMatch
  | WorkerRequestAnalyzeBonus

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

export interface BonusAnalysisResult {
  id: string
  bestBoard: Board
  bestRoyalties: number
  actualRoyalties: number
  actualFoul: boolean
  evLost: number
}

export interface WorkerResponseBonusProgress {
  id: string
  type: 'BONUS_PROGRESS'
  payload: { done: number; total: number; item: BonusAnalysisResult }
}

export interface WorkerResponseBonusDone {
  id: string
  type: 'BONUS_DONE'
  payload: BonusAnalysisResult[]
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
  | WorkerResponseBonusProgress
  | WorkerResponseBonusDone
