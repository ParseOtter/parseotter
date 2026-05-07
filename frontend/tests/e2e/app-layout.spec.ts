import { expect, test, type Page } from '@playwright/test'

const PARSEOTTER_TASKS_STORAGE_KEY = 'parseotter.tasks.v1'
const TEST_FILES = [
  'tests/fixtures/fundamentals-software-engineering.epub',
  'tests/fixtures/product-minded-engineer.epub',
  'tests/fixtures/mvp-development-entrepreneurs.epub',
]

type MockTaskResponseInput = {
  taskId: string
  fileName: string
  fileSizeBytes: number
  status: string
  visibleStatus: string
  updatedAt?: string
  outputSizeBytes?: number | null
  dispatchStartedAt?: string | null
  dispatchCompletedAt?: string | null
}

function createSuccessEnvelope(data: unknown): string {
  return JSON.stringify({
    success: true,
    data,
    error: null,
  })
}

function createMockTaskResponse(input: MockTaskResponseInput) {
  const isCompleted = input.status === 'succeeded'
  const isProcessing = input.status === 'processing'

  return {
    taskId: input.taskId,
    status: input.status,
    visibleStatus: input.visibleStatus,
    version: 1,
    attempt: 0,
    createdAt: '2026-04-25T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-04-26T00:00:00.000Z',
    expiresAt: '2099-04-28T00:00:00.000Z',
    expiredAt: null,
    error: null,
    file: {
      name: input.fileName,
      type: 'application/epub+zip',
      sizeBytes: input.fileSizeBytes,
    },
    upload: {
      uploadId: isProcessing || isCompleted ? `upload_${input.taskId}` : null,
      status: isProcessing || isCompleted ? 'completed' : null,
      inputObjectKey: isProcessing || isCompleted ? `parseotter/${input.taskId}/input/original.epub` : null,
      inputSizeBytes: isProcessing || isCompleted ? input.fileSizeBytes : null,
      inputEtag: isProcessing || isCompleted ? 'etag-1' : null,
      inputContentType: isProcessing || isCompleted ? 'application/epub+zip' : null,
      inputPartCount: isProcessing || isCompleted ? 1 : null,
      inputChecksumSha256: null,
    },
    output: {
      objectKey: isCompleted ? `parseotter/${input.taskId}/output/result.zip` : null,
      contentType: isCompleted ? 'application/zip' : null,
      sizeBytes: input.outputSizeBytes ?? null,
    },
    dispatch: {
      status: isCompleted ? 'completed' : isProcessing ? 'processing' : null,
      attempt: isCompleted || isProcessing ? 1 : 0,
      idempotencyKey: null,
      startedAt: input.dispatchStartedAt ?? (isProcessing || isCompleted ? '2026-04-25T00:05:00.000Z' : null),
      completedAt: input.dispatchCompletedAt ?? (isCompleted ? '2026-04-25T00:09:00.000Z' : null),
      lastCallbackIdempotencyKey: null,
    },
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }))

  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1)
}

async function expectRowSectionsNotOverlapping(
  page: Page,
  rowSelector: string,
  firstSelector: string,
  secondSelector: string
): Promise<void> {
  const rows = page.locator(rowSelector)
  const rowCount = await rows.count()

  for (let index = 0; index < rowCount; index += 1) {
    const layout = await rows.nth(index).evaluate(
      (row: Element, selectors: { firstSelector: string; secondSelector: string }) => {
        const first = row.querySelector(selectors.firstSelector)
        const second = row.querySelector(selectors.secondSelector)
        if (!first || !second) {
          return null
        }

        const firstRect = first.getBoundingClientRect()
        const secondRect = second.getBoundingClientRect()
        const overlaps = !(
          firstRect.right <= secondRect.left ||
          secondRect.right <= firstRect.left ||
          firstRect.bottom <= secondRect.top ||
          secondRect.bottom <= firstRect.top
        )

        return {
          overlaps,
          rowScrollWidth: row.scrollWidth,
          rowClientWidth: row.clientWidth,
        }
      },
      { firstSelector, secondSelector }
    )

    if (!layout) {
      continue
    }

    expect(layout.overlaps).toBe(false)
    expect(layout.rowScrollWidth).toBeLessThanOrEqual(layout.rowClientWidth + 1)
  }
}

