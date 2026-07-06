import type { InfoState, MCOptions, ScoredPlacement } from '../engine/mc'
import type { Placement } from '../engine/placement'
import type { Card, Board } from '../engine/types'
import type { WorkerRequest, WorkerResponse, BotPolicy, MatchHandRecord, BotSpec, BonusAnalysisResult } from './types'
import type { BotKind } from '../engine/matchTypes'
export type { BotPolicy, MatchHandRecord, BotSpec, BotKind, BonusAnalysisResult }

// Available model variants served via Firebase Hosting.
export const MODEL_URLS = {
  v2: '/models/policy.bin',      // 525-dim, discard-aware (current CI output)
  v1: '/models/policy_473.bin',  // 473-dim, no discards (legacy, well-trained)
} as const
export type ModelVariant = keyof typeof MODEL_URLS

export const ROYALTY_MODEL_URL = '/models/royalty_nn.bin'

let nextId = 0
// Cached copy of model weights so we can reload after worker restart.
let cachedModelBuf: ArrayBuffer | null = null
// Cached royalty NN weights.
let cachedRoyaltyModelBuf: ArrayBuffer | null = null
function makeId(): string {
  nextId = (nextId + 1) | 0
  return `req-${nextId}-${Date.now().toString(36)}`
}

export type AnalysisResult = { id: string; candidates: ScoredPlacement[]; hasModel: boolean }

type Handler =
  | { kind: 'mc'; onProgress: (r: ScoredPlacement[]) => void; onDone: (r: ScoredPlacement[]) => void; onError: (e: string) => void }
  | { kind: 'bot'; resolve: (p: Placement) => void; reject: (e: string) => void }
  | { kind: 'model'; resolve: (ok: boolean) => void }
  | { kind: 'analysis'; resolve: (r: AnalysisResult[]) => void; onProgress?: (done: number, total: number, item: AnalysisResult) => void }
  | { kind: 'match'; resolve: (r: MatchHandRecord[]) => void; onProgress?: (done: number, total: number, batch: MatchHandRecord[]) => void; onError: () => void }
  | { kind: 'bonus'; resolve: (r: BonusAnalysisResult[]) => void; onProgress?: (done: number, total: number, item: BonusAnalysisResult) => void }

export class WorkerClient {
  private worker: Worker | null = null
  private handlers = new Map<string, Handler>()
  // Generation counter so stale streams from cancelled requests are ignored.
  private generations = new Map<string, number>()
  private latestGeneration = 0

