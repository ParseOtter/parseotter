## v0.2.0 - 2026-05-31

### Added

- MCP (Model Context Protocol) server for AI agent integration (`mcp-server/`).
  Users can now convert PDF/EPUB documents to Markdown directly from AI agents
  like Claude Desktop, Claude Code, Cursor, and VS Code.

- Three MCP tools:
  - `convert_document`: Upload and convert documents with a single tool call
  - `check_conversion_status`: Monitor long-running conversions
  - `get_conversion_result`: Download completed conversion results

- High-quality document conversion using marker-pdf ML models.

- Image extraction from converted documents.

- OCR support for scanned documents.

- Page range selection for converting specific pages.

- Progress reporting via MCP logging notifications.

- Automatic retry with exponential backoff for rate limits and transient errors.

- Flexible configuration via environment variables:
  - `PARSEOTTER_API_KEY`: API key for authentication
  - `PARSEOTTER_API_BASE_URL`: Custom API endpoint
  - `PARSEOTTER_TIMEOUT_MS`: Conversion timeout
  - `PARSEOTTER_MAX_RETRIES`: Maximum retry attempts
  - `PARSEOTTER_RETRY_DELAY_MS`: Base delay between retries

### Installation

```bash
# Claude Code
claude mcp add parseotter -e PARSEOTTER_API_KEY=ak_your_key -- npx -y @parseotter/mcp-server

# Or configure manually in your AI agent's MCP settings
```

### Documentation

See [mcp-server/README.md](../mcp-server/README.md) for complete documentation.
