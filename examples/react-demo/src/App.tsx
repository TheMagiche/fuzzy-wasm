import FuseJs from 'fuse.js'
import { useMemo, useRef, useState } from 'react'
import { FuseWasmProvider, useFuseWasm, type IFuseOptions } from 'fuse-wasm/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { makeCatalog, type Card } from './books'

const OPTIONS: IFuseOptions<Card> = {
  keys: [
    { name: 'title', weight: 0.6 },
    { name: 'author.lastName', weight: 0.25 },
    { name: 'author.firstName', weight: 0.15 },
  ],
  includeScore: true,
  includeMatches: true,
  ignoreDiacritics: true,
  threshold: 0.35,
  distance: 100,
}

function formatMs(value: number | null): string {
  if (value == null) return '—'
  if (value < 10) return `${value.toFixed(1)} ms`
  return `${Math.round(value)} ms`
}

function Highlight({ text, indices }: { text: string; indices?: ReadonlyArray<readonly [number, number]> }) {
  if (!indices?.length) return <>{text}</>
  const pieces: Array<{ text: string; mark: boolean }> = []
  let cursor = 0
  for (const [start, end] of indices) {
    if (start < cursor || end < start || end >= text.length) continue
    if (start > cursor) pieces.push({ text: text.slice(cursor, start), mark: false })
    pieces.push({ text: text.slice(start, end + 1), mark: true })
    cursor = end + 1
  }
  if (cursor === 0) return <>{text}</>
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), mark: false })
  return (
    <>
      {pieces.map((piece, index) =>
        piece.mark ? (
          <mark key={index} className="rounded-sm bg-[#f3d27a] px-0.5 text-ink">
            {piece.text}
          </mark>
        ) : (
          <span key={index}>{piece.text}</span>
        ),
      )}
    </>
  )
}

function Catalog() {
  const cards = useMemo(() => makeCatalog(100_000), [])
  return (
    <FuseWasmProvider items={cards} options={OPTIONS} hookOptions={{ limit: 12, debounceMs: 0 }}>
      <CatalogBody count={cards.length} cards={cards} />
    </FuseWasmProvider>
  )
}

