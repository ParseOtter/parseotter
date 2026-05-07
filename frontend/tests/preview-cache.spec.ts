import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createPreviewCache, type PreviewCacheEntry } from '../src/preview-cache'

function makeEntry(urls: string[] = []): PreviewCacheEntry {
  return {
    mdFiles: [{ name: 'output/report.md', content: '# Report' }],
    imageMap: new Map(urls.map((url, index) => [`image-${index}.png`, url])),
  }
}

describe('preview cache', () => {
  const mockRevokeObjectURL = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    URL.revokeObjectURL = mockRevokeObjectURL
  })

  it('stores and retrieves an entry by taskId', () => {
    const cache = createPreviewCache(10)
    const entry = makeEntry(['blob:first'])

    cache.set('task-1', entry)

    expect(cache.get('task-1')).toBe(entry)
    expect(cache.size).toBe(1)
  })

  it('returns undefined for a missing key', () => {
    const cache = createPreviewCache(10)

    expect(cache.get('missing-task')).toBeUndefined()
  })

  it('evicts the oldest entry when exceeding max entries', () => {
    const cache = createPreviewCache(2)
    const first = makeEntry(['blob:first'])
    const second = makeEntry(['blob:second'])
    const third = makeEntry(['blob:third'])

    cache.set('task-1', first)
    cache.set('task-2', second)
    cache.set('task-3', third)

    expect(cache.get('task-1')).toBeUndefined()
    expect(cache.get('task-2')).toBe(second)
    expect(cache.get('task-3')).toBe(third)
    expect(cache.size).toBe(2)
  })

  it('does not reorder an existing key on update', () => {
    const cache = createPreviewCache(2)
    const updatedFirst = makeEntry(['blob:first-updated'])
    const second = makeEntry(['blob:second'])
    const third = makeEntry(['blob:third'])

    cache.set('task-1', makeEntry(['blob:first']))
    cache.set('task-2', second)
    cache.set('task-1', updatedFirst)
    cache.set('task-3', third)

    expect(cache.get('task-1')).toBeUndefined()
    expect(cache.get('task-2')).toBe(second)
    expect(cache.get('task-3')).toBe(third)
  })

  it('revokes old blob URLs when replacing an existing entry', () => {
    const cache = createPreviewCache(10)
    const updated = makeEntry(['blob:updated'])

    cache.set('task-1', makeEntry(['blob:first-a', 'blob:first-b']))
    cache.set('task-1', updated)

    expect(cache.get('task-1')).toBe(updated)
    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(2)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:first-a')
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:first-b')
  })

  it('does not revoke blob URLs retained by a replacement entry', () => {
    const cache = createPreviewCache(10)

    cache.set('task-1', makeEntry(['blob:shared', 'blob:first']))
    cache.set('task-1', makeEntry(['blob:shared', 'blob:updated']))

    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(1)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:first')
  })

  it('revokes blob URLs of the evicted entry', () => {
    const cache = createPreviewCache(1)

    cache.set('task-1', makeEntry(['blob:first-a', 'blob:first-b']))
    cache.set('task-2', makeEntry(['blob:second']))

    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(2)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:first-a')
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:first-b')
  })

  it('revokes all blob URLs on clear', () => {
    const cache = createPreviewCache(10)

    cache.set('task-1', makeEntry(['blob:first-a', 'blob:first-b']))
    cache.set('task-2', makeEntry(['blob:second']))

    cache.clear()

    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(3)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:first-a')
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:first-b')
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:second')
    expect(cache.size).toBe(0)
  })

  it('updates an existing key without counting as a new insertion', () => {
    const cache = createPreviewCache(1)
    const updated = makeEntry(['blob:updated'])

    cache.set('task-1', makeEntry(['blob:first']))
    cache.set('task-1', updated)

    expect(cache.get('task-1')).toBe(updated)
    expect(cache.size).toBe(1)
    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(1)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:first')
  })
})