test('keeps the upload entry fixed when selected files are visible', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByText('Your recent conversions will appear here for 48 hours on this device.')).toBeVisible()

  await page.getByLabel('Choose PDF or EPUB files').setInputFiles(TEST_FILES.slice(0, 2))

  await expect(page.getByRole('group', { name: 'Upload PDF or EPUB files' })).toContainText('Drag and drop files here')
  await expect(page.getByRole('group', { name: 'Upload PDF or EPUB files' })).toContainText('Choose Files')
  await expect(page.getByRole('region', { name: 'Selected files' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Selected files' })).toContainText('2 ready')
  await expect(page.getByRole('heading', { name: 'Files', exact: true })).toBeVisible()

  await expectNoHorizontalOverflow(page)
  await expectRowSectionsNotOverlapping(page, '.selected-file-row', '.selected-file-copy', '.selected-file-actions')
})

test('keeps uploading, processing, and completed rows scannable across viewports', async ({ page }) => {
  const processingTask = createMockTaskResponse({
    taskId: 'task_processing_saved',
    fileName: 'processing-saved.epub',
    fileSizeBytes: 3_250_000,
    status: 'processing',
    visibleStatus: 'Converting',
  })
  const completedTask = createMockTaskResponse({
    taskId: 'task_completed_saved',
    fileName: 'completed-saved.epub',
    fileSizeBytes: 4_100_000,
    status: 'succeeded',
    visibleStatus: 'Conversion complete',
    outputSizeBytes: 980_000,
  })
  const storedTasks = [
    {
      taskId: processingTask.taskId,
      fileName: processingTask.file.name,
      createdAt: processingTask.createdAt,
      updatedAt: processingTask.updatedAt,
      expiresAt: processingTask.expiresAt,
      fileSizeBytes: processingTask.file.sizeBytes,
      dispatchStartedAt: processingTask.dispatch.startedAt,
    },
    {
      taskId: completedTask.taskId,
      fileName: completedTask.file.name,
      createdAt: completedTask.createdAt,
      updatedAt: completedTask.updatedAt,
      expiresAt: completedTask.expiresAt,
      fileSizeBytes: completedTask.file.sizeBytes,
      outputSizeBytes: completedTask.output.sizeBytes,
      dispatchStartedAt: completedTask.dispatch.startedAt,
      dispatchCompletedAt: completedTask.dispatch.completedAt,
    },
  ]

  await page.addInitScript(
    ({ storageKey, tasks }: { storageKey: string; tasks: typeof storedTasks }) => {
      window.localStorage.setItem(storageKey, JSON.stringify(tasks))
    },
    {
      storageKey: PARSEOTTER_TASKS_STORAGE_KEY,
      tasks: storedTasks,
    }
  )

  await page.route('http://localhost:8787/api/tasks/task_processing_saved', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: createSuccessEnvelope(processingTask),
    })
  })

  await page.route('http://localhost:8787/api/tasks/task_completed_saved', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: createSuccessEnvelope(completedTask),
    })
  })

  let createdTaskCount = 0
  const releasePartSignRequests: Array<() => void> = []

  await page.route('http://localhost:8787/api/tasks', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') {
      await route.fallback()
      return
    }

    createdTaskCount += 1
    const body = request.postDataJSON() as {
      fileName: string
      fileSizeBytes: number
    }
    const createdTask = createMockTaskResponse({
      taskId: `task_upload_${createdTaskCount}`,
      fileName: body.fileName,
      fileSizeBytes: body.fileSizeBytes,
      status: 'created',
      visibleStatus: 'Waiting for upload',
    })

    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: createSuccessEnvelope(createdTask),
    })
  })

  await page.route(/http:\/\/localhost:8787\/api\/tasks\/task_upload_\d+\/uploads$/, async (route) => {
    const taskId = route.request().url().split('/')[5]
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: createSuccessEnvelope({
        taskId,
        uploadId: `upload_${taskId}`,
        status: 'pending',
        partSizeBytes: 5 * 1024 * 1024,
        partCount: 1,
        presignedUrlTtlSeconds: 900,
      }),
    })
  })

  await page.route(/http:\/\/localhost:8787\/api\/tasks\/task_upload_\d+\/uploads\/upload_task_upload_\d+\/parts\/sign$/, async (route) => {
    const taskId = route.request().url().split('/')[5]
    await new Promise<void>((resolve) => {
      releasePartSignRequests.push(resolve)
    })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: createSuccessEnvelope({
        taskId,
        uploadId: `upload_${taskId}`,
        parts: [
          {
            partNumber: 1,
            url: `https://r2.test/${taskId}/part-1`,
          },
        ],
      }),
    })
  })

  await page.route(/https:\/\/r2\.test\/task_upload_\d+\/part-1$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        ETag: 'etag-1',
      },
      body: '',
    })
  })

  await page.route(/http:\/\/localhost:8787\/api\/tasks\/task_upload_\d+\/uploads\/upload_task_upload_\d+\/complete$/, async (route) => {
    const taskId = route.request().url().split('/')[5]
    const completedUploadTask = createMockTaskResponse({
      taskId,
      fileName: `${taskId}.epub`,
      fileSizeBytes: 3_000_000,
      status: 'processing',
      visibleStatus: 'Converting',
    })

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: createSuccessEnvelope(completedUploadTask),
    })
  })

  await page.goto('/')

  await page.getByLabel('Choose PDF or EPUB files').setInputFiles(TEST_FILES)
  await page.getByRole('button', { name: 'Start processing' }).click()

  await expect(page.getByRole('group', { name: 'Uploading tasks' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Uploading tasks' })).toContainText('Uploading 0%')
  await expect(page.getByRole('group', { name: 'Uploading tasks' })).toContainText('Waiting to upload')
  await expect(page.getByRole('group', { name: 'Processing tasks' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Results tasks' })).toBeVisible()
  await expect.poll(() => releasePartSignRequests.length).toBe(2)

  await expectNoHorizontalOverflow(page)
  await expectRowSectionsNotOverlapping(page, '.task-row', '.task-file', '.task-actions')

  for (const release of releasePartSignRequests) {
    release()
  }
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('keeps feedback and preview dialogs usable across viewports', async ({ page }) => {
  const completedTask = createMockTaskResponse({
    taskId: 'task_completed_preview',
    fileName: 'completed-preview.epub',
    fileSizeBytes: 4_100_000,
    status: 'succeeded',
    visibleStatus: 'Conversion complete',
    outputSizeBytes: 980_000,
  })
  const storedTasks = [
    {
      taskId: completedTask.taskId,
      fileName: completedTask.file.name,
      createdAt: completedTask.createdAt,
      updatedAt: completedTask.updatedAt,
      expiresAt: completedTask.expiresAt,
      fileSizeBytes: completedTask.file.sizeBytes,
      outputSizeBytes: completedTask.output.sizeBytes,
      dispatchStartedAt: completedTask.dispatch.startedAt,
      dispatchCompletedAt: completedTask.dispatch.completedAt,
    },
  ]

  await page.addInitScript(
    ({ storageKey, tasks }: { storageKey: string; tasks: typeof storedTasks }) => {
      window.localStorage.setItem(storageKey, JSON.stringify(tasks))
    },
    {
      storageKey: PARSEOTTER_TASKS_STORAGE_KEY,
      tasks: storedTasks,
    }
  )

  await page.route('http://localhost:8787/api/tasks/task_completed_preview', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: createSuccessEnvelope(completedTask),
    })
  })

  await page.route('http://localhost:8787/api/tasks/task_completed_preview/download', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: createSuccessEnvelope({
        taskId: completedTask.taskId,
        url: 'https://r2.test/preview-result.zip',
        expiresInSeconds: 900,
      }),
    })
  })

  await page.route('https://r2.test/preview-result.zip', async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-length': String(51 * 1024 * 1024),
      },
      body: '',
    })
  })

  await page.goto('/')

  await page.getByRole('button', { name: 'Feedback' }).click()
  await expect(page.getByRole('dialog', { name: 'Send feedback' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Send feedback' })).toBeHidden()

  await page.getByRole('button', { name: /Preview converted Markdown/ }).click()
  await expect(page.getByRole('dialog', { name: /Preview completed-preview\.epub/ })).toBeVisible()
  await expect(page.getByText('File is too large to preview. Please download instead.')).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: /Preview completed-preview\.epub/ })).toBeHidden()

  await page.unrouteAll({ behavior: 'ignoreErrors' })
})
