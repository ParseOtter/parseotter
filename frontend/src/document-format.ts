export type DocumentKind = 'pdf' | 'epub' | 'document'

export function getDocumentKind(input: { fileName: string; fileType?: string | null }): DocumentKind {
  const fileType = input.fileType?.toLowerCase() ?? ''
  const fileName = input.fileName.toLowerCase()

  if (fileType === 'application/pdf' || fileName.endsWith('.pdf')) {
    return 'pdf'
  }

  if (fileType.includes('epub') || fileName.endsWith('.epub')) {
    return 'epub'
  }

  return 'document'
}

export function getDocumentKindLabel(kind: DocumentKind): string {
  if (kind === 'pdf') {
    return 'PDF'
  }

  if (kind === 'epub') {
    return 'EPUB'
  }

  return 'DOC'
}
