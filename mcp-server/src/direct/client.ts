import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ConversionOptions } from "../types.js";

export interface DirectConvertResult {
  job_id: string;
  status: string;
  markdown: string;
  images: { name: string; data: string }[];
  metadata: {
    page_count: number;
    processing_time_ms: number;
    gpu_type: string;
  };
}

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".epub"]);
const FILE_SIZE_LIMIT = 150 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 900_000;

export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "TypeError" && error.message.includes("fetch")) return true;
    if (error.name === "AbortError") return false;
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("SERVER_ERROR") || msg.includes("5xx") || msg.includes("503") || msg.includes("500")) return true;
  return false;
}

function validateResponse(raw: unknown): DirectConvertResult {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Invalid response: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.job_id !== "string") throw new Error("Invalid response: missing or invalid job_id");
  if (typeof obj.markdown !== "string") throw new Error("Invalid response: missing or invalid markdown");
  if (!Array.isArray(obj.images)) throw new Error("Invalid response: images must be an array");
  return raw as DirectConvertResult;
}

export async function convertFileDirect(
  baseUrl: string,
  filePath: string,
  options?: ConversionOptions & { signal?: AbortSignal },
): Promise<DirectConvertResult> {
  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported file type '${ext}'. Supported: ${[...SUPPORTED_EXTENSIONS].join(", ")}`);
  }

  const data = readFileSync(filePath);
  if (data.length === 0) {
    throw new Error("File is empty");
  }
  if (data.length > FILE_SIZE_LIMIT) {
    throw new Error(`File exceeds maximum size of ${FILE_SIZE_LIMIT / 1024 / 1024} MB`);
  }

  const formData = new FormData();
  const blob = new Blob([data], { type: "application/octet-stream" });
  formData.append("file", blob, filePath.split("/").pop() || "document");

  if (options?.page_range) formData.append("page_range", options.page_range);
  if (options?.max_pages !== undefined) formData.append("max_pages", String(options.max_pages));

  const url = `${baseUrl.replace(/\/$/, "")}/api/direct/convert`;

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  if (options?.signal) {
    onAbort = () => controller.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });
  } else {
    timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (response.status === 413) throw new Error(`File too large: ${body}`);
      if (response.status === 422) throw new Error(`Invalid request: ${body}`);
      if (response.status === 503) throw new Error(`Service unavailable (DIRECT_ENABLED not set): ${body}`);
      if (response.status >= 500) throw new Error(`Server error (${response.status}): ${body}`);
      throw new Error(`Request failed (${response.status}): ${body}`);
    }

    const raw: unknown = await response.json();
    return validateResponse(raw);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (onAbort && options?.signal) {
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}

export async function convertFileDirectWithRetry(
  baseUrl: string,
  filePath: string,
  options?: ConversionOptions & { timeoutMs?: number; maxRetries?: number; signal?: AbortSignal },
): Promise<DirectConvertResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options?.maxRetries ?? 2;
  const { timeoutMs: _t, maxRetries: _r, ...rest } = options ?? {};
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combined = typeof AbortSignal.any === "function" && rest.signal
        ? AbortSignal.any([rest.signal, timeoutSignal])
        : timeoutSignal;

      const result = await convertFileDirect(baseUrl, filePath, { ...rest, signal: combined });
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries && isRetryableError(error)) {
        const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 200, 10000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError!;
}
