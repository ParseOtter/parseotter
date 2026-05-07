import DOMPurify from 'dompurify'
import { marked } from 'marked'
import './MarkdownRenderer.css'

export type MdFile = {
  name: string
  content: string
}

export function zipDirname(zipPath: string): string {
  const lastSlash = zipPath.lastIndexOf('/')
  return lastSlash > 0 ? zipPath.slice(0, lastSlash + 1) : ''
}

export function resolveImageSrc(
  href: string,
  mdDir: string,
  imageMap: Map<string, string>,
): string | null {
  if (imageMap.has(href)) {
    return imageMap.get(href)!
  }

  const relativePath = mdDir ? `${mdDir}${href}` : href
  if (imageMap.has(relativePath)) {
    return imageMap.get(relativePath)!
  }

  const stripped = href.replace(/^\.\//, '')
  if (stripped !== href) {
    if (imageMap.has(stripped)) {
      return imageMap.get(stripped)!
    }
    const strippedRelative = mdDir ? `${mdDir}${stripped}` : stripped
    if (imageMap.has(strippedRelative)) {
      return imageMap.get(strippedRelative)!
    }
  }

  return null
}

export function MarkdownRenderer({ mdFile, imageMap }: { mdFile: MdFile; imageMap: Map<string, string> }) {
  let html: string
  try {
    html = DOMPurify.sanitize(marked.parse(mdFile.content) as string)
  } catch {
    return <p className="markdown-render-error">Failed to render Markdown.</p>
  }

  const mdDir = zipDirname(mdFile.name)

  const withResolvedImages = html.replace(
    /(<img\s[^>]*?src\s*=\s*")([^"]*)(")/gi,
    (_full, before: string, href: string, after: string) => {
      const blobUrl = resolveImageSrc(href, mdDir, imageMap)
      if (blobUrl) {
        return `${before}${blobUrl}${after}`
      }
      return `${before}${href}${after} class="image-not-found"`
    },
  )

  return (
    <div
      className="markdown-preview"
      dangerouslySetInnerHTML={{ __html: withResolvedImages }}
    />
  )
}
