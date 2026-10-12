import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import FuseJs from 'fuse.js'
import { beforeAll, describe, expect, it } from 'vitest'
import Fuse, { createIndex, init, parseIndex } from '../src/index'
import type { Expression, FuseResult, IFuseOptions } from '../src/index'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const books = JSON.parse(readFileSync(resolve(root, 'fixtures/books.json'), 'utf8')) as Array<{
  title: string
  author: { firstName: string; lastName: string }
}>

type Book = (typeof books)[number]

const bookOptions: IFuseOptions<Book> = {
  keys: [
    { name: 'title', weight: 0.7 },
    { name: 'author.firstName', weight: 0.3 },
  ],
  includeScore: true,
  includeMatches: true,
  threshold: 0.4,
}

beforeAll(async () => {
  await init()
})

function expectSame<T>(wasm: FuseResult<T>[], js: FuseResult<T>[], label: string): void {
  if (wasm.length !== js.length) {
    throw new Error(
      `${label}: length ${wasm.length} vs ${js.length}\nwasm ${JSON.stringify(wasm)}\njs   ${JSON.stringify(js)}`,
    )
  }
  for (let i = 0; i < js.length; i += 1) {
    const left = wasm[i]!
    const right = js[i]!
    expect(left.refIndex, `${label} refIndex`).toBe(right.refIndex)
    expect(left.item, `${label} item`).toEqual(right.item)
    if (typeof right.score === 'number') {
      const delta = Math.abs((left.score ?? Number.NaN) - right.score)
      if (!(delta < 1e-9)) {
        throw new Error(`${label}: score ${left.score} vs ${right.score} (delta ${delta})`)
      }
    } else {
      expect(left.score, `${label} score`).toBeUndefined()
    }
    expect(left.matches ?? null, `${label} matches`).toEqual(right.matches ?? null)
  }
}

function both<T>(docs: readonly T[], options?: IFuseOptions<T>, indexPair?: { wasm: Fuse<T>; js: FuseJs<T> }) {
  if (indexPair) return indexPair
  return {
    wasm: new Fuse(docs, options),
    js: new FuseJs(docs, options as never),
  }
}

function searchBoth<T>(
  docs: readonly T[],
  query: string | Expression,
  options?: IFuseOptions<T>,
  search?: { limit?: number },
): void {
  const { wasm, js } = both(docs, options)
  expectSame(wasm.search(query, search), js.search(query as never, search) as FuseResult<T>[], JSON.stringify(query))
}

describe('string lists', () => {
  const docs = ['hello', 'hello world', 'hallo', 'world', 'abcdef', 'xyzxyz', '😀😀', 'café', 'Café', '']

  it('matches fuse.js across the basic option matrix', () => {
    const queries = ['hello', 'hallo', 'world', 'abxdef', 'xyz', '😀', 'cafe', 'Café', '   ', '']
    const optionSets: IFuseOptions<string>[] = [
      { includeScore: true, includeMatches: true },
      { includeScore: true, includeMatches: true, threshold: 0.6, distance: 100 },
      { includeScore: true, includeMatches: true, ignoreLocation: true },
      { includeScore: true, includeMatches: true, threshold: 0, distance: 0 },
      { includeScore: true, includeMatches: true, findAllMatches: true, threshold: 0.3 },
      { includeScore: true, includeMatches: true, minMatchCharLength: 3 },
      { includeScore: true, includeMatches: true, isCaseSensitive: true },
      { includeScore: true, includeMatches: true, ignoreDiacritics: true },
      { includeScore: true, includeMatches: true, shouldSort: false },
      { includeScore: true, ignoreFieldNorm: true },
      { includeScore: true, includeMatches: true, location: 4, distance: 10 },
    ]
    for (const options of optionSets) {
      for (const query of queries) {
        searchBoth(docs, query, options)
        searchBoth(docs, query, options, { limit: 2 })
        searchBoth(docs, query, options, { limit: 0 })
      }
    }
  })

  it('locks a few published fuse.js 7.5 scores', () => {
    const hello = new Fuse(['hello'], { includeScore: true, includeMatches: true })
    const exact = hello.search('hello')
    expect(exact[0]?.score).toBe(0)
    expect(exact[0]?.matches?.[0]?.indices).toEqual([[0, 4]])

    const fuzzy = new Fuse(['hello'], { includeScore: true, includeMatches: true })
    const hallo = fuzzy.search('hallo')
    expect(hallo[0]?.score).toBeCloseTo(0.2, 12)
    expect(hallo[0]?.matches?.[0]?.indices).toEqual([
      [0, 0],
      [2, 4],
    ])

    const world = new Fuse(['hello world'], { includeScore: true, includeMatches: true })
    expect(world.search('world')[0]?.score).toBeCloseTo(0.13682105473575515, 12)

    const ignored = new Fuse(['hello world'], {
      includeScore: true,
      includeMatches: true,
      ignoreLocation: true,
    })
    expect(ignored.search('world')[0]?.score).toBeCloseTo(0.007568328950209746, 12)

    const emoji = new Fuse(['😀😀'], { includeScore: true, includeMatches: true })
    expect(emoji.search('😀')[0]?.score).toBeCloseTo(0.001, 12)
    expect(emoji.search('😀')[0]?.matches?.[0]?.indices).toEqual([[0, 3]])
  })

  it('chunks patterns longer than 32 code units the way fuse does', () => {
    const pattern = 'abcdefghijklmnopqrstuvwxyz0123456789zzzz'
    const text = 'abcdefghijklmnopqrstuvwxyz0123456789extra'
    searchBoth([text], pattern, { includeScore: true, includeMatches: true, threshold: 0.4 })
  })

  it('keeps a perfect full-string match at score 0 even past 32 characters', () => {
    const text = 'a'.repeat(40)
    const hit = new Fuse([text], { includeScore: true, includeMatches: true, threshold: 0 }).search(text)
    expect(hit[0]?.score).toBe(0)
    expect(hit).toEqual(new FuseJs([text], { includeScore: true, includeMatches: true, threshold: 0 }).search(text))
  })
})

