/**
 * Node benchmarks against fuse.js 7.5.0.
 * Writes median, p95, queries/sec, index time, and heap to bench/RESULTS.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import FuseJs from 'fuse.js'
import Fuse, { init } from '../../fuse-wasm/src/index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const outFile = resolve(root, 'bench/RESULTS.md')

interface Case {
  label: string
  n: number
  keys: 1 | 5
  query: string
  includeMatches: boolean
  extended: boolean
  iters: number
}

interface Row {
  label: string
  n: number
  keys: number
  query: string
  includeMatches: boolean
  extended: boolean
  wasmMedian: number
  wasmP95: number
  jsMedian: number
  jsP95: number
  wasmQps: number
  jsQps: number
  wasmIndex: number
  jsIndex: number
  wasmHeap: number
  jsHeap: number
  ratio: number
}

const SHORT = 'sea'
const MEDIUM = 'old harbor'
const LONG = 'abcdefghijklmnopqrstuvwxyz0123456789extra'

function docsFor(n: number, keys: 1 | 5): unknown[] {
  const out = new Array(n)
  for (let i = 0; i < n; i += 1) {
    const title = `card ${i} old harbor sea market ${i % 97}`
    out[i] =
      keys === 1
        ? { title }
        : {
            title,
            author: { firstName: 'Ada', lastName: i % 50 === 0 ? 'Hemingway' : 'Young' },
            tags: ['red', i % 2 === 0 ? 'blue' : 'green'],
            note: `A ${LONG.slice(0, 12)} note about record ${i} in the stacks.`,
            year: String(1850 + (i % 170)),
          }
  }
  return out
}

function options(keys: 1 | 5, includeMatches: boolean, extended: boolean) {
  return {
    keys:
      keys === 1
        ? ['title']
        : ['title', 'author.lastName', 'author.firstName', 'tags', 'note'],
    includeScore: true,
    includeMatches,
    useExtendedSearch: extended,
    threshold: 0.4,
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]!
}

function time(fn: () => void, iters: number): { median: number; p95: number } {
  const samples: number[] = []
  for (let i = 0; i < iters; i += 1) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return { median: percentile(samples, 0.5), p95: percentile(samples, 0.95) }
}

function heapMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024)
}

async function measure(spec: Case): Promise<Row> {
  const records = docsFor(spec.n, spec.keys)
  const opts = options(spec.keys, spec.includeMatches, spec.extended)
  const query = spec.extended ? `'${spec.query}` : spec.query

  const beforeWasm = heapMb()
  const wasmIndexStart = performance.now()
  const wasm = new Fuse(records, opts as never)
  const wasmIndex = performance.now() - wasmIndexStart
  const wasmHeap = heapMb() - beforeWasm
  wasm.search('warmup')
  const wasmTimes = time(() => {
    wasm.search(query)
  }, spec.iters)
  wasm.dispose()

  global.gc?.()
  const beforeJs = heapMb()
  const jsIndexStart = performance.now()
  const js = new FuseJs(records, opts as never)
  const jsIndex = performance.now() - jsIndexStart
  const jsHeap = heapMb() - beforeJs
  js.search('warmup')
  const jsTimes = time(() => {
    js.search(query)
  }, spec.iters)

  return {
    label: spec.label,
    n: spec.n,
    keys: spec.keys,
    query: spec.query,
    includeMatches: spec.includeMatches,
    extended: spec.extended,
    wasmMedian: wasmTimes.median,
    wasmP95: wasmTimes.p95,
    jsMedian: jsTimes.median,
    jsP95: jsTimes.p95,
    wasmQps: 1000 / wasmTimes.median,
    jsQps: 1000 / jsTimes.median,
    wasmIndex,
    jsIndex,
    wasmHeap,
    jsHeap,
    ratio: jsTimes.median / wasmTimes.median,
  }
}

function num(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return 'n/a'
  return value.toFixed(digits)
}

function chart(rows: Row[]): string {
  const picked = rows.filter((row) => row.keys === 1 && row.query === SHORT && !row.includeMatches && !row.extended)
  const width = 680
  const height = 320
  const pad = 56
  const base = height - 52
  const plotH = 180
  const minLog = Math.log10(0.05)
  const maxLog = Math.log10(2000)
  const barH = (ms: number) => ((Math.log10(Math.max(ms, 0.05)) - minLog) / (maxLog - minLog)) * plotH
  const band = (width - pad * 2) / Math.max(picked.length, 1)
  const bars = picked
    .map((row, index) => {
      const x = pad + index * band
      const wasmH = barH(row.wasmMedian)
      const jsH = barH(row.jsMedian)
      const label = row.n >= 1_000_000 ? '1M' : row.n >= 1000 ? `${row.n / 1000}k` : String(row.n)
      return `
      <rect x="${x + 18}" y="${base - wasmH}" width="22" height="${wasmH}" fill="#8f2d2d"/>
      <rect x="${x + 44}" y="${base - jsH}" width="22" height="${jsH}" fill="#1c1612"/>
      <text x="${x + 29}" y="${base - wasmH - 6}" text-anchor="middle" font-size="11" fill="#8f2d2d">${row.wasmMedian.toFixed(row.wasmMedian < 10 ? 2 : 0)}</text>
      <text x="${x + 55}" y="${base - jsH - 6}" text-anchor="middle" font-size="11" fill="#1c1612">${row.jsMedian.toFixed(row.jsMedian < 10 ? 2 : 0)}</text>
      <text x="${x + 42}" y="${height - 22}" text-anchor="middle" font-size="13" fill="#1c1612">${label}</text>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Median query time, fuse-wasm versus fuse.js, log scale">
  <rect width="${width}" height="${height}" fill="#f3ecdf"/>
  <text x="${pad}" y="32" font-family="Georgia, serif" font-size="20" fill="#1c1612">Median query, one key, “sea”</text>
  <text x="${pad}" y="54" font-family="sans-serif" font-size="13" fill="#5e534a">Log scale, milliseconds. Red is fuse-wasm, black is fuse.js.</text>
  ${bars}
</svg>`
}

const cases: Case[] = []
for (const n of [50, 200]) {
  cases.push({
    label: `${n} · 1 key · short`,
    n,
    keys: 1,
    query: SHORT,
    includeMatches: false,
    extended: false,
    iters: 21,
  })
}
for (const n of [1_000, 10_000, 100_000]) {
  for (const keys of [1, 5] as const) {
    for (const [name, query] of [
      ['short', SHORT],
      ['medium', MEDIUM],
      ['long', LONG],
    ] as const) {
      cases.push({
        label: `${n} · ${keys} key · ${name}`,
        n,
        keys,
        query,
        includeMatches: false,
        extended: false,
        iters: n === 100_000 ? 5 : 11,
      })
    }
  }
  cases.push({
    label: `${n} · 1 key · short · matches`,
    n,
    keys: 1,
    query: SHORT,
    includeMatches: true,
    extended: false,
    iters: n === 100_000 ? 5 : 11,
  })
  cases.push({
    label: `${n} · 1 key · short · extended`,
    n,
    keys: 1,
    query: SHORT,
    includeMatches: false,
    extended: true,
    iters: n === 100_000 ? 5 : 11,
  })
}
cases.push({
  label: '1000000 · 1 key · short',
  n: 1_000_000,
  keys: 1,
  query: SHORT,
  includeMatches: false,
  extended: false,
  iters: 3,
})
cases.push({
  label: '1000000 · 1 key · long',
  n: 1_000_000,
  keys: 1,
  query: LONG,
  includeMatches: false,
  extended: false,
  iters: 3,
})

await init()
const rows: Row[] = []
for (const spec of cases) {
  process.stdout.write(`${spec.label} … `)
  const row = await measure(spec)
  rows.push(row)
  process.stdout.write(
    `wasm ${num(row.wasmMedian)} ms, fuse.js ${num(row.jsMedian)} ms, ratio ${num(row.ratio)}\n`,
  )
}

const header = `| Case | n | keys | wasm median | wasm p95 | js median | js p95 | wasm qps | js qps | wasm index | js index | wasm heap MB | js heap MB | js/wasm |`
const rule = `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`
const body = rows
  .map(
    (row) =>
      `| ${row.label} | ${row.n} | ${row.keys} | ${num(row.wasmMedian)} | ${num(row.wasmP95)} | ${num(row.jsMedian)} | ${num(row.jsP95)} | ${num(row.wasmQps, 1)} | ${num(row.jsQps, 1)} | ${num(row.wasmIndex)} | ${num(row.jsIndex)} | ${num(row.wasmHeap, 1)} | ${num(row.jsHeap, 1)} | ${num(row.ratio)} |`,
  )
  .join('\n')

const wins = rows.filter((row) => row.ratio >= 1)
const losses = rows.filter((row) => row.ratio < 1)
const crossover = rows
  .filter((row) => row.keys === 1 && row.query === SHORT && !row.includeMatches && !row.extended)
  .sort((a, b) => a.n - b.n)

const markdown = `# fuse-wasm benchmarks

Node ${process.version}, fuse.js 7.5.0, one process. Times are milliseconds. \`js/wasm\` above 1 means fuse-wasm is faster. Heap is the delta in \`process.memoryUsage().heapUsed\` across index construction, so it includes JS objects as well as the WASM heap.

Small collections often lose: the cost of building the record blob and crossing into WASM is larger than Fuse's own loop. The crossover is the smallest size in the one-key short-query series where wasm's median drops below fuse.js.

${crossover.map((row) => `- ${row.n.toLocaleString()} records: ${num(row.ratio)}× (${num(row.wasmMedian)} ms vs ${num(row.jsMedian)} ms)`).join('\n')}

${losses.length} cases were slower or tied in the wrong direction, ${wins.length} were faster. Slower cases are listed in the table with \`js/wasm\` below 1.

${chart(rows)}

${header}
${rule}
${body}
`

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, markdown)
const svg = chart(rows)
const svgFile = resolve(root, 'bench/chart.svg')
const match = svg.match(/<svg[\s\S]*<\/svg>/)
writeFileSync(svgFile, match?.[0] ?? svg)
console.log(`wrote ${outFile}`)
