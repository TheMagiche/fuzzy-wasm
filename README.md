# fuse-wasm

Fuzzy search with the [Fuse.js](https://www.fusejs.io) 7.x API. The Bitap engine, extended-search operators, and logical queries run in Rust, compiled to WebAssembly. Collections stay in JavaScript. A React hook searches from a Web Worker so a large list does not block typing.

## Install and run

Requirements: Node 22, pnpm 10, Rust stable, and [wasm-pack](https://rustwasm.github.io/wasm-pack/).

```bash
pnpm install
pnpm build:wasm
pnpm --filter fuse-wasm test
pnpm dev
```

`pnpm dev` starts the card-catalog demo at <http://127.0.0.1:43123>. The same demo is published at <https://themagiche.github.io/fuzzy-wasm/>. It indexes 100,000 generated books in a worker and can time the same query with Fuse.js on the main thread.

```bash
pnpm test          # wasm build, cargo test, vitest differential suite
pnpm bench         # Node timings against fuse.js 7.5.0
pnpm build         # wasm-pack plus the tsup package build
```

The release `.wasm` is 74,239 bytes, 32,560 bytes gzipped, under the 60 KB target. `pnpm size` prints the gzip size.

## Migration from Fuse.js 7

```ts
import Fuse, { init } from 'fuse-wasm'

await init() // once, before the first search

const fuse = new Fuse(books, {
  keys: [
    { name: 'title', weight: 0.7 },
    { name: 'author.firstName', weight: 0.3 },
  ],
  includeScore: true,
  includeMatches: true,
  threshold: 0.4,
})

const results = fuse.search('old man', { limit: 10 })
fuse.add(book)
fuse.remove((doc) => doc.id === 42)
fuse.removeAt(3)
fuse.setCollection(otherBooks)
fuse.dispose() // frees the WASM index
```

`new Fuse()` stays synchronous. `search()` throws a clear error if `init()` has not finished. Pass `init('/fuse_engine_bg.wasm')` when the binary is hosted somewhere else.

Prebuilt indexes use the same JSON as Fuse.js:

```ts
const index = Fuse.createIndex(['title', 'author.firstName'], books)
const restored = new Fuse(books, options, Fuse.parseIndex(index.toJSON()))
```

`Fuse.createIndex(...).toJSON()` can be parsed by Fuse.js, and the other way around.

### Worker and React

```ts
import { FuseWorker } from 'fuse-wasm'
import { useFuseWasm, FuseWasmProvider } from 'fuse-wasm/react'

const fuse = await FuseWorker.create(books, options)
const results = await fuse.search('query', { limit: 20 })
fuse.terminate()
```

```tsx
const { results, search, query, status, error } = useFuseWasm(items, options, {
  debounceMs: 0,
  limit: 50,
})
```

`<FuseWasmProvider items={items} options={options}>` shares one engine. A hook with no `items`, or with the same `items` reference, uses that engine. Any other `items` reference builds its own. The hook is safe to import on the server: it does not touch a worker until the browser mounts it, and it frees the engine on unmount.

If `Worker` is missing, `FuseWorker` logs one warning and searches on the main thread.

## Differences from Fuse.js

- Call `await init()` once before `search()`. That is the only required API change.
- `dispose()` frees WASM memory. Fuse.js has no equivalent.
- `useTokenSearch`, `tokenize`, and `tokenMatch` throw. They are not implemented. Any other unknown option throws, naming the option.
- Fuse.js before 7.x is not a target. Behavior matches fuse.js 7.5.0.
- A custom `getFn` runs in JavaScript while the index is built. It is not called from WASM.
- A custom `sortFn` runs in JavaScript after WASM returns every hit. The default sort stays in WASM and can stop at `limit`. A custom sort pays to score the full hit list.
- Documents never enter WASM. Only normalized UTF-16 key strings do. `item` on a result is the original object.
- Case folding uses JavaScript `String#toLowerCase`, then the same diacritic strip as Fuse (NFD, combining marks, and the non-decomposable map). That keeps `İ` and `ß` aligned with Fuse.
- Scores are `f64`. Differential tests require the same order, the same match indices, and scores within `1e-9`.

## Benchmarks

`pnpm bench` writes `bench/RESULTS.md` and `bench/chart.svg`. Node 22, fuse.js 7.5.0. Times below are milliseconds in one process.

![Median query time on a log scale. Red is fuse-wasm, black is fuse.js.](bench/chart.svg)

| Records | Shape | fuse-wasm | fuse.js | Query speedup |
| --- | --- | ---: | ---: | ---: |
| 1,000 | 1 key, “sea” | 0.83 ms | 1.26 ms | 1.5× |
| 100,000 | 1 key, “sea” | 64 ms | 97 ms | 1.5× |
| 100,000 | 5 keys, medium query | 192 ms | 870 ms | 4.5× |
| 1,000,000 | 1 key, “sea” | 843 ms | 1,438 ms | 1.7× |

A short query on one key does not hit a 3× target. Five keys does, on a medium query. A 40-character pattern that cannot match these titles is about 200× faster, because an exact character prefilter skips the record and fuse.js still runs Bitap. Scores stay the same: both return no hits.

Index builds are slower. At 1,000 one-key records, building the WASM index took 8.4 ms against Fuse's 2.4 ms. At 1,000,000 records it took 29 s against 0.56 s. The documents are copied in as normalized UTF-16 once, and that copy dominates.

Queries were not slower at 20 records in a separate check (0.024 ms vs 0.068 ms). At 200 records they tied (0.12 ms). Full median, p95, throughput, index time, and heap are in `bench/RESULTS.md`. Heap deltas go negative when garbage collection runs during the sample.

A non-SIMD build is the default. CI also builds with `RUSTFLAGS="-C target-feature=+simd128" --features simd`. SIMD is used for the UTF-16 `indexOf` scan. Scoring stays on the scalar path so results do not change.

## Layout

- `crates/fuse-engine` — Rust Bitap, extended search, logical queries, result buffer
- `packages/fuse-wasm` — TypeScript `Fuse`, `FuseWorker`, `useFuseWasm`
- `packages/bench` — Node comparison against fuse.js
- `examples/react-demo` — 100k-card catalog
- `fixtures/` — the book list used by the differential tests

## License

MIT
