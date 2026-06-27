import type { InfoState, ScoredPlacement } from '../engine/mc'
export type { ScoredPlacement }

export interface WorkerRequestGetEV {
  id: string
  type: 'GET_EV'
  payload: {
    state: InfoState
    totalRollouts: number
    batchSize?: number
    seed: number
  }
}

export interface WorkerRequestGetBotMove {
  id: string
  type: 'GET_BOT_MOVE'
  payload: {
    state: InfoState
    rollouts: number
    seed: number
  }
}

// Load NN weights into the worker. Payload is a binary ArrayBuffer in OFCW format.
export interface WorkerRequestLoadModel {
  id: string
  type: 'LOAD_MODEL'
  payload: ArrayBuffer
}

export interface WorkerRequestAnalyzePositions {
  id: string
  type: 'ANALYZE_POSITIONS'
  payload: { positions: Array<{ id: string; state: InfoState }> }
}

export type WorkerRequest =
  | WorkerRequestGetEV
  | WorkerRequestGetBotMove
  | WorkerRequestLoadModel
  | WorkerRequestAnalyzePositions

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
  payload: { ok: true } | { ok: false; error: string }
}

export interface WorkerResponseAnalysisDone {
  id: string
  type: 'ANALYSIS_DONE'
  payload: Array<{ id: string; candidates: ScoredPlacement[]; hasModel: boolean }>
}

export type WorkerResponse =
  | WorkerResponseProgress
  | WorkerResponseDone
  | WorkerResponseBotMove
  | WorkerResponseError
  | WorkerResponseModelLoaded
  | WorkerResponseAnalysisDone
