import { decodeHits, type RawHit, type RawMatch } from './decode'
import { encodeCollection, encodeRecord } from './encode'
import { createIndex, FuseIndex, isStringRecord, parseIndex, type IndexRecord } from './fuse-index'
import { KeyStore, type FuseOptionKey, type KeyObject } from './keys'
import { engineModule, init, NOT_READY, simdEnabled, wasmReady, whenReady } from './loader'
import { encodeLogical, parseLogical, type Expression } from './logical'
import {
  assertSupportedOptions,
  Config,
  type FuseSearchOptions,
  type FuseSortArg,
  type IFuseOptions,
} from './options'
import { normalizeText, utf16, type NormOptions } from './text'

export { init, simdEnabled, wasmReady }
export { Config as config }
export { createIndex, parseIndex, FuseIndex }
export type { Expression, FuseOptionKey, FuseSearchOptions, IFuseOptions, IndexRecord, KeyObject }

export interface FuseResultMatch {
  indices: ReadonlyArray<readonly [number, number]>
  key?: string
  refIndex?: number
  value?: string
}

export interface FuseResult<T> {
  item: T
  refIndex: number
  score?: number
  matches?: FuseResultMatch[]
}

/** @internal Worker sync after a mutation. */
export type IndexMutation =
  | { type: 'none' }
  | { type: 'reset' }
  | { type: 'add'; record: Uint8Array }
  | { type: 'remove'; indices: Uint32Array }

type Engine = InstanceType<typeof import('../pkg/fuse_engine.js').FuseEngine>

const VERSION = '0.1.0'

let constructingHeadless = false

/**
 * Build a Fuse that keeps the JS index but does not allocate a WASM engine.
 * The worker (or a test) feeds result buffers back through {@link Fuse.resultsFromBuffer}.
 * @internal
 */
export function createHeadless<T>(
  docs: readonly T[],
  options?: IFuseOptions<T>,
  index?: FuseIndex<T>,
): Fuse<T> {
  constructingHeadless = true
  try {
    return new Fuse(docs, options, index)
  } finally {
    constructingHeadless = false
  }
}

/**
 * Fuse.js-compatible fuzzy search. The collection stays in JavaScript; the
 * Bitap index lives in WebAssembly. Call {@link init} once before `search`.
 */
export default class Fuse<T> {
  static version = VERSION
  static createIndex = createIndex
  static parseIndex = parseIndex
  static config = Config

  options: Required<IFuseOptions<T>>
  private _docs: T[]
  private _index: FuseIndex<T>
  private _keyStore: KeyStore<T>
  private _engine: Engine | null = null
  private _stringList = false
  private _weights: number[] = []
  private _headless: boolean
  private _disposed = false
  private _mutation: IndexMutation = { type: 'none' }
  /** Bumps on every full engine (or headless meta) rebuild. */
  revision = 0

  constructor(docs: readonly T[], options?: IFuseOptions<T>, index?: FuseIndex<T>) {
    assertSupportedOptions(options)
    this._headless = constructingHeadless
    this.options = { ...Config, ...options } as Required<IFuseOptions<T>>
    if (!this.options.keys) this.options.keys = []
    this._keyStore = new KeyStore(this.options.keys)
    this._docs = docs as T[]
    if (index && !(index instanceof FuseIndex)) {
      throw new Error("Incorrect 'index' type")
    }
    this._index =
      index ??
      createIndex(this.options.keys, this._docs, {
        getFn: this.options.getFn,
        fieldNormWeight: this.options.fieldNormWeight,
      })
    if (this._headless) {
      this.prepareMeta()
    } else {
      whenReady(() => {
        if (!this._disposed) this.mount()
      })
    }
  }

  /** Free the WASM index. Further searches throw until a new instance is created. */
  dispose(): void {
    this._disposed = true
    this._engine?.free()
    this._engine = null
  }

  getIndex(): FuseIndex<T> {
    return this._index
  }

  setCollection(docs: readonly T[], index?: FuseIndex<T>): void {
    if (index && !(index instanceof FuseIndex)) {
      throw new Error("Incorrect 'index' type")
    }
    this._docs = docs as T[]
    this._index =
      index ??
      createIndex(this.options.keys, this._docs, {
        getFn: this.options.getFn,
        fieldNormWeight: this.options.fieldNormWeight,
      })
    this.mount()
    this._mutation = { type: 'reset' }
  }

