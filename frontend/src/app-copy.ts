export const conversionLimits = {
  acceptedFormats: 'PDF, EPUB',
  maxFileSize: 'Up to 100 MB per file',
  zipOutput: 'Markdown',
  availability: 'Files are kept for up to 48 hours, then automatically deleted. Only this browser can see this list.',
} as const

export const uploadIntro = {
  title: 'Convert PDF or EPUB to Markdown',
  descriptionLines: [
    'Prepare PDFs and EPUBs for AI, documentation, or knowledge-base workflows.',
    'Get clean Markdown and extracted images as a ZIP download.',
  ],
} as const

export const filesHistoryCopy = {
  headingNote: 'Local history · kept on this device for 48 hours',
  emptyState: 'Your recent conversions will appear here for 48 hours on this device.',
} as const
