import type { MdFile } from './components/MarkdownRenderer'

const PREVIEW_CACHE_MAX_ENTRIES = 10

// Intentional FIFO cache: taskId is the immutable result identity, so reads do not refresh eviction priority.

export interface PreviewCacheEntry {
  mdFiles: MdFile[]
  imageMap: Map<string, string>
}

function revokeImageMapUrls(imageMap: Map<string, string>, retainedUrls = new Set<string>()): void {
  for (const url of imageMap.values()) {
    if (retainedUrls.has(url)) {
      continue
    }
    URL.revokeObjectURL(url)
  }
}

export function createPreviewCache(maxEntries: number) {
  const entries = new Map<string, PreviewCacheEntry>()

  return {
    get(taskId: string): PreviewCacheEntry | undefined {
      return entries.get(taskId)
    },

    set(taskId: string, entry: PreviewCacheEntry): void {
      if (entries.has(taskId)) {
        const existingEntry = entries.get(taskId)
        if (existingEntry) {
          revokeImageMapUrls(existingEntry.imageMap, new Set(entry.imageMap.values()))
        }
        entries.set(taskId, entry)
        return
      }

      if (entries.size >= maxEntries) {
        const oldestTaskId = entries.keys().next().value
        if (oldestTaskId !== undefined) {
          const oldestEntry = entries.get(oldestTaskId)
          if (oldestEntry) {
            revokeImageMapUrls(oldestEntry.imageMap)
          }
          entries.delete(oldestTaskId)
        }
      }

      entries.set(taskId, entry)
    },

    clear(): void {
      for (const entry of entries.values()) {
        revokeImageMapUrls(entry.imageMap)
      }
      entries.clear()
    },

    get size(): number {
      return entries.size
    },
  }
}

export const previewCache = createPreviewCache(PREVIEW_CACHE_MAX_ENTRIES)
