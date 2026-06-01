import type { InfoState, MCOptions, ScoredPlacement } from '../engine/mc'
import type { Placement } from '../engine/placement'
import type { WorkerRequest, WorkerResponse } from './types'

// Model served via Firebase Hosting (same origin as the app — no CORS, no billing needed).
// Training deploys the weights here via `firebase deploy --only hosting`.
const MODEL_URL = '/models/policy.bin'

let nextId = 0
function makeId(): string {
  nextId = (nextId + 1) | 0
  return `req-${nextId}-${Date.now().toString(36)}`
}

type Handler =
  | { kind: 'mc'; onProgress: (r: ScoredPlacement[]) => void; onDone: (r: ScoredPlacement[]) => void; onError: (e: string) => void }
  | { kind: 'bot'; resolve: (p: Placement) => void; reject: (e: string) => void }
  | { kind: 'model'; resolve: (ok: boolean) => void }

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
      case 'ERROR':
        if (handler.kind === 'bot') handler.reject(msg.payload)
        else if (handler.kind === 'model') handler.resolve(false)
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
      onError: () => { this.generations.delete(id) },
    })

    const req: WorkerRequest = {
      id,
      type: 'GET_EV',
      payload: { state, totalRollouts: opts.totalRollouts, batchSize: opts.batchSize, seed },
    }
    this.getWorker().postMessage(req)

    return () => {
      // Cancel: bump generation so callbacks for this id no longer fire,
      // but leave the worker to drain naturally (cheaper than restart).
      this.latestGeneration += 1
      this.generations.delete(id)
    }
  }

  getBotMove(state: InfoState, rollouts: number, seed: number): Promise<Placement> {
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
        payload: { state, rollouts, seed },
      }
      this.getWorker().postMessage(req)
    })
  }

  // Fetch model from Firebase Storage and load it into the worker.
  // Called once on app startup. Silently no-ops if the model file doesn't exist yet.
  async loadModel(): Promise<boolean> {
    try {
      const resp = await fetch(MODEL_URL)
      if (!resp.ok) return false
      const buf = await resp.arrayBuffer()
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
}

export const workerClient = new WorkerClient()