describe('objects, weights, and extended search', () => {
  it('ranks the book fixture like fuse.js', () => {
    searchBoth(books, 'old man', bookOptions)
    const hits = new Fuse(books, bookOptions).search('old man')
    expect(hits.map((hit) => hit.refIndex)).toEqual([1, 0])
    expect(hits[0]?.score).toBeCloseTo(0.061418612340630244, 12)
    expect(hits[1]?.score).toBeCloseTo(0.39879374100758036, 12)
  })

  it('walks extended operators', () => {
    const options: IFuseOptions<Book> = {
      ...bookOptions,
      useExtendedSearch: true,
      threshold: 0.6,
    }
    const queries = [
      "'Old",
      '^The',
      'Sea$',
      '!Young',
      '!^The',
      '!War$',
      'Old | Young',
      '^The Sea$',
      '="Old Man\'s War"',
      "'hello world",
      String.raw`old \| man`,
    ]
    for (const query of queries) searchBoth(books, query, options)
  })

  it('requires every key to satisfy an inverse pattern', () => {
    searchBoth(books, '!Scalzi', {
      keys: ['title', 'author.lastName'],
      useExtendedSearch: true,
      includeScore: true,
      includeMatches: true,
    })
  })

  it('searches nested keys, arrays, numbers, and booleans', () => {
    const docs = [
      { title: 'sea storm', author: 'ernest', year: 1952, inPrint: true, tags: ['red', 'blue'] },
      { title: 'quiet city', author: 'ann', year: 42, inPrint: false, tags: ['green'] },
      { author: { names: ['Ann', 'Bob'] }, title: 'nested' },
    ]
    const options: IFuseOptions<(typeof docs)[number]> = {
      keys: ['title', 'author', 'author.names', 'year', 'inPrint', 'tags'],
      includeScore: true,
      includeMatches: true,
      threshold: 0.4,
    }
    for (const query of ['ernest', '42', 'true', 'red', 'bob', 'storm', 'ann']) {
      searchBoth(docs, query, options)
    }
  })

  it('uses a custom getFn only at index time', () => {
    const docs = [{ name: { first: 'Ada', last: 'Lovelace' } }]
    const options: IFuseOptions<(typeof docs)[number]> = {
      keys: ['label'],
      getFn: (obj) => `${obj.name.first} ${obj.name.last}`,
      includeScore: true,
      includeMatches: true,
    }
    searchBoth(docs, 'ada', options)
  })

  it('honors a custom sortFn in JavaScript', () => {
    const docs = ['ba', 'ab', 'aa', 'zz']
    searchBoth(docs, 'a', {
      includeScore: true,
      sortFn: (a, b) => a.idx - b.idx,
    })
  })
})

describe('logical queries', () => {
  const options: IFuseOptions<Book> = {
    keys: [
      { name: 'title', weight: 0.5 },
      { name: 'author.lastName', weight: 0.3 },
      { name: 'author.firstName', weight: 0.2 },
    ],
    includeScore: true,
    includeMatches: true,
    threshold: 0.4,
  }

  it('matches $and, $or, $path, and implicit and', () => {
    const queries: Expression[] = [
      { $and: [{ title: 'old' }, { title: 'man' }] },
      { $or: [{ title: 'young' }, { title: 'war' }] },
      { title: 'sea', author: 'ernest' },
      { $or: [{ $path: 'author.lastName', $val: 'Hemingway' }, { title: 'war' }] },
      { $and: [{ $path: ['author', 'firstName'], $val: 'John' }, { title: 'war' }] },
      { nope: 'sea' },
    ]
    for (const query of queries) searchBoth(books, query, options)
  })

  it('returns nothing for a logical query over a string list', () => {
    expect(new Fuse(['hello', 'world'], { includeScore: true }).search({ $and: ['hello'] })).toEqual([])
  })

  it('rejects a non-string leaf', () => {
    const fuse = new Fuse(books, options)
    expect(() => fuse.search({ title: 12 } as never)).toThrow(/Invalid value for key title/)
  })
})

