import { beforeAll, describe, expect, it } from 'vitest'
import { FuseWorker, init } from '../src/index'
import Fuse from '../src/index'

beforeAll(async () => {
  await init()
})

describe('FuseWorker', () => {
  it('searches like the sync API when Workers are missing', async () => {
    expect(typeof Worker).toBe('undefined')
    const docs = ['alpha', 'alpine', 'beta', 'alphabet']
    const options = { includeScore: true as const, includeMatches: true as const, threshold: 0.4 }
    const worker = await FuseWorker.create([...docs], options)
    const sync = new Fuse([...docs], options)
    expect(await worker.search('alp')).toEqual(sync.search('alp'))
    await worker.add('pal')
    sync.add('pal')
    expect(await worker.search('pal')).toEqual(sync.search('pal'))
    await worker.removeAt(0)
    sync.removeAt(0)
    expect(await worker.search('alp')).toEqual(sync.search('alp'))
    worker.terminate()
  })

  it('drops an older search when a newer one is issued', async () => {
    const docs = ['one', 'two', 'three']
    const worker = await FuseWorker.create(docs, { includeScore: true })
    const first = worker.search('one')
    const second = worker.search('two')
    const [a, b] = await Promise.all([first, second])
    expect(a).toBeNull()
    expect(b?.[0]?.item).toBe('two')
    worker.terminate()
  })
})
