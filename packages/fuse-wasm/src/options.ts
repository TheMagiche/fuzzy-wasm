import { get } from './get'
import type { FuseOptionKey } from './keys'

export interface FuseSortArg {
  idx: number
  item: unknown
  score: number
  matches?: unknown[]
}

export type FuseSortFunction = (a: FuseSortArg, b: FuseSortArg) => number

export function defaultSort(a: { score: number; idx: number }, b: { score: number; idx: number }): number {
  return a.score === b.score ? (a.idx < b.idx ? -1 : 1) : a.score < b.score ? -1 : 1
}

export interface IFuseOptions<T> {
  isCaseSensitive?: boolean
  ignoreDiacritics?: boolean
  includeScore?: boolean
  includeMatches?: boolean
  minMatchCharLength?: number
  shouldSort?: boolean
  findAllMatches?: boolean
  keys?: Array<FuseOptionKey<T>>
  location?: number
  threshold?: number
  distance?: number
  ignoreLocation?: boolean
  useExtendedSearch?: boolean
  getFn?: (obj: T, path: string | string[]) => unknown
  sortFn?: FuseSortFunction
  ignoreFieldNorm?: boolean
  fieldNormWeight?: number
}

export interface FuseSearchOptions {
  limit?: number
}

const KNOWN = new Set([
  'isCaseSensitive',
  'ignoreDiacritics',
  'includeScore',
  'includeMatches',
  'minMatchCharLength',
  'shouldSort',
  'findAllMatches',
  'keys',
  'location',
  'threshold',
  'distance',
  'ignoreLocation',
  'useExtendedSearch',
  'getFn',
  'sortFn',
  'ignoreFieldNorm',
  'fieldNormWeight',
])

const UNSUPPORTED = new Set(['useTokenSearch', 'tokenize', 'tokenMatch'])

export function assertSupportedOptions(options: object | undefined): void {
  if (!options) return
  for (const key of Object.keys(options)) {
    if (UNSUPPORTED.has(key)) {
      throw new Error(
        `Unsupported option '${key}'. fuse-wasm implements Fuse.js 7.x fuzzy, extended, and logical search, not token search.`,
      )
    }
    if (!KNOWN.has(key)) {
      throw new Error(`Unsupported option '${key}'.`)
    }
  }
}

export const Config: Required<IFuseOptions<unknown>> = Object.freeze({
  isCaseSensitive: false,
  ignoreDiacritics: false,
  includeScore: false,
  includeMatches: false,
  minMatchCharLength: 1,
  shouldSort: true,
  findAllMatches: false,
  keys: [] as FuseOptionKey<unknown>[],
  location: 0,
  threshold: 0.6,
  distance: 100,
  ignoreLocation: false,
  useExtendedSearch: false,
  getFn: get as Required<IFuseOptions<unknown>>['getFn'],
  sortFn: defaultSort as FuseSortFunction,
  ignoreFieldNorm: false,
  fieldNormWeight: 1,
})
