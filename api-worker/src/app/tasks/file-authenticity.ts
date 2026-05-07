import { AppHttpError } from '../http/errors'

const PDF_SIGNATURE = new TextEncoder().encode('%PDF-')
const EPUB_LOCAL_FILE_HEADER = Uint8Array.from([0x50, 0x4b, 0x03, 0x04])
const EPUB_MIMETYPE_FILENAME = 'mimetype'
const EPUB_MIMETYPE_VALUE = 'application/epub+zip'
const AUTHENTICITY_PREFIX_BYTES = 512

const textDecoder = new TextDecoder()

function hasPrefix(input: Uint8Array, prefix: Uint8Array): boolean {
  if (input.length < prefix.length) {
    return false
  }

  return prefix.every((value, index) => input[index] === value)
}

function readUint16LittleEndian(input: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 1 >= input.length) {
    return null
  }

  return input[offset] | (input[offset + 1] << 8)
}

async function readObjectPrefix(bucket: R2Bucket, objectKey: string): Promise<Uint8Array> {
  const object = await bucket.get(objectKey, {
    range: {
      offset: 0,
      length: AUTHENTICITY_PREFIX_BYTES,
    },
  })

  if (!object) {
    throw new AppHttpError({
      status: 500,
      code: 'UPLOAD_FAILED',
      message: 'Uploaded object could not be verified',
    })
  }

  return object.bytes()
}

function isAuthenticPdf(bytes: Uint8Array): boolean {
  return hasPrefix(bytes, PDF_SIGNATURE)
}

function isAuthenticEpub(bytes: Uint8Array): boolean {
  if (!hasPrefix(bytes, EPUB_LOCAL_FILE_HEADER)) {
    return false
  }

  const compressionMethod = readUint16LittleEndian(bytes, 8)
  const fileNameLength = readUint16LittleEndian(bytes, 26)
  const extraFieldLength = readUint16LittleEndian(bytes, 28)

  if (compressionMethod !== 0 || fileNameLength === null || extraFieldLength === null) {
    return false
  }

  const fileNameStart = 30
  const fileNameEnd = fileNameStart + fileNameLength
  const dataStart = fileNameEnd + extraFieldLength
  const dataEnd = dataStart + EPUB_MIMETYPE_VALUE.length

  if (dataEnd > bytes.length) {
    return false
  }

  const fileName = textDecoder.decode(bytes.slice(fileNameStart, fileNameEnd))
  if (fileName !== EPUB_MIMETYPE_FILENAME) {
    return false
  }

  const mimetypeValue = textDecoder.decode(bytes.slice(dataStart, dataEnd))
  return mimetypeValue === EPUB_MIMETYPE_VALUE
}

export async function isUploadedFileAuthentic(input: {
  bucket: R2Bucket
  objectKey: string
  fileType: string
}): Promise<boolean> {
  const prefix = await readObjectPrefix(input.bucket, input.objectKey)

  switch (input.fileType) {
    case 'application/pdf':
      return isAuthenticPdf(prefix)
    case 'application/epub+zip':
      return isAuthenticEpub(prefix)
    default:
      return false
  }
}