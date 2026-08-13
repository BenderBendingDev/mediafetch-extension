import type { JobError } from "../domain/schemas";

export type MediaErrorCode =
  | "cancelled"
  | "download_failed"
  | "drm_protected"
  | "ffmpeg_failed"
  | "ffmpeg_load_failed"
  | "invalid_track_selection"
  | "processing_too_large"
  | "unsupported_adaptive"
  | "unsupported_output";

export class MediaProcessingError extends Error {
  constructor(
    readonly code: MediaErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MediaProcessingError";
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new MediaProcessingError(
      "cancelled",
      "El procesamiento fue cancelado.",
      false,
      { cause: signal.reason },
    );
  }
}

export function normalizeMediaError(error: unknown): MediaProcessingError {
  if (error instanceof MediaProcessingError) {
    return error;
  }
  if (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new MediaProcessingError(
      "cancelled",
      "El procesamiento fue cancelado.",
      false,
      { cause: error },
    );
  }
  const message =
    error instanceof Error ? error.message : "Error multimedia desconocido.";
  return new MediaProcessingError(
    "ffmpeg_failed",
    `No se pudo procesar el medio: ${message}`,
    false,
    { cause: error },
  );
}

export function toJobError(error: unknown, occurredAt: number): JobError {
  const normalized = normalizeMediaError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    occurredAt,
  };
}
