import Fuse, { createHeadless, type Expression, type FuseResult, type IFuseOptions } from './index'
import type { FuseSearchOptions } from './options'
import { init } from './loader'

export interface FuseWorkerOptions {
  /** Override the worker script URL. Defaults to the package worker entry. */
  workerUrl?: string | URL
  /** Forwarded to {@link init} inside the worker when self-hosting the `.wasm`. */
  wasmUrl?: string
}

let warned = false

function warnFallback(): void {
  if (warned) return
  warned = true
  console.warn(
    'fuse-wasm: Web Workers are unavailable in this environment. FuseWorker is searching on the main thread.',
  )
}

function workerScriptUrl(override?: string | URL): URL | string {
  if (override) return typeof override === 'string' ? new URL(override, import.meta.url) : override
  if (import.meta.url.includes('/src/')) {
    // Static form so Vite treats this file as the module worker.
    return new URL('./worker.ts', import.meta.url)
  }
  return new URL('./worker.js', import.meta.url)
}

type Pending = {
  resolve: (value: { buf?: Uint8Array }) => void
  reject: (error: Error) => void
}

/**
 * Async Fuse. The index is built in a Web Worker when the platform has one,
 * and on the main thread otherwise. Documents stay on the caller side;
 * results are reattached by `refIndex`. A newer `search` drops the older one.
 */
export class FuseWorker<T> {
  private fuse: Fuse<T>
  private fallback: boolean
  private worker: Worker | null = null
  private readonly wasmUrl: string | undefined
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private chain: Promise<unknown> = Promise.resolve()
  private seq = 0
  private readonly ready: Promise<void>

  private constructor(docs: readonly T[], options: IFuseOptions<T> | undefined, workerOptions: FuseWorkerOptions) {
    this.wasmUrl = workerOptions.wasmUrl
    const WorkerCtor = typeof Worker === 'undefined' ? undefined : Worker
    this.fallback = !WorkerCtor
    if (this.fallback) {
      warnFallback()
      this.fuse = new Fuse(docs, options)
      this.ready = Promise.resolve()
      return
    }
    this.fuse = createHeadless(docs, options)
    const scriptUrl = workerOptions.workerUrl
      ? workerScriptUrl(workerOptions.workerUrl)
      : new URL('./worker.ts', import.meta.url)
    this.worker = new WorkerCtor!(scriptUrl, { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<{ id: number; error?: string; buf?: Uint8Array }>) => {
      const pending = this.pending.get(event.data.id)
      if (!pending) return
      this.pending.delete(event.data.id)
      if (event.data.error) pending.reject(new Error(event.data.error))
      else pending.resolve({ buf: event.data.buf })
    }
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'fuse-wasm worker failed')
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    }
    this.ready = this.mountRemote()
  }

  /** Index `docs` and resolve when the engine can accept searches. */
  static async create<T>(
    docs: readonly T[],
    options?: IFuseOptions<T>,
    workerOptions: FuseWorkerOptions = {},
  ): Promise<FuseWorker<T>> {
    await init(workerOptions.wasmUrl)
    const worker = new FuseWorker(docs, options, workerOptions)
    await worker.ready
    return worker
  }

  async search(query: string | Expression, searchOptions?: FuseSearchOptions): Promise<FuseResult<T>[] | null> {
    if (typeof query === 'string' && !query.trim()) {
      return this.fuse.emptyResults(searchOptions)
    }
    const seq = ++this.seq
    return this.enqueue(async () => {
      if (seq !== this.seq) return null
      if (this.fallback) return this.fuse.search(query, searchOptions)
      const defaultSort = this.fuse.usesDefaultSort()
      const limit = defaultSort ? (searchOptions?.limit ?? -1) : -1
      const payload = this.fuse.queryPayload(query)
      const response = await this.rpc(
        payload.kind === 'text'
          ? { type: 'search', kind: 'text', units: payload.units, limit, defaultSort }
          : { type: 'search', kind: 'logical', bytes: payload.bytes, limit, defaultSort },
      )
      if (seq !== this.seq || !response.buf) return null
      return this.fuse.resultsFromBuffer(response.buf, query, searchOptions)
    })
  }

  async add(doc: T): Promise<void> {
    await this.enqueue(async () => {
      this.fuse.add(doc)
      if (this.fallback) return
      await this.pushMutation()
    })
  }

  async remove(predicate: (doc: T, idx: number) => boolean = () => false): Promise<T[]> {
    return this.enqueue(async () => {
      const removed = this.fuse.remove(predicate)
      if (!this.fallback) await this.pushMutation()
      return removed
    })
  }

  async removeAt(idx: number): Promise<T> {
    return this.enqueue(async () => {
      const doc = this.fuse.removeAt(idx)
      if (!this.fallback) await this.pushMutation()
      return doc
    })
  }

  async setCollection(docs: readonly T[]): Promise<void> {
    await this.enqueue(async () => {
      this.fuse.setCollection(docs)
      if (!this.fallback) await this.mountRemote()
    })
  }

  /** Stop the worker and free the engine. */
  terminate(): void {
    this.seq += 1
    this.worker?.terminate()
    this.worker = null
    this.fuse.dispose()
    for (const pending of this.pending.values()) {
      pending.reject(new Error('fuse-wasm: worker terminated'))
    }
    this.pending.clear()
  }

  private enqueue<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async pushMutation(): Promise<void> {
    const mutation = this.fuse.lastMutation()
    if (mutation.type === 'reset') {
      await this.mountRemote()
      return
    }
    if (mutation.type === 'add') {
      const record = mutation.record.slice()
      await this.rpc({ type: 'add', record }, [record.buffer])
      return
    }
    if (mutation.type === 'remove') {
      await this.rpc({ type: 'remove', indices: mutation.indices })
    }
  }

  private mountRemote(): Promise<void> {
    const records = this.fuse.toEngineBuffer().slice()
    return this.rpc(
      { type: 'mount', wasmUrl: this.wasmUrl, args: this.fuse.engineArgs(), records },
      [records.buffer],
    ).then(() => undefined)
  }

  private rpc(body: Record<string, unknown>, transfer: Transferable[] = []): Promise<{ buf?: Uint8Array }> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker?.postMessage({ id, ...body }, transfer)
    })
  }
}
