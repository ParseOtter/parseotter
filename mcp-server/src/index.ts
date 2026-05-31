#!/usr/bin/env node

/**
 * ParseOtter MCP Server - Entry Point
 *
 * This server provides tools for converting PDF/EPUB documents to Markdown
 * using the ParseOtter conversion service.
 *
 * Usage:
 *   PARSEOTTER_API_KEY=ak_xxx node build/index.js
 *
 * Configuration:
 *   - PARSEOTTER_API_KEY (required): Your ParseOtter API key
 *   - PARSEOTTER_API_BASE_URL (optional): API endpoint (default: https://api.parseotter.com)
 *   - PARSEOTTER_TIMEOUT_MS (optional): Conversion timeout in ms (default: 300000)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import { ParseOtterError } from "./types.js";

// IMPORTANT: For stdio servers, all logging must go to stderr
// to avoid corrupting the JSON-RPC protocol on stdout
function log(message: string): void {
  process.stderr.write(`[parseotter] ${message}\n`);
}

function logError(message: string, error?: unknown): void {
  const errorDetails = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[parseotter] ERROR: ${message} - ${errorDetails}\n`);
}

async function main(): Promise<void> {
  log("Starting ParseOtter MCP Server...");

  // Validate API key early for better error messages
  if (!process.env.PARSEOTTER_API_KEY) {
    logError("PARSEOTTER_API_KEY environment variable is required");
    log("Get your API key at https://www.parseotter.com/settings/api-keys");
    process.exit(1);
  }

  // Create the MCP server
  const server = createMcpServer();
  log("MCP server created");

  // Create stdio transport
  const transport = new StdioServerTransport();
  log("Stdio transport created");

  // Connect server to transport
  await server.connect(transport);
  log("Server connected to transport");
  log("ParseOtter MCP Server is running");

  // Handle graceful shutdown
  function shutdown(signal: string): void {
    log(`Received ${signal}, shutting down...`);
    server.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Run the server
main().catch((error) => {
  logError("Fatal error", error);
  if (error instanceof ParseOtterError) {
    log(`Error code: ${error.code}`);
    if (error.statusCode) {
      log(`HTTP status: ${error.statusCode}`);
    }
  }
  process.exit(1);
});
