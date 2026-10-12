/**
 * Module worker entry. The main thread owns the documents; this thread owns
 * the WASM engine and answers with flat result buffers.
 */
import { engineModule, init } from './loader'

type Engine = InstanceType<typeof import('../pkg/fuse_engine.js').FuseEngine>

type EngineArgs = [
  number,
  number,
  number,
  boolean,
  boolean,
  number,
  boolean,
  boolean,
  boolean,
  boolean,
]

type Inbound =
  | { id: number; type: 'mount'; wasmUrl?: string; args: EngineArgs; records: Uint8Array }
  | { id: number; type: 'search'; kind: 'text'; units: Uint16Array; limit: number; defaultSort: boolean }
  | { id: number; type: 'search'; kind: 'logical'; bytes: Uint8Array; limit: number; defaultSort: boolean }
  | { id: number; type: 'add'; record: Uint8Array }
  | { id: number; type: 'remove'; indices: Uint32Array }

let engine: Engine | null = null

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Inbound>) => void) | null
  postMessage: (data: unknown, transfer?: Transferable[]) => void
}

function reply(id: number, payload: Record<string, unknown>, transfer: Transferable[] = []): void {
  scope.postMessage({ id, ...payload }, transfer)
}

scope.onmessage = (event: MessageEvent<Inbound>) => {
  void handle(event.data)
}

async function handle(msg: Inbound): Promise<void> {
  try {
    if (msg.type === 'mount') {
      await init(msg.wasmUrl)
      const { FuseEngine } = engineModule()
      engine?.free()
      engine = new FuseEngine(...msg.args)
      engine.set_records(msg.records)
      reply(msg.id, { ok: true })
      return
    }
    if (!engine) throw new Error('fuse-wasm worker: engine is not mounted')
    if (msg.type === 'search') {
      const buf =
        msg.kind === 'text'
          ? engine.search(msg.units, msg.limit, msg.defaultSort)
          : engine.search_logical(msg.bytes, msg.limit, msg.defaultSort)
      const copy = buf.slice()
      reply(msg.id, { ok: true, buf: copy }, [copy.buffer])
      return
    }
    if (msg.type === 'add') {
      engine.add_record(msg.record)
      reply(msg.id, { ok: true })
      return
    }
    engine.remove_indices(msg.indices)
    reply(msg.id, { ok: true })
  } catch (error) {
    reply(msg.id, { error: error instanceof Error ? error.message : String(error) })
  }
}
