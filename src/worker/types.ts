import type { InfoState, ScoredPlacement } from '../engine/mc'

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

export type WorkerRequest = WorkerRequestGetEV | WorkerRequestGetBotMove | WorkerRequestLoadModel

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

export type WorkerResponse =
  | WorkerResponseProgress
  | WorkerResponseDone
  | WorkerResponseBotMove
  | WorkerResponseError
  | WorkerResponseModelLoaded
