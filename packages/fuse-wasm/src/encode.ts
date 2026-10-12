import { isStringRecord, type IndexRecord, type SubRecord } from './fuse-index'
import { utf16, type NormOptions, normalizeText } from './text'

const MAGIC = 0x46555345

class Buf {
  private bytes = new Uint8Array(256)
  private len = 0
  private view = new DataView(this.bytes.buffer)

  private grow(extra: number): void {
    const need = this.len + extra
    if (need <= this.bytes.length) return
    let size = this.bytes.length
    while (size < need) size *= 2
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

  f64(value: number): void {
    this.grow(8)
    this.view.setFloat64(this.len, value, true)
    this.len += 8
  }

  text(value: string): void {
    this.u32(value.length)
    this.grow(value.length * 2)
    for (let i = 0; i < value.length; i += 1) {
      this.view.setUint16(this.len, value.charCodeAt(i), true)
      this.len += 2
    }
  }

  finish(): Uint8Array {
    return this.bytes.subarray(0, this.len)
  }
}

function writeRecord(buf: Buf, record: IndexRecord, keyCount: number, norm: NormOptions): void {
  buf.u32(record.i)
  if (isStringRecord(record)) {
    buf.f64(record.n)
    buf.text(normalizeText(record.v, norm))
    return
  }
  for (let key = 0; key < keyCount; key += 1) {
    const field = record.$[key]
    if (!field) {
      buf.u32(0)
      continue
    }
    if (Array.isArray(field)) {
      buf.u32(field.length)
      for (const item of field) writeValue(buf, item, norm)
    } else {
      buf.u32(1)
      writeValue(buf, field, norm, -1)
    }
  }
}

function writeValue(buf: Buf, item: SubRecord, norm: NormOptions, arrayIndex = item.i ?? -1): void {
  buf.i32(arrayIndex)
  buf.f64(item.n)
  buf.text(normalizeText(item.v, norm))
}

export function encodeCollection(
  index: { records: readonly IndexRecord[] },
  stringList: boolean,
  weights: readonly number[],
  norm: NormOptions,
): Uint8Array {
  const buf = new Buf()
  buf.u32(MAGIC)
  buf.u8(stringList ? 1 : 0)
  buf.u32(stringList ? 0 : weights.length)
  if (!stringList) {
    for (const weight of weights) buf.f64(weight)
  }
  buf.u32(index.records.length)
  const keyCount = stringList ? 0 : weights.length
  for (const record of index.records) writeRecord(buf, record, keyCount, norm)
  return buf.finish()
}

export function encodeRecord(record: IndexRecord, stringList: boolean, keyCount: number, norm: NormOptions): Uint8Array {
  const buf = new Buf()
  writeRecord(buf, record, stringList ? 0 : keyCount, norm)
  return buf.finish()
}

export { utf16 }
