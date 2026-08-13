import { renderFilename } from "../domain/media-utils";
import type { JobProgress, MediaJob, ResolvedSource } from "../domain/schemas";
import { downloadSource, type DownloadOptions } from "./download";
import type { FfmpegEngine } from "./ffmpeg-engine";
import { decideProcessing } from "./policy";

export interface ProcessedMedia {
  readonly blob: Blob;
  readonly filename: string;
  readonly format: MediaJob["output"]["format"];
}

export interface ProcessJobOptions {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: JobProgress) => void | Promise<void>;
  readonly now?: () => number;
  readonly fetchImpl?: DownloadOptions["fetchImpl"];
}

export class LocalMediaProcessor {
  constructor(private readonly ffmpeg: FfmpegEngine) {}

  async process(
    job: MediaJob,
    source: ResolvedSource,
    options: ProcessJobOptions,
  ): Promise<ProcessedMedia> {
    const now = options.now ?? Date.now;
    const downloaded = await downloadSource(source, {
      signal: options.signal,
      selectedTrackIds: job.output.selectedTrackIds,
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
      onProgress: async ({ completedBytes, totalBytes }) => {
        await options.onProgress({
          phase: "downloading",
          completedUnits: completedBytes,
          ...(totalBytes === undefined ? {} : { totalUnits: totalBytes }),
          ...(totalBytes === undefined || totalBytes === 0
            ? {}
            : {
                percent: Math.min(100, (completedBytes / totalBytes) * 100),
              }),
          message: "Descargando la fuente autorizada.",
          updatedAt: now(),
        });
      },
    });
    const processingSource =
      source.kind === "adaptive"
        ? {
            ...source,
            tracks:
              downloaded.inputs.flatMap((input) =>
                input.track === undefined ? [] : [input.track],
              ).length > 0
                ? downloaded.inputs.flatMap((input) =>
                    input.track === undefined ? [] : [input.track],
                  )
                : [
                    {
                      id: "adaptive-media",
                      kind: job.candidate.kind,
                      isDefault: true,
                    },
                  ],
          }
        : source;
    const decision = decideProcessing(processingSource, job.output);

    let outputBlob = downloaded.blob;
    if (decision.mode !== "passthrough") {
      await options.onProgress({
        phase: "processing",
        completedUnits: 0,
        totalUnits: 100,
        percent: 0,
        message:
          decision.mode === "remux"
            ? "Reempaquetando pistas sin recodificar."
            : "Convirtiendo el medio localmente.",
        updatedAt: now(),
      });
      const ffmpegOptions = {
        signal: options.signal,
        onProgress: async (percent: number) => {
          await options.onProgress({
            phase: "processing" as const,
            completedUnits: percent,
            totalUnits: 100,
            percent,
            message:
              decision.mode === "remux"
                ? "Reempaquetando pistas sin recodificar."
                : "Convirtiendo el medio localmente.",
            updatedAt: now(),
          });
        },
      };
      outputBlob =
        source.kind === "adaptive"
          ? await this.ffmpeg.processInputs(
              job.id,
              downloaded.inputs.map((input) => ({
                blob: input.blob,
                ...(input.track?.kind === undefined
                  ? {}
                  : { kind: input.track.kind }),
              })),
              job.output.format,
              decision,
              ffmpegOptions,
            )
          : await this.ffmpeg.process(
              job.id,
              downloaded.blob,
              job.output.format,
              decision,
              ffmpegOptions,
            );
    }

    await options.onProgress({
      phase: "finalizing",
      completedUnits: 1,
      totalUnits: 1,
      percent: 100,
      message: "Preparando la descarga.",
      updatedAt: now(),
    });

    const filename = ensureExtension(
      renderFilename(
        source.mimeType === undefined
          ? job.candidate
          : { ...job.candidate, mimeType: source.mimeType },
        job.output,
        now(),
      ),
      decision.outputExtension,
    );
    return {
      blob: outputBlob,
      filename,
      format: job.output.format,
    };
  }

  dispose(): void {
    this.ffmpeg.dispose();
  }
}

function ensureExtension(filename: string, extension: string): string {
  const normalizedExtension = extension.toLowerCase();
  if (filename.toLowerCase().endsWith(`.${normalizedExtension}`)) {
    return filename;
  }
  if (/\.[a-z0-9]{1,8}$/i.test(filename)) {
    return filename;
  }
  return `${filename}.${normalizedExtension}`;
}
