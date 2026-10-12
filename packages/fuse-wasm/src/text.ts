import { stripDiacritics } from './diacritics'

export interface NormOptions {
  isCaseSensitive: boolean
  ignoreDiacritics: boolean
}

/** Same order as Fuse: case-fold, then strip diacritics. */
export function normalizeText(value: string, options: NormOptions): string {
  let text = options.isCaseSensitive ? value : value.toLowerCase()
  if (options.ignoreDiacritics) text = stripDiacritics(text)
  return text
}

export function isBlank(value: string): boolean {
  return value.trim().length === 0
}

function isWordSeparator(code: number): boolean {
  return (code >= 9 && code <= 13) || code === 32 || code === 160
}

/** Field-length norm. `weight` is `fieldNormWeight`, rounded to 3 decimals. */
export function fieldNorm(value: string, weight = 1): number {
  let numTokens = 0
  let inWord = false
  for (let i = 0; i < value.length; i += 1) {
    if (!isWordSeparator(value.charCodeAt(i))) {
      if (!inWord) {
        numTokens += 1
        inWord = true
      }
    } else {
      inWord = false
    }
  }
  if (numTokens === 0) numTokens = 1
  const m = 1000
  return Math.round(m / Math.pow(numTokens, 0.5 * weight)) / m
}

export function utf16(value: string): Uint16Array {
  const out = new Uint16Array(value.length)
  for (let i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i)
  return out
}
