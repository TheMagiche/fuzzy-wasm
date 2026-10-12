/** `toString` matching Fuse's helper, including `-0`. */
export function toStringValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return value.toString()
  const result = `${value as string}`
  return result == '0' && 1 / (value as number) === -Infinity ? '-0' : result
}

/**
 * Fuse's default `get`. Walks a dotted path. Arrays fan out and come back as
 * `{ v, i }` so the original element index is preserved.
 */
export function get(obj: unknown, path: string | readonly string[]): unknown {
  const list: unknown[] = []
  let arr = false

  const deepGet = (current: unknown, parts: readonly string[], index: number, arrayIndex?: number): void => {
    if (current === undefined || current === null) return
    if (!parts[index]) {
      list.push(arrayIndex !== undefined ? { v: current, i: arrayIndex } : current)
      return
    }
    const value = (current as Record<string, unknown>)[parts[index]]
    if (value === undefined || value === null) return
    const last = index === parts.length - 1
    const primitive =
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    if (last && primitive) {
      const text = toStringValue(value)
      list.push(arrayIndex !== undefined ? { v: text, i: arrayIndex } : text)
    } else if (Array.isArray(value)) {
      arr = true
      for (let i = 0; i < value.length; i += 1) {
        deepGet(value[i], parts, index + 1, i)
      }
    } else if (parts.length) {
      deepGet(value, parts, index + 1, arrayIndex)
    }
  }

  deepGet(obj, typeof path === 'string' ? path.split('.') : path, 0)
  return arr ? list : list[0]
}
