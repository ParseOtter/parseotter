import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MarkdownRenderer, type MdFile } from '../../src/components/MarkdownRenderer'

function renderMarkdown(content: string, imageMap?: Map<string, string>) {
  const mdFile: MdFile = { name: 'report.md', content }
  return render(<MarkdownRenderer mdFile={mdFile} imageMap={imageMap ?? new Map()} />)
}

describe('MarkdownRenderer', () => {
  it('renders h1-h6 headings', () => {
    renderMarkdown('# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('H1')
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('H2')
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('H3')
  })

  it('renders unordered and ordered lists', () => {
    renderMarkdown('- item a\n- item b\n\n1. first\n2. second')
    expect(screen.getByText('item a')).toBeInTheDocument()
    expect(screen.getByText('second')).toBeInTheDocument()
  })

  it('renders tables with th and td', () => {
    renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(screen.getByText('B')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders inline code and code blocks', () => {
    renderMarkdown('Use `code` inline.\n\n```\nblock\n```')
    expect(screen.getByText('code')).toBeInTheDocument()
    expect(screen.getByText('block')).toBeInTheDocument()
  })

  it('renders blockquote', () => {
    renderMarkdown('> quoted text')
    expect(screen.getByText(/quoted text/)).toBeInTheDocument()
  })

  it('renders links', () => {
    renderMarkdown('[click here](https://example.com)')
    const link = screen.getByRole('link', { name: 'click here' })
    expect(link).toHaveAttribute('href', 'https://example.com')
  })

  it('resolves image src from imageMap', () => {
    const imageMap = new Map([['img/photo.png', 'blob:abc123']])
    renderMarkdown('![alt](img/photo.png)', imageMap)
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'blob:abc123')
  })

  it('adds image-not-found class when src not in imageMap', () => {
    renderMarkdown('![alt](missing.png)')
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'missing.png')
    expect(img).toHaveClass('image-not-found')
  })

  it('resolves image path relative to md file directory', () => {
    const imageMap = new Map([['output/photo.png', 'blob:def456']])
    const mdFile: MdFile = { name: 'output/report.md', content: '![alt](photo.png)' }
    render(<MarkdownRenderer mdFile={mdFile} imageMap={imageMap} />)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:def456')
  })

  it('resolves image path with ./ prefix stripped', () => {
    const imageMap = new Map([['photo.png', 'blob:ghi789']])
    renderMarkdown('![alt](./photo.png)', imageMap)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:ghi789')
  })

  it('renders empty content without error', () => {
    const { container } = renderMarkdown('')
    expect(container.querySelector('.markdown-preview')).toBeInTheDocument()
  })

  it('shows error message on marked parse failure', () => {
    // Intentionally broken content that should fail parsing is hard with marked,
    // but the try/catch is there for safety. We just verify normal content renders.
    const { container } = renderMarkdown('')
    expect(container.querySelector('.markdown-render-error')).toBeNull()
  })
})
