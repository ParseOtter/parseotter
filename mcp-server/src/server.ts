/**
 * ParseOtter MCP Server
 *
 * Provides tools for converting PDF/EPUB documents to Markdown
 * using the ParseOtter conversion service.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { convertFile, checkTaskStatus, getConversionResult, ProgressCallback } from "./client.js";
import { loadConfig, validateFilePath } from "./config.js";
import { Config, ParseOtterError } from "./types.js";

// Log levels for MCP logging
type LogLevel = "debug" | "info" | "warning" | "error";

/**
 * Create and configure the MCP server
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "parseotter",
    version: "0.1.0",
  });

  // Load config lazily (only when a tool is called)
  let config: Config | null = null;

  function getConfig(): Config {
    if (!config) {
      config = loadConfig();
    }
    return config;
  }

  /**
   * Create a progress callback that sends MCP logging messages
   */
  function createProgressCallback(): ProgressCallback {
    return (stage: string, progress?: number, total?: number) => {
      const message = progress !== undefined && total !== undefined
        ? `${stage} (${progress}/${total})`
        : stage;

      // Send logging message via MCP
      server.sendLoggingMessage({
        level: "info",
        data: {
          type: "progress",
          message,
          progress,
          total,
        },
      });
    };
  }

  /**
   * Tool: convert_document
   *
   * Converts a PDF or EPUB file to Markdown using the ParseOtter service.
   * This is an all-in-one tool that handles the entire conversion flow.
   */
  server.tool(
    "convert_document",
    "Convert a PDF or EPUB document to Markdown format. Uploads the file, processes it, and returns the converted markdown content.",
    {
      file_path: z
        .string()
        .describe("Absolute path to the PDF or EPUB file to convert"),
      page_range: z
        .string()
        .optional()
        .describe("Page range to convert (e.g., '1-5', '1,3,5-7'). If not specified, converts all pages."),
      force_ocr: z
        .boolean()
        .optional()
        .describe("Force OCR processing even for digital PDFs. Default: false"),
    },
    async ({ file_path, page_range, force_ocr }) => {
      try {
        // Validate file path
        validateFilePath(file_path);

        const config = getConfig();
        const onProgress = createProgressCallback();

        const result = await convertFile(config, file_path, {
          pageRange: page_range,
          forceOcr: force_ocr,
          onProgress,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  task_id: result.taskId,
                  markdown: result.markdown,
                  metadata: result.metadata,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof ParseOtterError
            ? `${error.code}: ${error.message}`
            : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: errorMessage,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );

  /**
   * Tool: check_conversion_status
   *
   * Checks the status of an ongoing conversion task.
   * Useful for monitoring long-running conversions.
   */
  server.tool(
    "check_conversion_status",
    "Check the status of a PDF/EPUB conversion task. Use this to monitor long-running conversions.",
    {
      task_id: z.string().describe("The task ID returned by convert_document"),
    },
    async ({ task_id }) => {
      try {
        const config = getConfig();
        const result = await checkTaskStatus(config, task_id);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof ParseOtterError
            ? `${error.code}: ${error.message}`
            : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: errorMessage,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );

  /**
   * Tool: get_conversion_result
   *
   * Downloads the result of a completed conversion task.
   * The task must be in "succeeded" status.
   */
  server.tool(
    "get_conversion_result",
    "Download the result of a completed conversion task. The task must have status 'succeeded'.",
    {
      task_id: z.string().describe("The task ID of a completed conversion"),
    },
    async ({ task_id }) => {
      try {
        const config = getConfig();
        const result = await getConversionResult(config, task_id);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  task_id: result.taskId,
                  markdown: result.markdown,
                  metadata: result.metadata,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof ParseOtterError
            ? `${error.code}: ${error.message}`
            : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: errorMessage,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}