describe('index compatibility', () => {
  it('round-trips toJSON with fuse.js in both directions', () => {
    const keys = ['title', 'author.firstName']
    const fromJs = FuseJs.createIndex(keys, books).toJSON()
    const fromWasm = createIndex(keys, books).toJSON()
    expect(fromWasm).toEqual(fromJs)

    const options: IFuseOptions<Book> = {
      keys,
      includeScore: true,
      includeMatches: true,
      threshold: 0.4,
    }
    const wasmFromJs = new Fuse(books, options, parseIndex(fromJs as never))
    const jsFromWasm = new FuseJs(books, options as never, FuseJs.parseIndex(fromWasm as never))
    expectSame(wasmFromJs.search('old man'), jsFromWasm.search('old man') as FuseResult<Book>[], 'cross index')
  })

  it('rejects a plain object passed as an index', () => {
    expect(() => new Fuse(books, bookOptions, { records: [] } as never)).toThrow(/Incorrect 'index' type/)
  })
})

describe('mutations', () => {
  it('tracks add, remove, removeAt, and setCollection', () => {
    const seed = ['aa', 'ab', 'ac', 'ba']
    const wasmDocs = [...seed]
    const jsDocs = [...seed]
    const options: IFuseOptions<string> = { includeScore: true, includeMatches: true, threshold: 0.6 }
    const wasm = new Fuse(wasmDocs, options)
    const js = new FuseJs(jsDocs, options as never)

    const check = (label: string) => {
      expectSame(wasm.search('a'), js.search('a') as FuseResult<string>[], label)
    }

    check('initial')
    wasm.add('az')
    js.add('az')
    check('add')
    wasm.removeAt(1)
    js.removeAt(1)
    check('removeAt')
    wasm.remove((doc) => doc.startsWith('b'))
    js.remove((doc) => doc.startsWith('b'))
    check('remove')
    wasm.setCollection(['qa', 'qb', 'zz'])
    js.setCollection(['qa', 'qb', 'zz'])
    check('setCollection')
    wasm.setCollection([])
    js.setCollection([])
    wasm.add('hello')
    js.add('hello')
    expectSame(wasm.search('hello'), js.search('hello') as FuseResult<string>[], 'empty then add')
  })

  it('throws the fuse message for a bad removeAt and leaves the list alone', () => {
    const docs = ['a', 'b', 'c']
    const fuse = new Fuse(docs)
    expect(() => fuse.removeAt(9)).toThrow(
      'Invalid doc index: must be a non-negative integer within the bounds of the docs array',
    )
    expect(docs).toEqual(['a', 'b', 'c'])
  })

  it('does not index blank strings, but empty queries still list them', () => {
    const docs = ['hello', '   ', 'world']
    searchBoth(docs, 'hello', { includeScore: true, includeMatches: true })
    searchBoth(docs, '   ', { includeScore: true })
  })
})

describe('options', () => {
  it('names unsupported and unknown options', () => {
    expect(() => new Fuse([], { useTokenSearch: false } as never)).toThrow(/useTokenSearch/)
    expect(() => new Fuse([], { tokenize: /\w+/g } as never)).toThrow(/tokenize/)
    expect(() => new Fuse([], { tokenMatch: 'all' } as never)).toThrow(/tokenMatch/)
    expect(() => new Fuse([], { includeScoreX: true } as never)).toThrow(/includeScoreX/)
  })

  it('rejects a non-positive key weight with fuse\'s message', () => {
    expect(() => new Fuse(books, { keys: [{ name: 'title', weight: 0 }] })).toThrow(
      "Property 'weight' in key 'title' must be a positive integer",
    )
  })
})

describe('property comparisons', () => {
  it('agrees with fuse.js on random strings and queries', () => {
    let seed = 0x12345678
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 0x100000000
    }
    const alphabet = 'abcde xyz😀äöü'
    const randomString = () => {
      const len = Math.floor(rand() * 24)
      let out = ''
      for (let i = 0; i < len; i += 1) out += alphabet[Math.floor(rand() * alphabet.length)]
      return out
    }
    for (let trial = 0; trial < 25; trial += 1) {
      const docs = Array.from({ length: 30 }, randomString)
      const query = randomString() || 'a'
      const options: IFuseOptions<string> = {
        includeScore: true,
        includeMatches: true,
        threshold: 0.2 + rand() * 0.6,
        distance: Math.floor(rand() * 80),
        ignoreLocation: rand() > 0.7,
        ignoreDiacritics: rand() > 0.5,
        minMatchCharLength: 1 + Math.floor(rand() * 2),
        findAllMatches: rand() > 0.8,
      }
      searchBoth(docs, query, options, { limit: rand() > 0.5 ? 5 : -1 })
    }
  })
})
