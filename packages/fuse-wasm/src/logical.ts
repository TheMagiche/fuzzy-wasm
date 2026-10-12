import { createKeyId } from './keys'
import { utf16 } from './text'

export type Expression =
  | string
  | { [key: string]: string | Expression | Expression[] | undefined }
  | { $path: string | readonly string[]; $val: string }
  | { $and?: Expression[]; $or?: Expression[] }

interface Leaf {
  kind: 'leaf'
  keyId: string | null
  pattern: string
}

interface Op {
  kind: 'op'
  operator: string
  children: Parsed[]
}

type Parsed = Leaf | Op

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Port of Fuse 7.5 `parse`. A bare object becomes `$and`. A top-level `$path`
 * is split into separate keys before the path form can be recognized — `$path`
 * only survives when it is already inside `$and` / `$or`.
 */
export function parseLogical(query: Expression): Parsed {
  const next = (node: unknown): Parsed => {
    if (typeof node === 'string') {
      return { kind: 'leaf', keyId: null, pattern: node }
    }
    if (!isRecord(node)) {
      throw new Error('Invalid logical query')
    }
    const record = node as Record<string, unknown>
    const keys = Object.keys(record)
    const isQueryPath = Boolean(record.$path)
    const isExpression = Boolean(record.$and || record.$or)
    if (!isQueryPath && keys.length > 1 && !isExpression) {
      return next({
        $and: keys.map((key) => ({ [key]: record[key] })),
      })
    }
    if (!isExpression) {
      const key = (isQueryPath ? record.$path : keys[0]) as string | readonly string[]
      const pattern = isQueryPath ? record.$val : record[keys[0]!]
      if (typeof pattern !== 'string') {
        throw new Error(`Invalid value for key ${key}`)
      }
      return { kind: 'leaf', keyId: createKeyId(key), pattern }
    }
    const operator = keys[0]
    if (operator !== '$and' && operator !== '$or') {
      throw new Error(`Unsupported logical operator '${operator}'`)
    }
    const children: Parsed[] = []
    for (const key of keys) {
      const value = record[key]
      if (Array.isArray(value)) {
        for (const item of value) children.push(next(item))
      }
    }
    return { kind: 'op', operator, children }
  }

  if (!isRecord(query)) throw new Error('Invalid logical query')
  const record = query as Record<string, unknown>
  if (!record.$and && !record.$or) {
    return next({
      $and: Object.keys(record).map((key) => ({ [key]: record[key] })),
    })
  }
  return next(query)
}

class Buf {
  private bytes = new Uint8Array(64)
  private len = 0
  private view = new DataView(this.bytes.buffer)

  private grow(extra: number): void {
    if (this.len + extra <= this.bytes.length) return
    let size = this.bytes.length
    while (size < this.len + extra) size *= 2
    const next = new Uint8Array(size)
    next.set(this.bytes.subarray(0, this.len))
    this.bytes = next
    this.view = new DataView(next.buffer)
  }

  u8(value: number): void {
    this.grow(1)
    this.bytes[this.len] = value
    this.len += 1
  }

  u32(value: number): void {
    this.grow(4)
    this.view.setUint32(this.len, value, true)
    this.len += 4
  }

  i32(value: number): void {
    this.grow(4)
    this.view.setInt32(this.len, value, true)
    this.len += 4
  }

  text(value: string): void {
    const units = utf16(value)
    this.u32(units.length)
    this.grow(units.length * 2)
    for (let i = 0; i < units.length; i += 1) {
      this.view.setUint16(this.len, units[i], true)
      this.len += 2
    }
  }

  finish(): Uint8Array {
    return this.bytes.subarray(0, this.len)
  }
}

export function encodeLogical(node: Parsed, normalize: (pattern: string) => string, keyIndex: (id: string) => number): Uint8Array {
  const buf = new Buf()
  const write = (current: Parsed): void => {
    if (current.kind === 'leaf') {
      buf.u8(0)
      buf.i32(current.keyId == null ? -1 : keyIndex(current.keyId))
      buf.text(normalize(current.pattern))
      return
    }
    buf.u8(current.operator === '$and' ? 1 : 2)
    buf.u32(current.children.length)
    for (const child of current.children) write(child)
  }
  write(node)
  return buf.finish()
}