function CatalogBody({ count, cards }: { count: number; cards: Card[] }) {
  const { results, search, query, status, error, elapsedMs, indexMs } = useFuseWasm<Card>()
  const fuseJs = useRef<FuseJs<Card> | null>(null)
  const [comparing, setComparing] = useState(false)
  const [jsSearchMs, setJsSearchMs] = useState<number | null>(null)
  const [jsIndexMs, setJsIndexMs] = useState<number | null>(null)
  const [jsError, setJsError] = useState<string | null>(null)

  async function compare() {
    if (!query.trim() || comparing) return
    setComparing(true)
    setJsError(null)
    await new Promise((resolve) => setTimeout(resolve, 30))
    try {
      let indexTime = jsIndexMs
      if (!fuseJs.current) {
        const started = performance.now()
        fuseJs.current = new FuseJs(cards, OPTIONS as never)
        indexTime = performance.now() - started
        setJsIndexMs(indexTime)
      }
      const started = performance.now()
      fuseJs.current.search(query, { limit: 12 })
      setJsSearchMs(performance.now() - started)
    } catch (cause) {
      setJsError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setComparing(false)
    }
  }

  return (
    <main className="mx-auto grid min-h-screen max-w-6xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[320px_minmax(0,1fr)] lg:py-12">
      <header className="lg:sticky lg:top-8 lg:self-start">
        <p className="text-xs font-semibold tracking-[0.22em] text-primary uppercase">Reading room</p>
        <h1 className="mt-2 font-serif text-4xl leading-tight font-medium text-balance sm:text-5xl">Card Catalog</h1>
        <p className="mt-4 max-w-prose text-base leading-relaxed text-muted-foreground">
          {count.toLocaleString()} generated books, indexed in a Web Worker by fuse-wasm. Typing stays on this
          thread. Misspellings still find the card.
        </p>

        <label className="mt-6 block text-sm font-semibold" htmlFor="catalog-query">
          Search titles and authors
        </label>
        <div className="relative mt-2">
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          >
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M16 16.5 20 20.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <Input
            id="catalog-query"
            className="pl-9"
            placeholder="old man, hemingway, cafe"
            value={query}
            autoComplete="off"
            onChange={(event) => search(event.target.value)}
          />
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-md border border-border bg-card px-3 py-2">
            <dt className="text-muted-foreground">Index</dt>
            <dd className="font-serif text-2xl">{status === 'loading' ? '…' : formatMs(indexMs)}</dd>
          </div>
          <div className="rounded-md border border-border bg-card px-3 py-2">
            <dt className="text-muted-foreground">Last query</dt>
            <dd className="font-serif text-2xl">{formatMs(elapsedMs)}</dd>
          </div>
          <div className="rounded-md border border-border bg-card px-3 py-2">
            <dt className="text-muted-foreground">Fuse.js index</dt>
            <dd className="font-serif text-2xl">{formatMs(jsIndexMs)}</dd>
          </div>
          <div className="rounded-md border border-border bg-card px-3 py-2">
            <dt className="text-muted-foreground">Fuse.js query</dt>
            <dd className="font-serif text-2xl">{comparing ? '…' : formatMs(jsSearchMs)}</dd>
          </div>
        </dl>

        <Button className="mt-4 w-full" variant="outline" disabled={!query.trim() || status !== 'ready' || comparing} onClick={() => void compare()}>
          {comparing ? 'Timing Fuse.js…' : 'Time the same query in Fuse.js'}
        </Button>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Fuse.js runs on the main thread, on purpose. The catalog search does not. Threshold 0.35, diacritics ignored,
          twelve cards kept.
        </p>
        {jsError ? <p className="mt-2 text-sm text-primary">{jsError}</p> : null}
      </header>

      <section aria-live="polite">
        {status === 'loading' ? (
          <div className="rounded-lg border border-dashed border-border bg-card/70 px-5 py-16 text-center">
            <p className="font-serif text-2xl">Building the catalog index…</p>
            <p className="mt-2 text-muted-foreground">Extracting titles and author names for {count.toLocaleString()} cards.</p>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className="rounded-lg border border-primary/40 bg-card px-5 py-10">
            <p className="font-serif text-2xl text-primary">The index did not come up.</p>
            <p className="mt-2 text-muted-foreground">{error?.message}</p>
          </div>
        ) : null}

        {status === 'ready' && !query.trim() ? (
          <div className="rounded-lg border border-border bg-card px-5 py-10">
            <p className="font-serif text-2xl">The drawer is closed.</p>
            <p className="mt-2 max-w-prose text-muted-foreground">
              Try <span className="text-foreground">old man</span>, <span className="text-foreground">hemingway</span>, or{' '}
              <span className="text-foreground">cafe</span>. Accented cards still match.
            </p>
          </div>
        ) : null}

        {status === 'ready' && query.trim() && results.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-5 py-10">
            <p className="font-serif text-2xl">Nothing in the stacks is close enough.</p>
            <p className="mt-2 text-muted-foreground">Widen the spelling, or search a last name.</p>
          </div>
        ) : null}

        {status === 'ready' && results.length > 0 ? (
          <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {results.map((result) => {
              const titleMatch = result.matches?.find((match) => match.key === 'title')
              const author = `${result.item.author.firstName} ${result.item.author.lastName}`
              return (
                <li key={result.item.id} className="grid gap-1 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline">
                  <div>
                    <p className="font-serif text-xl leading-snug">
                      <Highlight text={result.item.title} indices={titleMatch?.indices} />
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {author} · {result.item.year}
                      {result.matches?.some((match) => match.key?.startsWith('author')) ? ' · author match' : ''}
                    </p>
                  </div>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {result.score == null ? '' : `score ${result.score.toFixed(4)}`}
                  </p>
                </li>
              )
            })}
          </ol>
        ) : null}
      </section>
    </main>
  )
}

export function App() {
  return <Catalog />
}
