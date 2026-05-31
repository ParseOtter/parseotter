# ParseOtter MCP Server

[![npm version](https://img.shields.io/npm/v/@parseotter/mcp-server.svg)](https://www.npmjs.com/package/@parseotter/mcp-server)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](../../LICENSE)

An MCP (Model Context Protocol) server for converting PDF and EPUB documents to Markdown using the [ParseOtter](https://www.parseotter.com/) conversion service.

## Features

- **Convert PDF/EPUB to Markdown**: Upload and convert documents with a single tool call
- **High-quality conversion**: Uses advanced ML models (marker-pdf) for accurate text extraction
- **Image extraction**: Extract and embed images from documents
- **OCR support**: Optional OCR for scanned documents
- **Page range selection**: Convert specific pages or the entire document
- **Progress reporting**: Real-time conversion progress updates via MCP logging
- **Automatic retries**: Exponential backoff for rate limits and transient errors
- **Flexible configuration**: Customizable timeouts, retries, and API endpoints

## Quick Start

### 1. Get an API Key

1. Visit [ParseOtter Settings](https://www.parseotter.com/settings/api-keys)
2. Create a new API key
3. Copy the key (starts with `ak_`)

### 2. Configure Your AI Agent

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "parseotter": {
      "command": "npx",
      "args": ["-y", "@parseotter/mcp-server"],
      "env": {
        "PARSEOTTER_API_KEY": "ak_your_api_key_here"
      }
    }
  }
}
```

#### Claude Code

```bash
claude mcp add parseotter -e PARSEOTTER_API_KEY=ak_your_api_key_here -- npx -y @parseotter/mcp-server
```

#### Cursor

Edit `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "parseotter": {
      "command": "npx",
      "args": ["-y", "@parseotter/mcp-server"],
      "env": {
        "PARSEOTTER_API_KEY": "ak_your_api_key_here"
      }
    }
  }
}
```

#### VS Code (GitHub Copilot)

Edit `.vscode/mcp.json`:

```json
{
  "mcp": {
    "servers": {
      "parseotter": {
        "command": "npx",
        "args": ["-y", "@parseotter/mcp-server"],
        "env": {
          "PARSEOTTER_API_KEY": "ak_your_api_key_here"
        }
      }
    }
  }
}
```

### 3. Start Converting

In your AI agent, simply ask:

```
Convert this PDF to markdown: /path/to/document.pdf
```

## Available Tools

### `convert_document`

Convert a PDF or EPUB document to Markdown format. This is an all-in-one tool that handles the entire conversion flow.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Absolute path to the PDF or EPUB file |
| `page_range` | string | No | Page range to convert (e.g., "1-5", "1,3,5-7") |
| `force_ocr` | boolean | No | Force OCR processing (default: false) |

**Example Response:**

```json
{
  "success": true,
  "task_id": "task_xxx",
  "markdown": "# Document Title\n\n...",
  "metadata": {
    "pages": 10,
    "processing_time_ms": 5234
  }
}
```

### `check_conversion_status`

Check the status of a conversion task. Useful for monitoring long-running conversions.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | The task ID returned by `convert_document` |

**Example Response:**

```json
{
  "taskId": "task_xxx",
  "status": "succeeded"
}
```

### `get_conversion_result`

Download the result of a completed conversion task.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | The task ID of a completed conversion |

**Example Response:**

```json
{
  "success": true,
  "task_id": "task_xxx",
  "markdown": "# Document Title\n\n...",
  "metadata": {
    "pages": 10,
    "processing_time_ms": 5234
  }
}
```

## Usage Examples

### Basic Conversion

```
Convert this PDF to markdown: /home/user/documents/report.pdf
```

### Convert Specific Pages

```
Convert pages 1-5 of this document: /home/user/documents/large-report.pdf
```

### Force OCR for Scanned Documents

```
This is a scanned PDF, please use OCR: /home/user/documents/scanned-contract.pdf
```

### Batch Conversion

```
Convert all PDFs in the /home/user/documents/ folder to markdown
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PARSEOTTER_API_KEY` | Yes | - | Your ParseOtter API key (starts with `ak_`) |
| `PARSEOTTER_API_BASE_URL` | No | `https://api.parseotter.com` | API endpoint URL |
| `PARSEOTTER_TIMEOUT_MS` | No | `300000` (5 min) | Conversion timeout in milliseconds |
| `PARSEOTTER_MAX_RETRIES` | No | `3` | Maximum retry attempts for failed requests |
| `PARSEOTTER_RETRY_DELAY_MS` | No | `1000` (1 sec) | Base delay between retries (exponential backoff) |

### Advanced Configuration

For custom deployments or testing, you can override the API endpoint:

```json
{
  "mcpServers": {
    "parseotter": {
      "command": "npx",
      "args": ["-y", "@parseotter/mcp-server"],
      "env": {
        "PARSEOTTER_API_KEY": "ak_your_api_key_here",
        "PARSEOTTER_API_BASE_URL": "https://your-custom-api.example.com",
        "PARSEOTTER_TIMEOUT_MS": "600000",
        "PARSEOTTER_MAX_RETRIES": "5"
      }
    }
  }
}
```

## Troubleshooting

### Common Errors

#### "PARSEOTTER_API_KEY environment variable is required"

Make sure you've set the API key in your MCP server configuration. See the [Configuration](#configuration) section.

#### "Invalid API key format"

API keys must start with `ak_`. Check that you copied the full key correctly.

#### "File not found"

Ensure the file path is absolute and the file exists. The MCP server runs locally and needs access to the file system.

#### "Conversion timed out"

Large documents may take longer to process. Try:
1. Convert a smaller page range first
2. Increase `PARSEOTTER_TIMEOUT_MS` in your configuration
3. Check your network connection

#### "Unsupported file type"

Only PDF and EPUB files are supported. Check the file extension.

#### "Rate limit exceeded"

The API has rate limits. The server will automatically retry with exponential backoff. If you continue to see this error:
1. Wait a few minutes before trying again
2. Reduce the frequency of conversion requests
3. Check your API plan limits

### Debug Mode

To see detailed logs, run the MCP server directly:

```bash
PARSEOTTER_API_KEY=ak_xxx node /path/to/build/index.js
```

Logs will be written to stderr.

## Development

### Prerequisites

- Node.js 18 or later
- npm or yarn

### Build

```bash
cd mcp-server
npm install
npm run build
```

### Run Locally

```bash
PARSEOTTER_API_KEY=ak_xxx npm start
```

### Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node build/index.js
```

### Project Structure

```
mcp-server/
├── src/
│   ├── index.ts          # Entry point (stdio transport)
│   ├── server.ts         # MCP server setup and tool registration
│   ├── client.ts         # ParseOtter API client with retry logic
│   ├── config.ts         # Configuration management
│   └── types.ts          # TypeScript type definitions
├── build/                # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
└── README.md
```

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.

## License

AGPL-3.0 - See [LICENSE](../../LICENSE) for details.

## Support

- **Documentation**: [https://www.parseotter.com/docs](https://www.parseotter.com/docs)
- **Issues**: [GitHub Issues](https://github.com/showgp/marker-modal-pdf-to-markdown-oss/issues)
- **Email**: support@parseotter.com
