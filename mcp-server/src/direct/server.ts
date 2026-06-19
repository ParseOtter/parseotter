import { writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, parse, resolve } from "node:path";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { convertFileDirect, type DirectConvertResult } from "./client.js";

const server = new Server(
  {
    name: "parseotter-mcp-direct",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "convert_document_direct",
        description: "Convert a PDF or EPUB document to Markdown using a direct Modal backend connection. Saves the result as a zip file (markdown + images) next to the input file by default.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Absolute path to the PDF or EPUB file",
            },
            outputPath: {
              type: "string",
              description: "Optional custom path for the output zip file. Defaults to <input-file>.zip next to the input file.",
            },
            pageRange: {
              type: "string",
              description: "Page range to convert (e.g. '1-5', '3', '1-')",
            },
            maxPages: {
              type: "number",
              description: "Maximum number of pages to convert",
            },
            timeoutMs: {
              type: "number",
              description: "Timeout in milliseconds (default: 900000)",
            },
          },
          required: ["filePath"],
        },
      },
    ],
  };
});

function saveResultToZip(result: DirectConvertResult, outputPath: string, baseName: string): void {
  const absOutput = resolve(outputPath);
  const outDir = dirname(absOutput);
  mkdirSync(outDir, { recursive: true });

  const tmpDir = mkdtempSync(join(tmpdir(), "parseotter-"));
  try {
    writeFileSync(join(tmpDir, `${baseName}.md`), result.markdown, "utf-8");

    if (result.images.length > 0) {
      const imagesDir = join(tmpDir, "images");
      mkdirSync(imagesDir, { recursive: true });
      for (const img of result.images) {
        const data = img.data.includes(",") ? img.data.split(",")[1] : img.data;
        writeFileSync(join(imagesDir, img.name), Buffer.from(data, "base64"));
      }
    }

    execSync(`zip -j "${absOutput}" "${join(tmpDir, `${baseName}.md`)}"`, { stdio: "pipe" });
    if (result.images.length > 0) {
      execSync(`zip -r "${absOutput}" "images"`, { cwd: tmpDir, stdio: "pipe" });
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments;
  if (typeof args !== "object" || args === null) {
    return { content: [{ type: "text", text: "Error: arguments must be an object" }], isError: true };
  }

  const { filePath, outputPath, pageRange, maxPages, timeoutMs } = args as Record<string, unknown>;
  if (typeof filePath !== "string" || !filePath) {
    return { content: [{ type: "text", text: "Error: filePath must be a non-empty string" }], isError: true };
  }

  try {
    const result = await convertFileDirect(getBaseUrl(), filePath, {
      page_range: typeof pageRange === "string" ? pageRange : undefined,
      max_pages: typeof maxPages === "number" ? maxPages : undefined,
      signal: typeof timeoutMs === "number" ? AbortSignal.timeout(timeoutMs) : undefined,
    });

    const response: string[] = [];
    const inputFile = resolve(filePath);
    const inputName = parse(inputFile).name;

    let outPath: string;
    if (typeof outputPath === "string" && outputPath) {
      outPath = resolve(outputPath);
    } else {
      outPath = join(dirname(inputFile), `${inputName}.zip`);
    }

    saveResultToZip(result, outPath, inputName);
    response.push(`Result saved to: ${outPath}`);
    response.push(`Pages: ${result.metadata.page_count} | GPU: ${result.metadata.gpu_type} | Time: ${result.metadata.processing_time_ms}ms`);
    response.push("");
    response.push(result.markdown);

    return {
      content: [
        {
          type: "text",
          text: response.join("\n"),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

function getBaseUrl(): string {
  const url = process.env.PARSEOTTER_MODAL_DIRECT_URL || "http://localhost:8000";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("PARSEOTTER_MODAL_DIRECT_URL must start with http:// or https://");
  }
  return url;
}

export async function runServer(): Promise<void> {
  getBaseUrl();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