  private getWorker(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data)
    w.onerror = () => {
      // Fail-safe: drop all pending handlers
      for (const [, h] of this.handlers) {
        if (h.kind === 'bot') h.reject('Worker error')
        else if (h.kind === 'model') h.resolve(false)
        else if (h.kind === 'analysis') h.resolve([])
        else if (h.kind === 'bonus') h.resolve([])
        else h.onError('Worker error')
      }
      this.handlers.clear()
    }
    this.worker = w
    return w
  }

  private handleMessage(msg: WorkerResponse): void {
    const handler = this.handlers.get(msg.id)
    if (!handler) return

    switch (msg.type) {
      case 'EV_PROGRESS':
        if (handler.kind === 'mc') handler.onProgress(msg.payload)
        return
      case 'EV_DONE':
        if (handler.kind === 'mc') handler.onDone(msg.payload)
        this.handlers.delete(msg.id)
        return
      case 'BOT_MOVE':
        if (handler.kind === 'bot') handler.resolve(msg.payload)
        this.handlers.delete(msg.id)
        return
      case 'MODEL_LOADED':
        if (handler.kind === 'model') handler.resolve(msg.payload.ok)
        this.handlers.delete(msg.id)
        return
      case 'ANALYSIS_PROGRESS':
        if (handler.kind === 'analysis') handler.onProgress?.(msg.payload.done, msg.payload.total, msg.payload.item)
        return
      case 'ANALYSIS_DONE':
        if (handler.kind === 'analysis') handler.resolve(msg.payload)
        this.handlers.delete(msg.id)
        return
      case 'MATCH_PROGRESS':
        if (handler.kind === 'match') handler.onProgress?.(msg.payload.done, msg.payload.total, msg.payload.hands)
        return
      case 'MATCH_DONE':
        if (handler.kind === 'match') handler.resolve(msg.payload.hands)
        this.handlers.delete(msg.id)
        return
      case 'BONUS_PROGRESS':
        if (handler.kind === 'bonus') handler.onProgress?.(msg.payload.done, msg.payload.total, msg.payload.item)
        return
      case 'BONUS_DONE':
        if (handler.kind === 'bonus') handler.resolve(msg.payload)
        this.handlers.delete(msg.id)
        return
      case 'ERROR':
        if (handler.kind === 'bot') handler.reject(msg.payload)
        else if (handler.kind === 'model') handler.resolve(false)
        else if (handler.kind === 'analysis') handler.resolve([])
        else if (handler.kind === 'bonus') handler.resolve([])
        else if (handler.kind === 'match') { handler.onError(); handler.resolve([]) }
        else handler.onError(msg.payload)
        this.handlers.delete(msg.id)
        return
    }
  }

  streamMC(
    state: InfoState,
    opts: MCOptions,
    seed: number,
    onProgress: (r: ScoredPlacement[]) => void,
    onDone: (r: ScoredPlacement[]) => void,
    policy?: BotPolicy,
    onError?: () => void,
    rootTopK?: number,
  ): () => void {
    const id = makeId()
    this.latestGeneration += 1
    const gen = this.latestGeneration
    this.generations.set(id, gen)

    const wrap = <T>(fn: (x: T) => void) => (x: T) => {
      // Ignore stale: only the latest generation's callbacks fire.
      if (this.generations.get(id) === gen && gen === this.latestGeneration) fn(x)
    }

    this.handlers.set(id, {
      kind: 'mc',
      onProgress: wrap(onProgress),
      onDone: (r) => {
        if (this.generations.get(id) === gen && gen === this.latestGeneration) onDone(r)
        this.generations.delete(id)
      },
      onError: () => {
        if (this.generations.get(id) === gen && gen === this.latestGeneration) onError?.()
        this.generations.delete(id)
      },
    })

    const req: WorkerRequest = {
      id,
      type: 'GET_EV',
      payload: { state, totalRollouts: opts.totalRollouts, batchSize: opts.batchSize, seed, policy, rootTopK },
    }
    this.getWorker().postMessage(req)

    return () => {
      // Cancel: bump generation so callbacks for this id no longer fire,
      // but leave the worker to drain naturally (cheaper than restart).
      this.latestGeneration += 1
      this.generations.delete(id)
    }
  }

  getBotMove(state: InfoState, rollouts: number, seed: number, policy?: BotPolicy, rootTopK?: number): Promise<Placement> {
    const id = makeId()
    return new Promise<Placement>((resolve, reject) => {
      this.handlers.set(id, {
        kind: 'bot',
        resolve,
        reject: (msg) => reject(new Error(msg)),
      })
      const req: WorkerRequest = {
        id,
        type: 'GET_BOT_MOVE',
        payload: { state, rollouts, seed, policy, rootTopK },
      }
      this.getWorker().postMessage(req)
    })
  }

  analyzePositions(
    positions: Array<{ id: string; state: InfoState }>,
    rollouts = 0,
    onProgress?: (done: number, total: number, item: AnalysisResult) => void,
    policy?: BotPolicy,
    rootTopK?: number,
  ): Promise<AnalysisResult[]> {
    const id = makeId()
    const seed = (Date.now() * 1000003) >>> 0
    return new Promise((resolve) => {
      this.handlers.set(id, { kind: 'analysis', resolve, onProgress })
      const req: WorkerRequest = { id, type: 'ANALYZE_POSITIONS', payload: { positions, rollouts, seed, policy, rootTopK } }
      this.getWorker().postMessage(req)
    })
  }

  analyzeBonusPositions(
    positions: Array<{ id: string; cards: Card[]; numDiscard: number; actualBoard: Board }>,
    onProgress?: (done: number, total: number, item: BonusAnalysisResult) => void,
  ): Promise<BonusAnalysisResult[]> {
    const id = makeId()
    return new Promise((resolve) => {
      this.handlers.set(id, { kind: 'bonus', resolve, onProgress })
      const req: WorkerRequest = { id, type: 'ANALYZE_BONUS', payload: { positions } }
      this.getWorker().postMessage(req)
    })
  }

  // Load the model from the module-level cache into this worker's instance.
  // Used to initialise botWorkerClient after workerClient.loadModel() has cached the buffer.
  loadFromCache(): boolean {
    if (!cachedModelBuf) return false
    const copy = cachedModelBuf.slice(0)
    const id = makeId()
    this.handlers.set(id, { kind: 'model', resolve: () => {} })
    const req: WorkerRequest = { id, type: 'LOAD_MODEL', payload: copy }
    this.getWorker().postMessage(req, [copy])
    return true
  }

  // Terminate the worker and start fresh. Model is reloaded from cache automatically.
  restartWorker(): void {
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    for (const [, h] of this.handlers) {
      if (h.kind === 'bot') h.reject('Worker restarted')
    }
    this.handlers.clear()
    this.generations.clear()
    this.latestGeneration = 0

    if (cachedModelBuf) {
      const copy = cachedModelBuf.slice(0)
      const id = makeId()
      this.handlers.set(id, { kind: 'model', resolve: () => {} })
      const req: WorkerRequest = { id, type: 'LOAD_MODEL', payload: copy }
      this.getWorker().postMessage(req, [copy])
    }
  }

  runMatch(
    totalHands: number,
    seed: number,
    botA: BotSpec,
    botB: BotSpec,
    onProgress?: (done: number, total: number, batch: MatchHandRecord[]) => void,
  ): { promise: Promise<MatchHandRecord[]>; cancel: () => void } {
    const id = makeId()
    let cancelled = false
    const promise = new Promise<MatchHandRecord[]>((resolve) => {
      this.handlers.set(id, {
        kind: 'match',
        resolve: (r) => { if (!cancelled) { resolve(r) } else { resolve([]) } },
        onProgress: onProgress ? (done, total, batch) => { if (!cancelled) { onProgress(done, total, batch) } } : undefined,
        onError: () => { cancelled = true; resolve([]) },
      })
      const req: WorkerRequest = {
        id,
        type: 'RUN_MATCH',
        payload: { totalHands, baseSeed: seed, botA, botB },
      }
      this.getWorker().postMessage(req)
    })
    return {
      promise,
      cancel: () => {
        cancelled = true
        // Terminate and restart so the long-running loop stops.
        this.restartWorker()
      },
    }
  }

  // Fetch a model from Firebase Hosting and load it into the worker.
  // url defaults to the current v2 model. Returns false if the file is missing
  // or the worker rejects the weights (dim mismatch with unsupported architecture).
  async loadModel(url: string = MODEL_URLS.v2): Promise<boolean> {
    try {
      const resp = await fetch(url)
      if (!resp.ok) return false
      const buf = await resp.arrayBuffer()
      cachedModelBuf = buf.slice(0)
      const id = makeId()
      return new Promise<boolean>((resolve) => {
        this.handlers.set(id, { kind: 'model', resolve })
        const req: WorkerRequest = { id, type: 'LOAD_MODEL', payload: buf }
        this.getWorker().postMessage(req, [buf])
      })
    } catch {
      return false
    }
  }

  // Fetch the royalty NN model and load it into this worker.
  async loadRoyaltyModel(url: string = ROYALTY_MODEL_URL): Promise<boolean> {
    try {
      const resp = await fetch(url)
      if (!resp.ok) return false
      const buf = await resp.arrayBuffer()
      cachedRoyaltyModelBuf = buf.slice(0)
      const id = makeId()
      return new Promise<boolean>((resolve) => {
        this.handlers.set(id, { kind: 'model', resolve })
        const req: WorkerRequest = { id, type: 'LOAD_ROYALTY_MODEL', payload: buf }
        this.getWorker().postMessage(req, [buf])
      })
    } catch {
      return false
    }
  }

  // Load royalty model from the module-level cache (after another worker fetched it).
  loadRoyaltyFromCache(): boolean {
    if (!cachedRoyaltyModelBuf) return false
    const copy = cachedRoyaltyModelBuf.slice(0)
    const id = makeId()
    this.handlers.set(id, { kind: 'model', resolve: () => {} })
    const req: WorkerRequest = { id, type: 'LOAD_ROYALTY_MODEL', payload: copy }
    this.getWorker().postMessage(req, [copy])
    return true
  }
}

export const workerClient = new WorkerClient()        // NN EV coach
export const botWorkerClient = new WorkerClient()     // bot moves — never shared with coach
export const royaltyWorkerClient = new WorkerClient() // royalty coach — separate worker, no model needed
export const arenaWorkerClient = new WorkerClient()   // arena match runner — dedicated worker
