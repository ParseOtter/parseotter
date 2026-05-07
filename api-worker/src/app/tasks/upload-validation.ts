import { AppHttpError } from '../http/errors'
import { readMaxUploadFileSizeBytes } from '../abuse/abuse-config'

export const DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES = 500 * 1024 * 1024

const FILE_EXTENSION_BY_TYPE = {
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
} as const

export type SupportedUploadFileType = keyof typeof FILE_EXTENSION_BY_TYPE

function isSupportedUploadFileType(fileType: string): fileType is SupportedUploadFileType {
  return fileType in FILE_EXTENSION_BY_TYPE
}

function formatMb(bytes: number): number {
  return Math.floor(bytes / 1024 / 1024)
}

export function validateTaskFileMetadata(
  fileType: string,
  fileSizeBytes: number,
  env?: Partial<CloudflareBindings>
): void {
  if (!isSupportedUploadFileType(fileType)) {
    throw new AppHttpError({
      status: 400,
      code: 'INVALID_FILE_TYPE',
      message: 'File type is not supported',
    })
  }

  const maxUploadFileSizeBytes = readMaxUploadFileSizeBytes(env)
  if (fileSizeBytes > maxUploadFileSizeBytes) {
    throw new AppHttpError({
      status: 413,
      code: 'FILE_TOO_LARGE',
      message: `File exceeds the ${formatMb(maxUploadFileSizeBytes)} MB limit`,
    })
  }
}

export function createInputObjectKey(taskId: string, fileType: string): string {
  if (!isSupportedUploadFileType(fileType)) {
    throw new AppHttpError({
      status: 400,
      code: 'INVALID_FILE_TYPE',
      message: 'File type is not supported',
    })
  }

  return `parseotter/${taskId}/input/original.${FILE_EXTENSION_BY_TYPE[fileType]}`
}
