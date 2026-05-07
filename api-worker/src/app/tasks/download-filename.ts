function normalizeDownloadNameSegment(value: string): string {
  const collapsedWhitespace = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  const sanitized = collapsedWhitespace.replace(/[\\/:*?"<>|]/g, '_').replace(/_+/g, '_').trim()
  return sanitized.length > 0 ? sanitized : 'document'
}

function createAsciiFilenameFallback(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').replace(/_+/g, '_').trim()
  return ascii.length > 0 ? ascii : 'converted.zip'
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

export function createDownloadArchiveFilename(originalFileName: string): string {
  const normalizedFileName = normalizeDownloadNameSegment(originalFileName)
  const extensionIndex = normalizedFileName.lastIndexOf('.')

  if (extensionIndex <= 0 || extensionIndex === normalizedFileName.length - 1) {
    return `${normalizedFileName}_converted.zip`
  }

  const baseName = normalizeDownloadNameSegment(normalizedFileName.slice(0, extensionIndex))
  const extension = normalizeDownloadNameSegment(normalizedFileName.slice(extensionIndex + 1))

  return `${baseName}_${extension}_converted.zip`
}

export function createDownloadContentDisposition(fileName: string): string {
  const fallback = createAsciiFilenameFallback(fileName)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987Value(fileName)}`
}
