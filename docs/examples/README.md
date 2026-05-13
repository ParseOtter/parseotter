# Public Conversion Examples

These examples use public source documents to show the complete Markdown output ParseOtter produces for representative PDF and EPUB inputs.

The repository does not include the original source files or generated ZIP artifacts. Each example records the source page, rights signal, conversion summary, ZIP shape, complete converted Markdown, and extracted images.

| Example | Input | What it shows | Notes |
| --- | --- | --- | --- |
| [USGS Crater Lake fact sheet](usgs-crater-lake/README.md) | PDF, 2 pages | Image-rich public-domain fact sheet | Best compact PDF example |
| [NOAA extreme weather report](noaa-extreme-weather/README.md) | PDF, 18 pages | Technical report with sections, lists, references, and figures | Complete output includes source-layout artifacts |
| [Standard Ebooks The Time Machine](standardebooks-time-machine/README.md) | EPUB | Chapter prose, EPUB links, and extracted assets | EPUB internal links are sanitized to relative paths |

## Files

Each example directory uses the same structure:

- `source.md`: source URL, rights notes, and input metadata.
- `output.md`: complete converted Markdown output, copied from the generated ZIP's `raw.md` entry.
- `images/`: complete extracted image set referenced by `output.md`.
- `zip-contents.txt`: generated ZIP file listing.

## Verification

These complete outputs were verified on 2026-05-13 with the deployed ParseOtter Modal converter using production-equivalent free output options:

```json
{
  "page_range": "",
  "force_ocr": false,
  "paginate_output": false,
  "output_image_format": "JPEG",
  "output_profile": "parseotter_free_v1"
}
```

Conversion quality depends on the source layout and upstream `marker-pdf` behavior. These examples are representative outputs, not a fixed benchmark suite.
