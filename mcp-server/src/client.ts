/**
 * ParseOtter API Client for MCP Server
 *
 * Handles the full conversion flow:
 * 1. Create task
 * 2. Create upload session
 * 3. Upload file parts
 * 4. Complete upload
 * 5. Poll for completion
 * 6. Download result
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Config, ParseOtterError, RateLimitError, NetworkError, TaskStatus } from "./types.js";

// Progress callback type
export type ProgressCallback = (stage: string, progress?: number, total?: number) => void;

// API response envelope type
type ApiEnvelope<T> =
  | { success: true; data: T; error: null }
  | { success: false; data: null; error: { code: string; message: string; details?: unknown } };

// API response types (matching the actual API)
interface TaskResponse {
  taskId: string;
  status: string;
  visibleStatus: string;
  version: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  expiredAt: string | null;
  error: { code: string; message: string | null } | null;
  file: {
    name: string;
    type: string;
    sizeBytes: number;
  };
  upload: {
    uploadId: string | null;
    status: string | null;
    inputObjectKey: string | null;
    inputSizeBytes: number | null;
    inputEtag: string | null;
    inputContentType: string | null;
    inputPartCount: number | null;
    inputChecksumSha256: string | null;
  };
  output: {
    objectKey: string | null;
    contentType: string | null;
    sizeBytes: number | null;
  };
  dispatch: {
    status: string | null;
    attempt: number;
    idempotencyKey: string | null;
    startedAt: string | null;
    completedAt: string | null;
    lastCallbackIdempotencyKey: string | null;
  };
}

interface UploadSessionResponse {
  taskId: string;
  uploadId: string;
  status: string;
  partSizeBytes: number;
  partCount: number;
  presignedUrlTtlSeconds: number;
}

interface SignedPartsResponse {
  taskId: string;
  uploadId: string;
  parts: Array<{
    partNumber: number;
    url: string;
  }>;
}

interface CompletedPart {
  partNumber: number;
  etag: string;
}

interface DownloadResponse {
  taskId: string;
  url: string;
  expiresInSeconds: number;
}

// Supported file types
const SUPPORTED_EXTENSIONS = new Set([".pdf", ".epub"]);
const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
};

// Upload configuration
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_POLL_ATTEMPTS = 300; // 5 minutes with 1s interval
const POLL_INTERVAL_MS = 1000;

/**
 * Create a ParseOtter API client
 */
