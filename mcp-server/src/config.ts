/**
 * Configuration management for ParseOtter MCP Server
 */

import { Config, ParseOtterError } from "./types.js";

const DEFAULT_BASE_URL = "https://api.parseotter.com";
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const MIN_API_KEY_LENGTH = 20;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

/**
 * Load and validate configuration from environment variables
 */
export function loadConfig(): Config {
  const apiKey = process.env.PARSEOTTER_API_KEY;
  if (!apiKey) {
    throw new ParseOtterError(
      "PARSEOTTER_API_KEY environment variable is required. " +
        "Get your API key at https://www.parseotter.com/settings/api-keys",
      "CONFIG_ERROR",
    );
  }

  if (!apiKey.startsWith("ak_")) {
    throw new ParseOtterError(
      "Invalid API key format. API keys must start with 'ak_'",
      "CONFIG_ERROR",
    );
  }

  if (apiKey.length < MIN_API_KEY_LENGTH) {
    throw new ParseOtterError(
      "API key is too short. Please check your PARSEOTTER_API_KEY",
      "CONFIG_ERROR",
    );
  }

  const baseUrl = process.env.PARSEOTTER_API_BASE_URL || DEFAULT_BASE_URL;
  const timeoutMs = parseInt(process.env.PARSEOTTER_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  const maxRetries = parseInt(process.env.PARSEOTTER_MAX_RETRIES || String(DEFAULT_MAX_RETRIES), 10);
  const retryDelayMs = parseInt(process.env.PARSEOTTER_RETRY_DELAY_MS || String(DEFAULT_RETRY_DELAY_MS), 10);

  if (isNaN(timeoutMs) || timeoutMs < 1000) {
    throw new ParseOtterError(
      "PARSEOTTER_TIMEOUT_MS must be a number >= 1000 (1 second)",
      "CONFIG_ERROR",
    );
  }

  if (isNaN(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new ParseOtterError(
      "PARSEOTTER_MAX_RETRIES must be a number between 0 and 10",
      "CONFIG_ERROR",
    );
  }

  if (isNaN(retryDelayMs) || retryDelayMs < 100) {
    throw new ParseOtterError(
      "PARSEOTTER_RETRY_DELAY_MS must be a number >= 100 (100ms)",
      "CONFIG_ERROR",
    );
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/$/, ""), // Remove trailing slash
    timeoutMs,
    maxRetries,
    retryDelayMs,
  };
}

/**
 * Validate that a file path is allowed (basic path traversal protection)
 */
export function validateFilePath(filePath: string): void {
  if (!filePath || filePath.trim().length === 0) {
    throw new ParseOtterError("File path cannot be empty", "VALIDATION_ERROR");
  }

  // Check for path traversal attempts
  if (filePath.includes("..") || filePath.includes("~")) {
    throw new ParseOtterError(
      "File path cannot contain '..' or '~' characters",
      "VALIDATION_ERROR",
    );
  }
}

/**
 * Validate file type (PDF or EPUB only)
 */
export function validateFileType(filename: string): void {
  const lowerFilename = filename.toLowerCase();
  if (!lowerFilename.endsWith(".pdf") && !lowerFilename.endsWith(".epub")) {
    throw new ParseOtterError(
      `Unsupported file type: ${filename}. Only PDF and EPUB files are supported`,
      "VALIDATION_ERROR",
    );
  }
}
