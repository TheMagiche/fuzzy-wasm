import { expect, it, vi } from 'vitest'

it('search before init tells you to await init()', async () => {
  vi.resetModules()
  const { default: Fuse } = await import('../src/index')
  const fuse = new Fuse(['hello'])
  expect(() => fuse.search('hello')).toThrow(/await init\(\)/)
})