  add(doc: T): void {
    if (doc === undefined || doc === null) return
    this._docs.push(doc)
    const record = this._index.add(doc, this._docs.length - 1)
    const stringList = typeof this._docs[0] === 'string'
    if (stringList !== this._stringList) {
      this.mount()
      this._mutation = { type: 'reset' }
      return
    }
    if (!record) {
      this._mutation = { type: 'none' }
      return
    }
    const bytes = encodeRecord(record, stringList, this._weights.length, this.normOptions())
    this._engine?.add_record(bytes)
    this._mutation = { type: 'add', record: bytes }
  }

  remove(predicate: (doc: T, idx: number) => boolean = () => false): T[] {
    const removed: T[] = []
    const indices: number[] = []
    for (let i = 0; i < this._docs.length; i += 1) {
      if (predicate(this._docs[i]!, i)) {
        removed.push(this._docs[i]!)
        indices.push(i)
      }
    }
    if (indices.length) {
      const drop = new Set(indices)
      this._docs = this._docs.filter((_, i) => !drop.has(i))
      this._index.removeAll(indices)
      const packed = Uint32Array.from(indices)
      this._engine?.remove_indices(packed)
      this._mutation = { type: 'remove', indices: packed }
    } else {
      this._mutation = { type: 'none' }
    }
    return removed
  }

  removeAt(idx: number): T {
    if (!Number.isInteger(idx) || idx < 0 || idx >= this._docs.length) {
      throw new Error('Invalid doc index: must be a non-negative integer within the bounds of the docs array')
    }
    const [doc] = this._docs.splice(idx, 1)
    this._index.removeAt(idx)
    const packed = Uint32Array.from([idx])
    this._engine?.remove_indices(packed)
    this._mutation = { type: 'remove', indices: packed }
    return doc as T
  }

  /**
   * Search with a string or a logical expression (`$and`, `$or`, `$path`).
   * Throws if {@link init} has not resolved.
   */
  search(query: string | Expression, searchOptions?: FuseSearchOptions): FuseResult<T>[] {
    if (typeof query === 'string' && !query.trim()) {
      return this.emptyResults(searchOptions)
    }
    if (!this._engine) throw new Error(NOT_READY)
    const limit = searchOptions?.limit ?? -1
    const defaultSort = this.usesDefaultSort()
    const engineLimit = defaultSort ? limit : -1
    const buf =
      typeof query === 'string'
        ? this._engine.search(utf16(normalizeText(query, this.normOptions())), engineLimit, defaultSort)
        : this._engine.search_logical(this.logicalBytes(query), engineLimit, defaultSort)
    return this.resultsFromBuffer(buf, query, searchOptions)
  }

  /** @internal */
  usesDefaultSort(): boolean {
    return this.options.sortFn === Config.sortFn
  }

  /** @internal */
  isStringList(): boolean {
    return this._stringList
  }

  /** @internal Snapshot of the last add/remove/setCollection, for the worker. */
  lastMutation(): IndexMutation {
    return this._mutation
  }

  /** @internal Full record blob. */
  toEngineBuffer(): Uint8Array {
    return encodeCollection(this._index, this._stringList, this._weights, this.normOptions())
  }

  /** @internal Normalized query payload for a remote engine. */
  queryPayload(query: string | Expression): { kind: 'text'; units: Uint16Array } | { kind: 'logical'; bytes: Uint8Array } {
    if (typeof query === 'string') {
      return { kind: 'text', units: utf16(normalizeText(query, this.normOptions())) }
    }
    return { kind: 'logical', bytes: this.logicalBytes(query) }
  }

  /** @internal Constructor arguments for a remote engine, in WASM order. */
  engineArgs(): [
    number,
    number,
    number,
    boolean,
    boolean,
    number,
    boolean,
    boolean,
    boolean,
    boolean,
  ] {
    const opts = this.options
    const includeMatches = opts.includeMatches || !this.usesDefaultSort()
    return [
      opts.threshold,
      opts.distance,
      opts.location,
      includeMatches,
      opts.findAllMatches,
      opts.minMatchCharLength,
      opts.ignoreLocation,
      opts.ignoreFieldNorm,
      opts.useExtendedSearch,
      opts.shouldSort,
    ]
  }

