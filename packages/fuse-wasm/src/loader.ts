export const NOT_READY =
  'fuse-wasm: WebAssembly is not loaded. Call `await init()` before search(). This is the one API difference from Fuse.js.'

type Glue = typeof import('../pkg/fuse_engine.js')

let glue: Glue | null = null
let pending: Promise<void> | null = null
const waiters: Array<() => void> = []

export function wasmReady(): boolean {
  return glue != null
}

export function engineModule(): Glue {
  if (!glue) throw new Error(NOT_READY)
  return glue
}

export function whenReady(mount: () => void): void {
  if (glue) mount()
  else waiters.push(mount)
}

/**
 * Load the WASM engine. Pass `wasmUrl` to self-host the `.wasm` file.
 * Safe to call more than once.
 */
export async function init(wasmUrl?: string): Promise<void> {
  if (glue) return
  if (!pending) {
    pending = (async () => {
      const url = new URL('../pkg/fuse_engine.js', import.meta.url)
      const loaded = (await import(/* @vite-ignore */ url.href)) as Glue
      if (wasmUrl) {
        await loaded.default(wasmUrl)
      } else {
        await loaded.default(await wasmBytes())
      }
      glue = loaded
      for (const mount of waiters) mount()
      waiters.length = 0
    })()
  }
  try {
    await pending
  } catch (error) {
    pending = null
    throw error
  }
}

/**
 * A module worker has `fetch` and no `window`. Treating "no window" as Node
 * made the worker import `node:fs`, which the browser cannot load.
 */
function useFetch(): boolean {
  return typeof window !== 'undefined' || 'WorkerGlobalScope' in globalThis
}

async function wasmBytes(): Promise<Uint8Array> {
  const url = new URL('../pkg/fuse_engine_bg.wasm', import.meta.url)
  if (!useFetch()) {
    const specifier = 'node:' + 'fs/promises'
    const { readFile } = (await import(/* @vite-ignore */ specifier)) as {
      readFile(path: URL): Promise<{ buffer: ArrayBuffer; byteOffset: number; byteLength: number }>
    }
    const buf = await readFile(url)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`fuse-wasm: failed to fetch ${url.href} (${response.status})`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

export function simdEnabled(): boolean {
  return glue?.simd_enabled() ?? false
}
