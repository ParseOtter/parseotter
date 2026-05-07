import { describe, expect, it } from 'vitest'

import { createTaskId, isValidTaskId, TASK_ID_RANDOM_BYTES } from '../../src/app/tasks/task-id'

describe('task id generation', () => {
  it('generates high-entropy URL-safe task ids with the expected prefix', () => {
    const ids = new Set(Array.from({ length: 128 }, () => createTaskId()))

    expect(TASK_ID_RANDOM_BYTES).toBeGreaterThanOrEqual(24)
    expect(ids.size).toBe(128)

    for (const taskId of ids) {
      expect(taskId).toMatch(/^task_[A-Za-z0-9_-]+$/)
      expect(taskId.length).toBeGreaterThanOrEqual('task_'.length + 32)
      expect(isValidTaskId(taskId)).toBe(true)
    }
  })

  it('rejects malformed task ids before they can be used for lookup', () => {
    expect(isValidTaskId('')).toBe(false)
    expect(isValidTaskId('task_abc')).toBe(false)
    expect(isValidTaskId('task_not/url-safe?')).toBe(false)
    expect(isValidTaskId('job_abcdefghijklmnopqrstuvwxyz123456')).toBe(false)
  })
})