  /** @internal Decode a worker (or local) result buffer into Fuse results. */
  resultsFromBuffer(
    buf: Uint8Array,
    query: string | Expression,
    searchOptions?: FuseSearchOptions,
  ): FuseResult<T>[] {
    const limit = searchOptions?.limit ?? -1
    const defaultSort = this.usesDefaultSort()
    const hits = decodeHits(buf, !defaultSort, true)
    if (!defaultSort) {
      let ranked = hits.map((hit) => ({ hit, arg: this.toSortArg(hit) }))
      if (this.options.shouldSort) {
        const tieBreak = typeof query === 'string'
        ranked.sort((a, b) => this.options.sortFn(a.arg, b.arg) || (tieBreak ? a.arg.idx - b.arg.idx : 0))
      }
      if (limit > -1) ranked = ranked.slice(0, limit)
      return ranked.map(({ hit }) => this.format(hit))
    }
    return hits.map((hit) => this.format(hit))
  }

  /** @internal Docs returned for a blank query, with no scores. */
  emptyResults(searchOptions?: FuseSearchOptions): FuseResult<T>[] {
    const limit = searchOptions?.limit ?? -1
    const docs = this._docs.map((item, refIndex) => ({ item, refIndex }))
    return limit > -1 ? docs.slice(0, limit) : docs
  }

  private normOptions(): NormOptions {
    return {
      isCaseSensitive: this.options.isCaseSensitive,
      ignoreDiacritics: this.options.ignoreDiacritics,
    }
  }

  private prepareMeta(): void {
    this._stringList = typeof this._docs[0] === 'string'
    this._weights = this._index.keys.map((key) => this._keyStore.get(key.id)?.weight ?? key.weight)
    this.revision += 1
  }

  private mount(): void {
    this.prepareMeta()
    if (this._headless || this._disposed) return
    const { FuseEngine } = engineModule()
    this._engine?.free()
    const args = this.engineArgs()
    this._engine = new FuseEngine(...args)
    this._engine.set_records(this.toEngineBuffer())
  }

  private logicalBytes(query: Expression): Uint8Array {
    return encodeLogical(
      parseLogical(query),
      (pattern) => normalizeText(pattern, this.normOptions()),
      (id) => {
        const pos = this._index.keys.findIndex((key) => key.id === id)
        return pos === -1 ? -2 : pos
      },
    )
  }

  private format(hit: RawHit): FuseResult<T> {
    const result: FuseResult<T> = {
      item: this._docs[hit.refIndex] as T,
      refIndex: hit.refIndex,
    }
    if (this.options.includeScore) result.score = hit.score
    if (this.options.includeMatches) result.matches = this.publicMatches(hit.refIndex, hit.matches)
    return result
  }

  private publicMatches(refIndex: number, matches: readonly RawMatch[]): FuseResultMatch[] {
    const out: FuseResultMatch[] = []
    for (const match of matches) {
      if (!match.indices.length) continue
      const formatted: FuseResultMatch = {
        indices: match.indices,
        value: this._index.valueAt(refIndex, match.keyIndex, match.arrayIndex),
      }
      if (match.keyIndex >= 0) {
        const key = this._index.keys[match.keyIndex]
        if (key) formatted.key = key.id
      }
      if (match.arrayIndex > -1) formatted.refIndex = match.arrayIndex
      out.push(formatted)
    }
    return out
  }

  private toSortArg(hit: RawHit): FuseSortArg {
    const record = this._index.get(hit.refIndex)
    const item = !record ? undefined : isStringRecord(record) ? record.v : record.$
    return {
      idx: hit.refIndex,
      score: hit.score,
      item,
      matches: hit.matches.map((match) => ({
        score: match.rawScore,
        value: this._index.valueAt(hit.refIndex, match.keyIndex, match.arrayIndex),
        norm: match.norm,
        indices: match.indices,
        ...(match.keyIndex >= 0 ? { key: this._keyStore.get(this._index.keys[match.keyIndex]!.id) } : {}),
        ...(match.arrayIndex > -1 ? { idx: match.arrayIndex } : {}),
      })),
    }
  }
}

export { init as initWasm }
export { FuseWorker } from './async'
export type { FuseWorkerOptions } from './async'
