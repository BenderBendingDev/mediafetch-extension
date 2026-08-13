import type { ContainerFormat } from "../domain/schemas";
import { MediaProcessingError, throwIfAborted } from "./errors";
import {
  materializeFfmpegArguments,
  materializeFfmpegArgumentsForInputs,
  type ProcessingDecision,
} from "./policy";

export const FFMPEG_CORE_PUBLIC_PATH = "ffmpeg/ffmpeg-core.js";
export const FFMPEG_WASM_PUBLIC_PATH = "ffmpeg/ffmpeg-core.wasm";

export interface FfmpegProgressEvent {
  readonly progress: number;
  readonly time: number;
}

export interface FfmpegLike {
  load(
    config: { readonly coreURL: string; readonly wasmURL: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<boolean>;
  on(event: "progress", callback: (event: FfmpegProgressEvent) => void): void;
  off(event: "progress", callback: (event: FfmpegProgressEvent) => void): void;
  writeFile(
    path: string,
    data: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<boolean>;
  exec(
    arguments_: string[],
    timeout?: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<number>;
  readFile(
    path: string,
    encoding?: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Uint8Array | string>;
  deleteFile(
    path: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<boolean>;
  terminate(): void;
}

export interface FfmpegEngineOptions {
  readonly runtimeGetURL: (path: string) => string;
  readonly corePublicPath?: string;
  readonly wasmPublicPath?: string;
  readonly createFfmpeg?: () => FfmpegLike | Promise<FfmpegLike>;
  readonly toFileData?: (blob: Blob) => Promise<Uint8Array>;
}

export interface FfmpegProcessOptions {
  readonly signal: AbortSignal;
  readonly onProgress: (percent: number) => void | Promise<void>;
}

export interface FfmpegMediaInput {
  readonly blob: Blob;
  readonly kind?: "audio" | "video" | "subtitle";
}

export class FfmpegEngine {
  private ffmpeg: FfmpegLike | undefined;
  private loadPromise: Promise<FfmpegLike> | undefined;

  constructor(private readonly options: FfmpegEngineOptions) {}

  async process(
    jobId: string,
    source: Blob,
    format: ContainerFormat,
    decision: ProcessingDecision,
    options: FfmpegProcessOptions,
  ): Promise<Blob> {
    return this.run(
      jobId,
      [{ blob: source }],
      format,
      decision,
      options,
      false,
    );
  }

  async processInputs(
    jobId: string,
    inputs: readonly FfmpegMediaInput[],
    format: ContainerFormat,
    decision: ProcessingDecision,
    options: FfmpegProcessOptions,
  ): Promise<Blob> {
    if (inputs.length === 0) {
      throw new MediaProcessingError(
        "ffmpeg_failed",
        "FFmpeg requiere al menos una entrada multimedia.",
      );
    }
    return this.run(jobId, inputs, format, decision, options, true);
  }

  private async run(
    jobId: string,
    inputs: readonly FfmpegMediaInput[],
    format: ContainerFormat,
    decision: ProcessingDecision,
    options: FfmpegProcessOptions,
    useIndependentInputs: boolean,
  ): Promise<Blob> {
    throwIfAborted(options.signal);
    const ffmpeg = await this.getLoaded(options.signal);
    const basename = safeFsName(jobId);
    const inputPaths = inputs.map(
      (_input, index) => `${basename}.input-${index}`,
    );
    const outputPath = `${basename}.${decision.outputExtension}`;
    const progressListener = ({ progress }: FfmpegProgressEvent): void => {
      const percent = Number.isFinite(progress)
        ? Math.max(0, Math.min(100, progress * 100))
        : 0;
      void Promise.resolve(options.onProgress(percent)).catch(() => undefined);
    };
    const terminateOnAbort = (): void => {
      ffmpeg.terminate();
      if (this.ffmpeg === ffmpeg) this.ffmpeg = undefined;
      this.loadPromise = undefined;
    };

    ffmpeg.on("progress", progressListener);
    options.signal.addEventListener("abort", terminateOnAbort, { once: true });
    try {
      for (const [index, input] of inputs.entries()) {
        const bytes = await this.toFileData(input.blob);
        throwIfAborted(options.signal);
        await ffmpeg.writeFile(inputPaths[index]!, bytes, {
          signal: options.signal,
        });
      }
      const arguments_ = useIndependentInputs
        ? materializeFfmpegArgumentsForInputs(
            decision,
            inputs.map((input, index) => ({
              path: inputPaths[index]!,
              ...(input.kind === undefined ? {} : { kind: input.kind }),
            })),
            outputPath,
          )
        : materializeFfmpegArguments(decision, inputPaths[0]!, outputPath);
      const exitCode = await ffmpeg.exec(arguments_, undefined, {
        signal: options.signal,
      });
      throwIfAborted(options.signal);
      if (exitCode !== 0) {
        throw new MediaProcessingError(
          "ffmpeg_failed",
          `FFmpeg terminó con código ${exitCode} al generar ${format}.`,
        );
      }
      const output = await ffmpeg.readFile(outputPath, undefined, {
        signal: options.signal,
      });
      if (typeof output === "string") {
        throw new MediaProcessingError(
          "ffmpeg_failed",
          "FFmpeg devolvió una salida de texto inesperada.",
        );
      }
      const copied = new Uint8Array(output.byteLength);
      copied.set(output);
      return new Blob([copied], { type: decision.mimeType });
    } catch (error) {
      if (options.signal.aborted) {
        throwIfAborted(options.signal);
      }
      if (error instanceof MediaProcessingError) throw error;
      throw new MediaProcessingError(
        "ffmpeg_failed",
        `FFmpeg no pudo generar ${format}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        false,
        { cause: error },
      );
    } finally {
      options.signal.removeEventListener("abort", terminateOnAbort);
      ffmpeg.off("progress", progressListener);
      if (this.ffmpeg === ffmpeg) {
        await Promise.allSettled([
          ...inputPaths.map((inputPath) => ffmpeg.deleteFile(inputPath)),
          ffmpeg.deleteFile(outputPath),
        ]);
      }
    }
  }

  dispose(): void {
    this.ffmpeg?.terminate();
    this.ffmpeg = undefined;
    this.loadPromise = undefined;
  }

  private async getLoaded(signal: AbortSignal): Promise<FfmpegLike> {
    if (this.ffmpeg !== undefined) return this.ffmpeg;
    this.loadPromise ??= this.load(signal);
    try {
      return await this.loadPromise;
    } catch (error) {
      this.loadPromise = undefined;
      if (signal.aborted) throwIfAborted(signal);
      if (error instanceof MediaProcessingError) throw error;
      throw new MediaProcessingError(
        "ffmpeg_load_failed",
        `No se pudo cargar el núcleo local de FFmpeg: ${
          error instanceof Error ? error.message : String(error)
        }`,
        false,
        { cause: error },
      );
    }
  }

  private async load(signal: AbortSignal): Promise<FfmpegLike> {
    throwIfAborted(signal);
    const ffmpeg = await (this.options.createFfmpeg?.() ?? createFfmpeg());
    const terminateOnAbort = (): void => ffmpeg.terminate();
    signal.addEventListener("abort", terminateOnAbort, { once: true });
    try {
      await ffmpeg.load(
        {
          coreURL: this.options.runtimeGetURL(
            this.options.corePublicPath ?? FFMPEG_CORE_PUBLIC_PATH,
          ),
          wasmURL: this.options.runtimeGetURL(
            this.options.wasmPublicPath ?? FFMPEG_WASM_PUBLIC_PATH,
          ),
        },
        { signal },
      );
      throwIfAborted(signal);
      this.ffmpeg = ffmpeg;
      return ffmpeg;
    } catch (error) {
      ffmpeg.terminate();
      throw error;
    } finally {
      signal.removeEventListener("abort", terminateOnAbort);
    }
  }

  private async toFileData(blob: Blob): Promise<Uint8Array> {
    if (this.options.toFileData !== undefined) {
      return this.options.toFileData(blob);
    }
    const { fetchFile } = await import("@ffmpeg/util");
    return fetchFile(blob);
  }
}

async function createFfmpeg(): Promise<FfmpegLike> {
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  return new FFmpeg();
}

function safeFsName(jobId: string): string {
  const safe = jobId.replace(/[^a-z0-9_-]/gi, "_").slice(0, 100);
  return `${safe || "job"}-${crypto.randomUUID()}`;
}
