import { AppHttpError } from '../http/errors'

const PDF_SIGNATURE = new TextEncoder().encode('%PDF-')
const EPUB_LOCAL_FILE_HEADER = Uint8Array.from([0x50, 0x4b, 0x03, 0x04])
const EPUB_MIMETYPE_FILENAME = 'mimetype'
const EPUB_MIMETYPE_VALUE = 'application/epub+zip'
const AUTHENTICITY_PREFIX_BYTES = 64 * 1024
const ZIP_LOCAL_FILE_HEADER_FIXED_BYTES = 30
const ZIP_GENERAL_PURPOSE_DATA_DESCRIPTOR_FLAG = 0x08
const ZIP64_SIZE_SENTINEL = 0xffffffff

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

function readUint32LittleEndian(input: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 3 >= input.length) {
    return null
  }

  return (
    input[offset] |
    (input[offset + 1] << 8) |
    (input[offset + 2] << 16) |
    (input[offset + 3] << 24)
  ) >>> 0
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

function hasLocalFileHeaderAt(bytes: Uint8Array, offset: number): boolean {
  return EPUB_LOCAL_FILE_HEADER.every((value, index) => bytes[offset + index] === value)
}

function hasExpectedStoredSize(size: number | null): boolean {
  return size === EPUB_MIMETYPE_VALUE.length || size === ZIP64_SIZE_SENTINEL
}

function isEpubMimetypeEntry(bytes: Uint8Array, offset: number): boolean {
  if (offset + ZIP_LOCAL_FILE_HEADER_FIXED_BYTES > bytes.length) {
    return false
  }

  const generalPurposeFlag = readUint16LittleEndian(bytes, offset + 6)
  const compressionMethod = readUint16LittleEndian(bytes, offset + 8)
  const compressedSize = readUint32LittleEndian(bytes, offset + 18)
  const uncompressedSize = readUint32LittleEndian(bytes, offset + 22)
  const fileNameLength = readUint16LittleEndian(bytes, offset + 26)
  const extraFieldLength = readUint16LittleEndian(bytes, offset + 28)

  if (
    compressionMethod !== 0 ||
    fileNameLength === null ||
    extraFieldLength === null ||
    generalPurposeFlag === null
  ) {
    return false
  }

  const fileNameStart = offset + ZIP_LOCAL_FILE_HEADER_FIXED_BYTES
  const fileNameEnd = fileNameStart + fileNameLength
  const dataStart = fileNameEnd + extraFieldLength
  const dataEnd = dataStart + EPUB_MIMETYPE_VALUE.length

  if (dataEnd > bytes.length || fileNameEnd > bytes.length) {
    return false
  }

  const fileName = textDecoder.decode(bytes.slice(fileNameStart, fileNameEnd))
  if (fileName !== EPUB_MIMETYPE_FILENAME) {
    return false
  }

  const sizesAreDeferred = (generalPurposeFlag & ZIP_GENERAL_PURPOSE_DATA_DESCRIPTOR_FLAG) !== 0
  if (
    !sizesAreDeferred &&
    (!hasExpectedStoredSize(compressedSize) || !hasExpectedStoredSize(uncompressedSize))
  ) {
    return false
  }

  const mimetypeValue = textDecoder.decode(bytes.slice(dataStart, dataEnd))
  return mimetypeValue === EPUB_MIMETYPE_VALUE
}

function isAuthenticEpub(bytes: Uint8Array): boolean {
  if (!hasPrefix(bytes, EPUB_LOCAL_FILE_HEADER)) {
    return false
  }

  for (let offset = 0; offset <= bytes.length - ZIP_LOCAL_FILE_HEADER_FIXED_BYTES; offset += 1) {
    if (hasLocalFileHeaderAt(bytes, offset) && isEpubMimetypeEntry(bytes, offset)) {
      return true
    }
  }

  return false
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
