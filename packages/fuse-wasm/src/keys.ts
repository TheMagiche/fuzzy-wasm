export interface KeyObject {
  path: string[]
  id: string
  /** Raw weight before KeyStore normalizes the set to sum to 1. */
  weight: number
  src: string | string[]
  getFn?: ((obj: unknown) => unknown) | null
}

export type FuseOptionKey<T> =
  | string
  | readonly string[]
  | {
      name: string | readonly string[]
      weight?: number
      getFn?: (obj: T) => readonly string[] | string | null | undefined
    }

export function createKeyPath(key: string | readonly string[]): string[] {
  return typeof key === 'string' ? key.split('.') : [...key]
}

export function createKeyId(key: string | readonly string[]): string {
  return typeof key === 'string' ? key : key.join('.')
}

export function createKey<T>(key: FuseOptionKey<T>): KeyObject {
  if (typeof key === 'string' || Array.isArray(key)) {
    const path = createKeyPath(key as string | readonly string[])
    return {
      path,
      id: createKeyId(key as string | readonly string[]),
      weight: 1,
      src: Array.isArray(key) ? [...(key as readonly string[])] : key,
      getFn: null,
    }
  }
  const spec = key as {
    name: string | readonly string[]
    weight?: number
    getFn?: (obj: T) => readonly string[] | string | null | undefined
  }
  if (!Object.prototype.hasOwnProperty.call(spec, 'name')) {
    throw new Error('Missing name property in key')
  }
  let weight = 1
  if (Object.prototype.hasOwnProperty.call(spec, 'weight') && spec.weight !== undefined) {
    weight = spec.weight
    if (weight <= 0) {
      throw new Error(`Property 'weight' in key '${createKeyId(spec.name)}' must be a positive integer`)
    }
  }
  return {
    path: createKeyPath(spec.name),
    id: createKeyId(spec.name),
    weight,
    src: typeof spec.name === 'string' ? spec.name : [...spec.name],
    getFn: spec.getFn ? (obj) => spec.getFn!(obj as T) : null,
  }
}

/** Weights are divided so they sum to 1. Scoring uses these, `toJSON` does not. */
export class KeyStore<T> {
  private readonly keys: KeyObject[]
  private readonly byId = new Map<string, KeyObject>()

  constructor(keys: readonly FuseOptionKey<T>[] = []) {
    this.keys = []
    let total = 0
    for (const key of keys) {
      const obj = createKey(key)
      this.keys.push(obj)
      this.byId.set(obj.id, obj)
      total += obj.weight
    }
    if (total) {
      for (const key of this.keys) key.weight /= total
    }
  }

  get(id: string): KeyObject | undefined {
    return this.byId.get(id)
  }

  list(): KeyObject[] {
    return this.keys
  }

  indexOf(id: string): number {
    return this.keys.findIndex((key) => key.id === id)
  }
}