export function createApiClient(config: Config) {
  const { apiKey, baseUrl, timeoutMs, maxRetries, retryDelayMs } = config;

  /**
   * Sleep for specified milliseconds
   */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if an error is retryable
   */
  function isRetryableError(error: unknown): boolean {
    if (error instanceof ParseOtterError) {
      return error.retryable;
    }
    // Network errors are retryable
    if (error instanceof TypeError && error.message.includes("fetch")) {
      return true;
    }
    return false;
  }

  /**
   * Calculate retry delay with exponential backoff
   */
  function getRetryDelay(attempt: number, error?: unknown): number {
    // Use retry-after header if available (for rate limits)
    if (error instanceof RateLimitError && error.retryAfterMs) {
      return error.retryAfterMs;
    }
    // Exponential backoff: baseDelay * 2^attempt + jitter
    const baseDelay = retryDelayMs;
    const exponentialDelay = baseDelay * Math.pow(2, attempt);
    const jitter = Math.random() * 1000; // Add up to 1s jitter
    return Math.min(exponentialDelay + jitter, 30000); // Max 30s
  }

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const url = `${baseUrl}${path}`;
        const headers = new Headers(options.headers);
        headers.set("Authorization", `Bearer ${apiKey}`);
        headers.set("Content-Type", "application/json");

        const response = await fetch(url, {
          ...options,
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
          throw new RateLimitError("Rate limit exceeded", retryAfterMs);
        }

        // Handle other HTTP errors
        if (!response.ok) {
          const errorBody = await response.json().catch(() => null);
          const errorMessage = errorBody?.error?.message || `HTTP ${response.status}`;
          const errorCode = errorBody?.error?.code || "HTTP_ERROR";
          throw new ParseOtterError(errorMessage, errorCode, response.status);
        }

        const envelope: ApiEnvelope<T> = await response.json();

        if (!envelope.success) {
          throw new ParseOtterError(
            envelope.error.message || "API request failed",
            envelope.error.code || "API_ERROR",
            response.status,
          );
        }

        return envelope.data;
      } catch (error) {
        lastError = error;

        // Don't retry if not retryable or max retries reached
        if (!isRetryableError(error) || attempt >= maxRetries) {
          throw error;
        }

        // Wait before retry
        const delay = getRetryDelay(attempt, error);
        await sleep(delay);
      }
    }

    throw lastError;
  }

  async function createTask(filename: string, fileType: string, fileSizeBytes: number): Promise<TaskResponse> {
    return request<TaskResponse>("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        fileName: filename,
        fileType,
        fileSizeBytes,
        // No turnstileToken needed for API key auth
      }),
    });
  }

  async function createUploadSession(taskId: string): Promise<UploadSessionResponse> {
    return request<UploadSessionResponse>(`/api/tasks/${encodeURIComponent(taskId)}/uploads`, {
      method: "POST",
    });
  }

  async function signUploadParts(
    taskId: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<SignedPartsResponse> {
    return request<SignedPartsResponse>(
      `/api/tasks/${encodeURIComponent(taskId)}/uploads/${encodeURIComponent(uploadId)}/parts/sign`,
      {
        method: "POST",
        body: JSON.stringify({ partNumbers }),
      },
    );
  }

  async function completeUpload(
    taskId: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<TaskResponse> {
    return request<TaskResponse>(
      `/api/tasks/${encodeURIComponent(taskId)}/uploads/${encodeURIComponent(uploadId)}/complete`,
      {
        method: "POST",
        body: JSON.stringify({ parts }),
      },
    );
  }

  async function abortUpload(taskId: string, uploadId: string): Promise<void> {
    await request<TaskResponse>(
      `/api/tasks/${encodeURIComponent(taskId)}/uploads/${encodeURIComponent(uploadId)}/abort`,
      { method: "POST" },
    );
  }

  async function getTask(taskId: string): Promise<TaskResponse> {
    return request<TaskResponse>(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
    });
  }

  async function getDownload(taskId: string): Promise<DownloadResponse> {
    return request<DownloadResponse>(`/api/tasks/${encodeURIComponent(taskId)}/download`, {
      method: "GET",
    });
  }

  return {
    createTask,
    createUploadSession,
    signUploadParts,
    completeUpload,
    abortUpload,
    getTask,
    getDownload,
  };
}

/**
 * Get the MIME type for a file based on its extension
 */
function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType) {
    throw new ParseOtterError(
      `Unsupported file type: ${ext}. Only PDF and EPUB files are supported`,
      "VALIDATION_ERROR",
    );
  }
  return mimeType;
}

/**
 * Upload a file part to R2 using a presigned URL
 */
async function uploadPart(
  signedUrl: string,
  data: Buffer,
  signal?: AbortSignal,
): Promise<{ partNumber: number; etag: string }> {
  const response = await fetch(signedUrl, {
    method: "PUT",
    body: new Uint8Array(data),
    headers: {
      "Content-Type": "application/octet-stream",
    },
    signal,
  });

  if (!response.ok) {
    throw new ParseOtterError(`Upload failed with status ${response.status}`, "UPLOAD_ERROR", response.status);
  }

  const etag = response.headers.get("etag");
  if (!etag) {
    throw new ParseOtterError("R2 did not return an ETag", "UPLOAD_ERROR");
  }

  // Extract part number from URL or return 0 (will be set by caller)
  return { partNumber: 0, etag };
}

/**
 * Convert a file to markdown using the ParseOtter API
 *
 * This is the main entry point that handles the entire conversion flow.
 */
