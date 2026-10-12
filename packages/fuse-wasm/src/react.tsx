import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { FuseWorker } from './async'
import type { FuseResult, IFuseOptions } from './index'

export type { FuseResult, IFuseOptions }

export interface UseFuseWasmOptions {
  /** Debounce before a search is sent. The worker makes this optional. */
  debounceMs?: number
  /** Maximum hits to keep. Defaults to 50. */
  limit?: number
}

export type FuseWasmStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface UseFuseWasmResult<T> {
  results: FuseResult<T>[]
  search: (query: string) => void
  query: string
  status: FuseWasmStatus
  error: Error | null
  /** Milliseconds spent on the last completed search, including the worker round trip. */
  elapsedMs: number | null
  /** Milliseconds spent building the index. */
  indexMs: number | null
}

interface FuseWasmContextValue<T> extends UseFuseWasmResult<T> {
  items?: readonly T[]
}

const FuseWasmContext = createContext<FuseWasmContextValue<unknown> | null>(null)

function useFuseWasmEngine<T>(
  items: readonly T[] | undefined,
  options: IFuseOptions<T> | undefined,
  hookOptions: UseFuseWasmOptions | undefined,
  enabled: boolean,
): UseFuseWasmResult<T> {
  const debounceMs = hookOptions?.debounceMs ?? 0
  const limit = hookOptions?.limit ?? 50
  const [results, setResults] = useState<FuseResult<T>[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<FuseWasmStatus>('idle')
  const [error, setError] = useState<Error | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [indexMs, setIndexMs] = useState<number | null>(null)
  const fuseRef = useRef<FuseWorker<T> | null>(null)
  const seq = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queryRef = useRef('')
  const runRef = useRef<(next: string) => void>(() => {})
  const optionsRef = useRef(options)
  optionsRef.current = options
  const optionKey = JSON.stringify(options ?? null, (_key, value) =>
    typeof value === 'function' ? value.toString() : value,
  )

  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined') return
    let cancelled = false
    let fuse: FuseWorker<T> | null = null
    const docs = items ?? []
    const searchOptions = optionsRef.current
    setStatus('loading')
    setError(null)
    setResults([])
    const started = performance.now()
    const pending = FuseWorker.create(docs, searchOptions)
      .then((created) => {
        if (cancelled) {
          created.terminate()
          return
        }
        fuse = created
        fuseRef.current = created
        setIndexMs(performance.now() - started)
        setStatus('ready')
        if (queryRef.current) runRef.current(queryRef.current)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause : new Error(String(cause)))
        setStatus('error')
      })
    return () => {
      cancelled = true
      seq.current += 1
      if (timer.current) clearTimeout(timer.current)
      fuse?.terminate()
      if (fuseRef.current === fuse) fuseRef.current = null
      void pending
    }
  }, [enabled, items, optionKey])

  const run = useCallback(
    (next: string) => {
      const fuse = fuseRef.current
      if (!fuse) return
      const token = ++seq.current
      const started = performance.now()
      void fuse
        .search(next, { limit })
        .then((hits) => {
          if (token !== seq.current || !hits) return
          setResults(hits)
          setElapsedMs(performance.now() - started)
          setError(null)
        })
        .catch((cause: unknown) => {
          if (token !== seq.current) return
          setError(cause instanceof Error ? cause : new Error(String(cause)))
          setStatus('error')
        })
    },
    [limit],
  )
  runRef.current = run

  const search = useCallback(
    (next: string) => {
      queryRef.current = next
      setQuery(next)
      if (timer.current) clearTimeout(timer.current)
      if (debounceMs <= 0) {
        run(next)
        return
      }
      timer.current = setTimeout(() => run(next), debounceMs)
    },
    [debounceMs, run],
  )

  return { results, search, query, status, error, elapsedMs, indexMs }
}

/**
 * Fuzzy-search `items` from a Web Worker.
 * Pass no `items` inside {@link FuseWasmProvider} to share its engine.
 * A hook whose `items` is the same reference as the provider reuses that engine.
 */
export function useFuseWasm<T>(
  items?: readonly T[],
  options?: IFuseOptions<T>,
  hookOptions?: UseFuseWasmOptions,
): UseFuseWasmResult<T> {
  const ctx = useContext(FuseWasmContext) as FuseWasmContextValue<T> | null
  const share = Boolean(ctx && (items === undefined || items === ctx.items))
  const own = useFuseWasmEngine(items, options, hookOptions, !share)
  if (share && ctx) {
    return ctx
  }
  return own
}

export interface FuseWasmProviderProps<T> {
  items: readonly T[]
  options?: IFuseOptions<T>
  hookOptions?: UseFuseWasmOptions
  children: ReactNode
}

/** Share one worker-backed engine across a subtree. */
export function FuseWasmProvider<T>({ items, options, hookOptions, children }: FuseWasmProviderProps<T>) {
  const api = useFuseWasmEngine(items, options, hookOptions, true)
  const value = useMemo(() => ({ ...api, items }), [api, items])
  return <FuseWasmContext.Provider value={value as FuseWasmContextValue<unknown>}>{children}</FuseWasmContext.Provider>
}
