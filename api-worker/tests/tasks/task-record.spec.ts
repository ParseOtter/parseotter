import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createInitialTaskSnapshot,
  insertTaskSnapshot,
  persistTaskUploadSession,
} from '../../src/app/tasks/task-record'
import { resetTaskDatabase } from '../support/task-db'

describe('task record upload session persistence', () => {
  beforeEach(async () => {
    await resetTaskDatabase(env.DB)
  })

  it('reports an unpersisted upload session when the task row disappears before the conditional update', async () => {
    const snapshot = createInitialTaskSnapshot({
      taskId: 'task_abcdefghijklmnopqrstuvwxyz123456',
      fileName: 'sample.pdf',
      fileType: 'application/pdf',
      fileSizeBytes: 12345,
    })

    await insertTaskSnapshot(env.DB, snapshot)
    await env.DB.prepare('DELETE FROM parseotter_tasks WHERE task_id = ?').bind(snapshot.taskId).run()

    const result = await persistTaskUploadSession(env.DB, {
      snapshot,
      uploadId: 'upload-raced-away',
      inputObjectKey: `parseotter/${snapshot.taskId}/input/original.pdf`,
    })

    expect(result).toEqual({
      persisted: false,
      snapshot: null,
    })
  })
})