export async function convertFile(
  config: Config,
  filePath: string,
  options: {
    pageRange?: string;
    forceOcr?: boolean;
    onProgress?: ProgressCallback;
  } = {},
): Promise<{
  taskId: string;
  markdown: string;
  metadata: { pages: number; processingTimeMs: number };
  images?: Array<{ name: string; data: string }>;
}> {
  const client = createApiClient(config);
  const filename = basename(filePath);
  const fileType = getMimeType(filePath);
  const { onProgress } = options;

  // Read file
  onProgress?.("Reading file...");
  let fileData: Buffer;
  try {
    fileData = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ParseOtterError(`File not found: ${filePath}`, "FILE_ERROR");
    }
    throw new ParseOtterError(`Failed to read file: ${filePath}`, "FILE_ERROR");
  }

  // Validate file size
  if (fileData.length > MAX_FILE_SIZE) {
    throw new ParseOtterError(
      `File too large: ${(fileData.length / 1024 / 1024).toFixed(1)}MB (max: 100MB)`,
      "VALIDATION_ERROR",
    );
  }

  onProgress?.("Creating conversion task...");

  // Create task
  const task = await client.createTask(filename, fileType, fileData.length);
  onProgress?.("Task created", 0, 100);

  // Create upload session
  onProgress?.("Creating upload session...");
  const uploadSession = await client.createUploadSession(task.taskId);

  // Upload file in parts
  onProgress?.("Uploading file...", 0, uploadSession.partCount);
  const completedParts: CompletedPart[] = [];
  const partSize = uploadSession.partSizeBytes;

  for (let partNumber = 1; partNumber <= uploadSession.partCount; partNumber++) {
    const start = (partNumber - 1) * partSize;
    const end = Math.min(fileData.length, start + partSize);
    const partData = fileData.subarray(start, end);

    // Get signed URL for this part
    const signed = await client.signUploadParts(task.taskId, uploadSession.uploadId, [partNumber]);
    const signedPart = signed.parts.find((p) => p.partNumber === partNumber);
    if (!signedPart) {
      throw new ParseOtterError(`Missing signed URL for part ${partNumber}`, "UPLOAD_ERROR");
    }

    // Upload the part
    const result = await uploadPart(signedPart.url, partData);
    completedParts.push({
      partNumber,
      etag: result.etag,
    });

    onProgress?.("Uploading file...", partNumber, uploadSession.partCount);
  }

  // Complete upload
  onProgress?.("Completing upload...");
  await client.completeUpload(task.taskId, uploadSession.uploadId, completedParts);

  // Poll for completion
  onProgress?.("Processing document...", 0, 100);
  let finalTask: TaskResponse | null = null;
  let lastStatus = "";
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const currentTask = await client.getTask(task.taskId);

    if (currentTask.status === "succeeded" || currentTask.status === "failed") {
      finalTask = currentTask;
      break;
    }

    // Report status change
    if (currentTask.status !== lastStatus) {
      lastStatus = currentTask.status;
      onProgress?.(`Processing: ${currentTask.status}`, attempt, MAX_POLL_ATTEMPTS);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  if (!finalTask) {
    throw new ParseOtterError("Conversion timed out", "TIMEOUT_ERROR");
  }

  if (finalTask.status === "failed") {
    const errorMsg = finalTask.error?.message || "Conversion failed";
    throw new ParseOtterError(errorMsg, "CONVERSION_FAILED");
  }

  // Download result
  onProgress?.("Downloading result...");
  const download = await client.getDownload(task.taskId);
  const downloadResponse = await fetch(download.url);
  if (!downloadResponse.ok) {
    throw new ParseOtterError("Failed to download result", "DOWNLOAD_ERROR");
  }

  // Download as buffer (ZIP file)
  const zipBuffer = Buffer.from(await downloadResponse.arrayBuffer());

  // Parse ZIP to extract markdown and images
  onProgress?.("Extracting content...");
  const zipData = parseZip(zipBuffer);

  // Extract markdown content
  const markdown = zipData.files["raw.md"];
  if (!markdown) {
    throw new ParseOtterError("ZIP file does not contain raw.md", "RESULT_ERROR");
  }

  // Extract metadata if available
  let metadata = { pages: 0, processingTimeMs: 0 };
  const metadataJson = zipData.files["metadata.json"];
  if (metadataJson) {
    try {
      const parsed = JSON.parse(metadataJson);
      metadata = {
        pages: parsed.pages || 0,
        processingTimeMs: parsed.processing_time_ms || 0,
      };
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  // If no metadata, calculate from task timestamps
  if (metadata.processingTimeMs === 0) {
    metadata.processingTimeMs = new Date(finalTask.updatedAt).getTime() - new Date(finalTask.createdAt).getTime();
  }

  // Extract images (if any)
  const images: Array<{ name: string; data: string }> = [];
  for (const [path, content] of Object.entries(zipData.files)) {
    if (path.startsWith("images/")) {
      images.push({
        name: path.replace("images/", ""),
        data: Buffer.from(content, "binary").toString("base64"),
      });
    }
  }

  onProgress?.("Conversion complete!", 100, 100);

  return {
    taskId: task.taskId,
    markdown,
    metadata,
    images: images.length > 0 ? images : undefined,
  };
}

/**
 * Check the status of a conversion task
 */
export async function checkTaskStatus(
  config: Config,
  taskId: string,
): Promise<{
  taskId: string;
  status: TaskStatus;
  progress?: number;
  error?: string;
}> {
  const client = createApiClient(config);
  const task = await client.getTask(taskId);

  return {
    taskId: task.taskId,
    status: task.status as TaskStatus,
    error: task.error?.message || undefined,
  };
}

/**
 * Get the result of a completed conversion
 */
export async function getConversionResult(
  config: Config,
  taskId: string,
): Promise<{
  taskId: string;
  markdown: string;
  metadata: { pages: number; processingTimeMs: number };
  images?: Array<{ name: string; data: string }>;
}> {
  const client = createApiClient(config);

  // Check task status first
  const task = await client.getTask(taskId);
  if (task.status !== "succeeded") {
    throw new ParseOtterError(
      `Task is not completed. Current status: ${task.status}`,
      "INVALID_STATE",
    );
  }

  // Download result
  const download = await client.getDownload(taskId);
  const downloadResponse = await fetch(download.url);
  if (!downloadResponse.ok) {
    throw new ParseOtterError("Failed to download result", "DOWNLOAD_ERROR");
  }

  // Download as buffer (ZIP file)
  const zipBuffer = Buffer.from(await downloadResponse.arrayBuffer());

  // Parse ZIP to extract markdown and images
  const zipData = parseZip(zipBuffer);

  // Extract markdown content
  const markdown = zipData.files["raw.md"];
  if (!markdown) {
    throw new ParseOtterError("ZIP file does not contain raw.md", "RESULT_ERROR");
  }

  // Extract metadata if available
  let metadata = { pages: 0, processingTimeMs: 0 };
  const metadataJson = zipData.files["metadata.json"];
  if (metadataJson) {
    try {
      const parsed = JSON.parse(metadataJson);
      metadata = {
        pages: parsed.pages || 0,
        processingTimeMs: parsed.processing_time_ms || 0,
      };
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  // If no metadata, calculate from task timestamps
  if (metadata.processingTimeMs === 0) {
    metadata.processingTimeMs = new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime();
  }

  // Extract images (if any)
  const images: Array<{ name: string; data: string }> = [];
  for (const [path, content] of Object.entries(zipData.files)) {
    if (path.startsWith("images/")) {
      images.push({
        name: path.replace("images/", ""),
        data: Buffer.from(content, "binary").toString("base64"),
      });
    }
  }

  return {
    taskId,
    markdown,
    metadata,
    images: images.length > 0 ? images : undefined,
  };
}

/**
 * Simple ZIP file parser
 * Extracts files from a ZIP archive without external dependencies
 */
import { inflateRawSync } from "node:zlib";

interface ZipData {
  files: Record<string, string>;
}

function parseZip(buffer: Buffer): ZipData {
  const files: Record<string, string> = {};

  // ZIP file format:
  // Local file header signature: 0x04034b50
  // End of central dir signature: 0x06054b50

  let offset = 0;

  while (offset < buffer.length - 4) {
    const signature = buffer.readUInt32LE(offset);

    if (signature === 0x04034b50) {
      // Local file header
      const compressionMethod = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const fileNameLength = buffer.readUInt16LE(offset + 26);
      const extraFieldLength = buffer.readUInt16LE(offset + 28);

      const fileNameStart = offset + 30;
      const fileName = buffer.toString("utf8", fileNameStart, fileNameStart + fileNameLength);
      const dataStart = fileNameStart + fileNameLength + extraFieldLength;

      if (compressionMethod === 0) {
        // No compression (stored)
        const data = buffer.toString("utf8", dataStart, dataStart + compressedSize);
        files[fileName] = data;
      } else if (compressionMethod === 8) {
        // Deflate compression (raw deflate, not zlib)
        const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);
        const uncompressedData = inflateRawSync(compressedData);
        files[fileName] = uncompressedData.toString("utf8");
      }

      offset = dataStart + compressedSize;
    } else if (signature === 0x06054b50) {
      // End of central directory
      break;
    } else {
      offset += 4;
    }
  }

  return { files };
}
