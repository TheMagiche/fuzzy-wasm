import { get as defaultGet } from './get'
import { createKey, type FuseOptionKey, type KeyObject } from './keys'
import { fieldNorm, isBlank } from './text'

export interface FuseIndexOptions<T> {
  getFn?: (obj: T, path: string | string[]) => unknown
  fieldNormWeight?: number
}

export interface SubRecord {
  v: string
  n: number
  i?: number
}

export interface StringRecord {
  i: number
  v: string
  n: number
}

export interface ObjectRecord {
  i: number
  $: Record<number, SubRecord | SubRecord[]>
}

export type IndexRecord = StringRecord | ObjectRecord

export function isStringRecord(record: IndexRecord): record is StringRecord {
  return 'v' in record
}

export class FuseIndex<T = unknown> {
  readonly normWeight: number
  getFn: (obj: T, path: string | string[]) => unknown
  docs: readonly T[] = []
  records: IndexRecord[] = []
  keys: KeyObject[] = []
  private keyPos: Record<string, number> = {}
  private byIdx = new Map<number, IndexRecord>()

  constructor({ getFn = defaultGet as FuseIndexOptions<T>['getFn'], fieldNormWeight = 1 }: FuseIndexOptions<T> = {}) {
    this.getFn = getFn ?? (defaultGet as FuseIndexOptions<T>['getFn'])!
    this.normWeight = fieldNormWeight
  }

  setSources(docs: readonly T[] = []): void {
    this.docs = docs
  }

  setIndexRecords(records: IndexRecord[] = []): void {
    this.records = records
    this.rebuildLookup()
  }

  setKeys(keys: readonly KeyObject[] = []): void {
    this.keys = [...keys]
    this.keyPos = {}
    keys.forEach((key, idx) => {
      this.keyPos[key.id] = idx
    })
  }

  create(): void {
    if (!this.docs.length) {
      this.records = []
      this.rebuildLookup()
      return
    }
    const records: IndexRecord[] = []
    if (typeof this.docs[0] === 'string') {
      for (let i = 0; i < this.docs.length; i += 1) {
        const record = this.stringRecord(this.docs[i] as string, i)
        if (record) records.push(record)
      }
    } else {
      for (let i = 0; i < this.docs.length; i += 1) {
        records.push(this.objectRecord(this.docs[i], i))
      }
    }
    this.records = records
    this.rebuildLookup()
  }

  add(doc: T, docIndex: number): IndexRecord | null {
    if (!Number.isInteger(docIndex) || docIndex < 0) {
      throw new Error('Invalid doc index: must be a non-negative integer within the bounds of the docs array')
    }
    const record =
      typeof doc === 'string' ? this.stringRecord(doc, docIndex) : this.objectRecord(doc, docIndex)
    if (record) {
      this.records.push(record)
      this.byIdx.set(record.i, record)
    }
    return record
  }

  removeAt(idx: number): void {
    if (!Number.isInteger(idx) || idx < 0) {
      throw new Error('Invalid doc index: must be a non-negative integer within the bounds of the docs array')
    }
    for (let i = 0; i < this.records.length; i += 1) {
      if (this.records[i].i === idx) {
        this.records.splice(i, 1)
        break
      }
    }
    for (const record of this.records) {
      if (record.i > idx) record.i -= 1
    }
    this.rebuildLookup()
  }

  removeAll(indices: readonly number[]): void {
    const toRemove = new Set<number>()
    for (const value of indices) {
      if (Number.isInteger(value) && value >= 0) toRemove.add(value)
    }
    if (toRemove.size === 0) return
    this.records = this.records.filter((record) => !toRemove.has(record.i))
    const sorted = [...toRemove].sort((a, b) => a - b)
    for (const record of this.records) {
      let lo = 0
      let hi = sorted.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (sorted[mid] < record.i) lo = mid + 1
        else hi = mid
      }
      record.i -= lo
    }
    this.rebuildLookup()
  }

  get(idx: number): IndexRecord | undefined {
    return this.byIdx.get(idx)
  }

  valueAt(idx: number, keyIndex: number, arrayIndex: number): string | undefined {
    const record = this.byIdx.get(idx)
    if (!record) return undefined
    if (isStringRecord(record)) return record.v
    const field = record.$[keyIndex]
    if (!field) return undefined
    if (Array.isArray(field)) {
      const found = field.find((item) => item.i === arrayIndex)
      return found?.v
    }
    return field.v
  }

  toJSON(): { keys: Omit<KeyObject, 'getFn'>[]; records: IndexRecord[] } {
    return {
      keys: this.keys.map(({ getFn: _getFn, ...key }) => key),
      records: this.records,
    }
  }

  private rebuildLookup(): void {
    this.byIdx = new Map(this.records.map((record) => [record.i, record]))
  }

  private stringRecord(doc: string, docIndex: number): StringRecord | null {
    if (doc == null || isBlank(doc)) return null
    return { v: doc, i: docIndex, n: fieldNorm(doc, this.normWeight) }
  }

  private objectRecord(doc: T, docIndex: number): ObjectRecord {
    const record: ObjectRecord = { i: docIndex, $: {} }
    for (let keyIndex = 0; keyIndex < this.keys.length; keyIndex += 1) {
      const key = this.keys[keyIndex]
      const value = key.getFn ? key.getFn(doc) : this.getFn(doc, key.path)
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) {
        const sub: SubRecord[] = []
        for (let i = 0; i < value.length; i += 1) {
          const item = value[i]
          if (item === undefined || item === null) continue
          if (typeof item === 'string') {
            if (!isBlank(item)) sub.push({ v: item, i, n: fieldNorm(item, this.normWeight) })
          } else if (item && item.v !== undefined && item.v !== null) {
            const text = typeof item.v === 'string' ? item.v : String(item.v)
            if (!isBlank(text)) sub.push({ v: text, i: item.i, n: fieldNorm(text, this.normWeight) })
          }
        }
        record.$[keyIndex] = sub
      } else if (typeof value === 'string' && !isBlank(value)) {
        record.$[keyIndex] = { v: value, n: fieldNorm(value, this.normWeight) }
      }
    }
    return record
  }
}

export function createIndex<T>(
  keys: readonly FuseOptionKey<T>[],
  docs: readonly T[],
  { getFn = defaultGet as FuseIndexOptions<T>['getFn'], fieldNormWeight = 1 }: FuseIndexOptions<T> = {},
): FuseIndex<T> {
  const index = new FuseIndex<T>({ getFn, fieldNormWeight })
  index.setKeys(keys.map((key) => createKey(key)))
  index.setSources(docs)
  index.create()
  return index
}

export function parseIndex<T>(
  data: { keys: readonly KeyObject[]; records: IndexRecord[] },
  { getFn = defaultGet as FuseIndexOptions<T>['getFn'], fieldNormWeight = 1 }: FuseIndexOptions<T> = {},
): FuseIndex<T> {
  const index = new FuseIndex<T>({ getFn, fieldNormWeight })
  index.setKeys(data.keys)
  index.setIndexRecords(data.records)
  return index
}
