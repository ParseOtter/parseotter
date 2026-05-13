# Standard Ebooks The Time Machine

This example verifies EPUB conversion and EPUB internal link sanitization.

## Files

- [source.md](source.md): source URL, rights notes, and input metadata.
- [output-preview.md](output-preview.md): short excerpt from the converted Markdown.
- [zip-contents.txt](zip-contents.txt): generated ZIP file listing.

## Conversion Summary

- Input type: EPUB
- Source size: 483,336 bytes
- Rendered page count reported by converter: 42
- Converted Markdown: 185,297 bytes
- Result ZIP: 110,080 bytes
- Extracted images: 4 JPEG files
- Runtime metadata: H100, `marker-pdf`, `pdftext_workers=4`

The converted output preserves prose, chapter markers, endnotes, and table-of-contents links. EPUB internal links are rewritten from runtime file URIs to relative paths such as `endnotes.xhtml#note-1` and `text/titlepage.xhtml`.

The output starts directly with prose rather than a clean title heading, so public previews should use curated excerpts.
