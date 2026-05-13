# Public Conversion Examples

These examples use public source documents to show what ParseOtter produces for representative PDF and EPUB inputs.

The repository does not include the original source files, full converted Markdown, or full generated ZIP artifacts. Each example records the source page, rights signal, conversion summary, ZIP shape, and a short output excerpt. A few small preview images are included where they make the rendered Markdown easier to evaluate.

| Example | Input | What it shows | Notes |
| --- | --- | --- | --- |
| [USGS Crater Lake fact sheet](usgs-crater-lake/README.md) | PDF, 2 pages | Image-rich public-domain fact sheet | Best compact PDF example |
| [NOAA extreme weather report](noaa-extreme-weather/README.md) | PDF, 18 pages | Technical report with sections, lists, references, and figures | Use curated preview excerpts |
| [Standard Ebooks The Time Machine](standardebooks-time-machine/README.md) | EPUB | Chapter prose, EPUB links, and extracted assets | EPUB internal links are sanitized to relative paths |

## Verification

These examples were verified on 2026-05-13 with the deployed ParseOtter Modal converter using production-equivalent free output options:

```json
{
  "page_range": "",
  "force_ocr": false,
  "paginate_output": false,
  "output_image_format": "JPEG",
  "output_profile": "parseotter_free_v1"
}
```

Conversion quality depends on the source layout and upstream `marker-pdf` behavior. The excerpts here are documentation samples, not a fixed benchmark suite.
