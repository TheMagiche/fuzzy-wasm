export interface RawMatch {
  keyIndex: number
  arrayIndex: number
  rawScore: number
  norm: number
  indices: Array<[number, number]>
}

export interface RawHit {
  refIndex: number
  score: number
  matches: RawMatch[]
}

export function decodeHits(buf: Uint8Array, detailed: boolean, includeMatches: boolean): RawHit[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let offset = 0
  const count = view.getUint32(offset, true)
  offset += 4
  const hits: RawHit[] = []
  for (let i = 0; i < count; i += 1) {
    const refIndex = view.getUint32(offset, true)
    offset += 4
    const score = view.getFloat64(offset, true)
    offset += 8
    const matchCount = view.getUint32(offset, true)
    offset += 4
    const matches: RawMatch[] = []
    for (let m = 0; m < matchCount; m += 1) {
      const keyIndex = view.getInt32(offset, true)
      offset += 4
      const arrayIndex = view.getInt32(offset, true)
      offset += 4
      let rawScore = score
      let norm = 1
      if (detailed) {
        rawScore = view.getFloat64(offset, true)
        offset += 8
        norm = view.getFloat64(offset, true)
        offset += 8
      }
      const pairCount = view.getUint32(offset, true)
      offset += 4
      const indices: Array<[number, number]> = []
      for (let p = 0; p < pairCount; p += 1) {
        const start = view.getInt32(offset, true)
        offset += 4
        const end = view.getInt32(offset, true)
        offset += 4
        indices.push([start, end])
      }
      if (!includeMatches && !detailed && pairCount !== 0) {
        // Encoder omits pairs only by writing a zero count.
      }
      matches.push({ keyIndex, arrayIndex, rawScore, norm, indices })
    }
    hits.push({ refIndex, score, matches })
  }
  return hits
}
