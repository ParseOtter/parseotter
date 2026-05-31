/**
 * Type definitions for ParseOtter MCP Server
 */

// Environment configuration
export interface Config {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

// API request/response types
export interface CreateTaskRequest {
  filename: string;
  content_type: string;
  file_size: number;
  options?: ConversionOptions;
}

export interface ConversionOptions {
  page_range?: string;
  force_ocr?: boolean;
  output_image_format?: "png" | "jpg" | "webp";
  paginate_output?: boolean;
}

export interface CreateTaskResponse {
  task_id: string;
  status: "created" | "upload_pending";
  upload_session?: UploadSession;
}

export interface UploadSession {
  upload_id: string;
  part_size: number;
  total_parts: number;
  presigned_urls: string[];
}

export interface TaskStatusResponse {
  task_id: string;
  status: TaskStatus;
  progress?: number;
  result?: ConversionResult;
  error?: string;
  created_at: string;
  updated_at: string;
}

export type TaskStatus =
  | "created"
  | "upload_pending"
  | "uploading"
  | "upload_completed"
  | "dispatch_pending"
  | "dispatching"
  | "processing"
  | "succeeded"
  | "failed"
  | "expired";

export interface ConversionResult {
  markdown: string;
  images?: ImageResult[];
  metadata: {
    pages: number;
    processing_time_ms: number;
  };
}

export interface ImageResult {
  name: string;
  data: string; // Base64 encoded
}

// MCP tool input types
export interface ConvertDocumentInput {
  file_path: string;
  output_format?: "markdown" | "markdown_with_images";
  page_range?: string;
  force_ocr?: boolean;
}

export interface CheckStatusInput {
  task_id: string;
}

export interface GetResultInput {
  task_id: string;
}

// MCP tool output types
export interface ConvertDocumentOutput {
  task_id: string;
  status: "completed";
  markdown: string;
  images?: Array<{
    name: string;
    data: string;
  }>;
  metadata: {
    pages: number;
    processing_time_ms: number;
  };
}

export interface CheckStatusOutput {
  task_id: string;
  status: "processing" | "succeeded" | "failed";
  progress?: number;
  error?: string;
}

// Error types
export class ParseOtterError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public retryable: boolean = false,
  ) {
    super(message);
    this.name = "ParseOtterError";
  }
}

export class FileError extends ParseOtterError {
  constructor(message: string) {
    super(message, "FILE_ERROR");
    this.name = "FileError";
  }
}

export class AuthError extends ParseOtterError {
  constructor(message: string = "Invalid API key") {
    super(message, "AUTH_ERROR", 401);
    this.name = "AuthError";
  }
}

export class TimeoutError extends ParseOtterError {
  constructor(message: string = "Conversion timed out") {
    super(message, "TIMEOUT_ERROR", 408);
    this.name = "TimeoutError";
  }
}

export class RateLimitError extends ParseOtterError {
  constructor(message: string = "Rate limit exceeded", public retryAfterMs?: number) {
    super(message, "RATE_LIMIT_ERROR", 429, true);
    this.name = "RateLimitError";
  }
}

export class NetworkError extends ParseOtterError {
  constructor(message: string = "Network error") {
    super(message, "NETWORK_ERROR", undefined, true);
    this.name = "NetworkError";
  }
}
