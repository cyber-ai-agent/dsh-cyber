import { describe, expect, it, vi } from 'vitest'

import { ResourceCache } from '../src/features/world/avatar/vrm/VrmResourceManager.js'

describe('ResourceCache', () => {
  it('loads once however many holders ask', async () => {
    const load = vi.fn(async () => 'model')
    const cache = new ResourceCache<string>()
    const [first, second] = await Promise.all([
      cache.acquire('a', load, () => {}),
      cache.acquire('a', load, () => {}),
    ])
    // A room where five characters share a base avatar downloaded and parsed
    // it five times before this existed.
    expect(load).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
    expect(cache.users('a')).toBe(2)
  })

  it('shares one in-flight load rather than racing', async () => {
    let resolve: ((value: string) => void) | undefined
    const load = vi.fn(() => new Promise<string>((settle) => { resolve = settle }))
    const cache = new ResourceCache<string>()
    const pending = [cache.acquire('a', load, () => {}), cache.acquire('a', load, () => {})]
    // Characters appear together on a world's first paint; asking twice while
    // the first request is open must not start a second one.
    expect(load).toHaveBeenCalledTimes(1)
    resolve?.('model')
    expect(await Promise.all(pending)).toEqual(['model', 'model'])
  })

  it('frees only once the last holder lets go', async () => {
    const release = vi.fn()
    const cache = new ResourceCache<string>()
    await cache.acquire('a', async () => 'model', release)
    await cache.acquire('a', async () => 'model', release)

    cache.release('a')
    await Promise.resolve()
    // Freeing a shared model when the first character leaves would empty
    // everybody else.
    expect(release).not.toHaveBeenCalled()

    cache.release('a')
    await Promise.resolve()
    expect(release).toHaveBeenCalledTimes(1)
    expect(cache.size).toBe(0)
  })

  it('reloads after everyone has let go', async () => {
    const load = vi.fn(async () => 'model')
    const cache = new ResourceCache<string>()
    await cache.acquire('a', load, () => {})
    cache.release('a')
    await cache.acquire('a', load, () => {})
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not remember a failure as a shared resource', async () => {
    const cache = new ResourceCache<string>()
    const failing = cache.acquire('a', async () => { throw new Error('offline') }, () => {})
    await expect(failing).rejects.toThrow('offline')
    await Promise.resolve()
    // Caching the rejection would hand the same failure to every character
    // that ever asks for this avatar again.
    expect(cache.size).toBe(0)
    await expect(cache.acquire('a', async () => 'model', () => {})).resolves.toBe('model')
  })

  it('keeps separate keys apart', async () => {
    const cache = new ResourceCache<string>()
    await cache.acquire('a', async () => 'one', () => {})
    await cache.acquire('b', async () => 'two', () => {})
    expect(cache.size).toBe(2)
    expect(cache.users('a')).toBe(1)
  })

  it('ignores a release nobody holds', () => {
    const cache = new ResourceCache<string>()
    expect(() => cache.release('missing')).not.toThrow()
  })

  it('frees everything on clear', async () => {
    const release = vi.fn()
    const cache = new ResourceCache<string>()
    await cache.acquire('a', async () => 'one', release)
    await cache.acquire('b', async () => 'two', release)
    cache.clear()
    await Promise.resolve()
    expect(release).toHaveBeenCalledTimes(2)
    expect(cache.size).toBe(0)
  })
})
