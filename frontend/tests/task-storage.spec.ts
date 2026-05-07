import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadStoredTasks, saveStoredTask, PARSEOTTER_TASKS_STORAGE_KEY } from '../src/task-storage'

describe('task storage', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stores task ids locally and removes entries after their 48 hour expiry', () => {
    saveStoredTask({
      taskId: 'task_recent123456789012345678901234',
      fileName: 'recent.pdf',
      createdAt: '2026-04-25T00:00:00.000Z',
      expiresAt: '2026-04-27T00:00:00.000Z',
      fileSizeBytes: 2048,
      outputSizeBytes: 8192,
    })

    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        ...loadStoredTasks({ now: new Date('2026-04-26T00:00:00.000Z') }),
        {
          taskId: 'task_expired12345678901234567890123',
          fileName: 'expired.pdf',
          createdAt: '2026-04-22T00:00:00.000Z',
          expiresAt: '2026-04-24T00:00:00.000Z',
          fileSizeBytes: 4096,
          outputSizeBytes: 512,
        },
      ])
    )

    expect(loadStoredTasks({ now: new Date('2026-04-26T00:00:00.000Z') })).toEqual([
      {
        taskId: 'task_recent123456789012345678901234',
        fileName: 'recent.pdf',
        createdAt: '2026-04-25T00:00:00.000Z',
        expiresAt: '2026-04-27T00:00:00.000Z',
        fileSizeBytes: 2048,
        outputSizeBytes: 8192,
      },
    ])
  })

  it('keeps older task records that do not have display metadata yet', () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: 'task_legacy123456789012345678901234',
          fileName: 'legacy.pdf',
          expiresAt: '2026-04-27T00:00:00.000Z',
        },
      ])
    )

    expect(loadStoredTasks({ now: new Date('2026-04-26T00:00:00.000Z') })).toEqual([
      {
        taskId: 'task_legacy123456789012345678901234',
        fileName: 'legacy.pdf',
        expiresAt: '2026-04-27T00:00:00.000Z',
      },
    ])
  })

  it('stores more than one recent-tasks page so pagination can show older entries', () => {
    for (let index = 1; index <= 21; index += 1) {
      saveStoredTask({
        taskId: `task_page_${String(index).padStart(2, '0')}`,
        fileName: `task-${index}.pdf`,
        createdAt: `2026-04-25T${String(index - 1).padStart(2, '0')}:00:00.000Z`,
        expiresAt: '2099-04-27T00:00:00.000Z',
        fileSizeBytes: index,
      })
    }

    const storedTasks = loadStoredTasks({ now: new Date('2026-04-26T00:00:00.000Z') })

    expect(storedTasks).toHaveLength(21)
    expect(storedTasks[0]).toMatchObject({
      taskId: 'task_page_21',
      fileName: 'task-21.pdf',
    })
    expect(storedTasks.at(-1)).toMatchObject({
      taskId: 'task_page_01',
      fileName: 'task-1.pdf',
    })
  })

  it('returns an empty task list when localStorage reads are blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('localStorage is blocked')
    })

    expect(loadStoredTasks({ now: new Date('2026-04-26T00:00:00.000Z') })).toEqual([])
  })

  it('keeps loaded tasks when expiry cleanup cannot write to localStorage', () => {
    window.localStorage.setItem(
      PARSEOTTER_TASKS_STORAGE_KEY,
      JSON.stringify([
        {
          taskId: 'task_recent123456789012345678901234',
          fileName: 'recent.pdf',
          expiresAt: '2026-04-27T00:00:00.000Z',
        },
      ])
    )
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('localStorage is full')
    })

    expect(loadStoredTasks({ now: new Date('2026-04-26T00:00:00.000Z') })).toEqual([
      {
        taskId: 'task_recent123456789012345678901234',
        fileName: 'recent.pdf',
        expiresAt: '2026-04-27T00:00:00.000Z',
      },
    ])
  })

  it('returns the next task list when saving cannot persist to localStorage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('localStorage is full')
    })

    expect(
      saveStoredTask({
        taskId: 'task_unpersisted1234567890123456789',
        fileName: 'unpersisted.pdf',
        expiresAt: '2099-04-27T00:00:00.000Z',
      })
    ).toEqual([
      {
        taskId: 'task_unpersisted1234567890123456789',
        fileName: 'unpersisted.pdf',
        expiresAt: '2099-04-27T00:00:00.000Z',
      },
    ])
  })
})
