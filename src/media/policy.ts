import type {
  ContainerFormat,
  OutputRequest,
  ResolvedSource,
  Track,
} from "../domain/schemas";
import { MediaProcessingError } from "./errors";

export const MAX_PROCESSING_BYTES = 2_000_000_000;

const ENCRYPTION_METADATA =
  /\b(?:cenc|cbcs|drm|eme|encrypted|fairplay|playready|widevine)\b/i;
const ENCRYPTED_MANIFEST =
  /#EXT-X-KEY:(?![^\r\n]*METHOD=NONE)|<ContentProtection\b|urn:uuid:[0-9a-f-]{36}/i;
const ENCRYPTED_MP4_BOX = /(?:pssh|sinf|tenc)/;

export type ProcessingMode = "passthrough" | "remux" | "transcode";

export interface ProcessingDecision {
  readonly mode: ProcessingMode;
  readonly outputExtension: string;
  readonly mimeType: string;
  readonly ffmpegArguments: readonly string[];
  readonly codecArguments: readonly string[];
}

export function assertWithinProcessingLimit(
  size: number | undefined,
  context = "El medio",
): void {
  if (size !== undefined && size >= MAX_PROCESSING_BYTES) {
    throw new MediaProcessingError(
      "processing_too_large",
      `${context} ocupa ${size} bytes; el límite local es inferior a 2 GB.`,
    );
  }
}

export function assertSourceIsClear(
  source: ResolvedSource,
  downloadedBytes?: Uint8Array,
): void {
  const metadata = [
    source.mimeType,
    source.url,
    ...source.tracks.flatMap((track) => [
      track.codec,
      track.container,
      track.label,
    ]),
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  if (ENCRYPTION_METADATA.test(metadata)) {
    throw drmError();
  }

  if (downloadedBytes !== undefined) {
    const sample = downloadedBytes.subarray(
      0,
      Math.min(downloadedBytes.byteLength, 2_000_000),
    );
    const text = new TextDecoder("utf-8", { fatal: false }).decode(sample);
    if (
      ENCRYPTED_MANIFEST.test(text) ||
      (looksLikeIsoBmff(sample) && ENCRYPTED_MP4_BOX.test(text))
    ) {
      throw drmError();
    }
  }
}

export function decideProcessing(
  source: ResolvedSource,
  output: OutputRequest,
): ProcessingDecision {
  const selectedTracks = resolveSelectedTracks(source, output.selectedTrackIds);
  if (
    (output.format === "mp3" ||
      output.format === "m4a" ||
      output.format === "wav") &&
    source.tracks.length > 0 &&
    !selectedTracks.some((track) => track.kind === "audio")
  ) {
    throw new MediaProcessingError(
      "unsupported_output",
      `La salida ${output.format} requiere al menos una pista de audio.`,
    );
  }
  const allTracksSelected =
    output.selectedTrackIds.length === 0 ||
    (source.tracks.length > 0 &&
      selectedTracks.length === source.tracks.length);
  const mapArguments = buildMapArguments(source.tracks, selectedTracks);

  if (
    output.format === "original" &&
    allTracksSelected &&
    source.kind !== "adaptive"
  ) {
    const original = outputDescriptor(
      extensionFromSource(source),
      normalizedMimeType(source.mimeType) ?? "application/octet-stream",
    );
    return {
      mode: "passthrough",
      ...original,
      ffmpegArguments: [],
      codecArguments: [],
    };
  }

  const descriptor = outputDescriptorForFormat(output.format, source);
  const mode = determineFfmpegMode(output.format, selectedTracks);
  const codecs = codecArguments(output.format, mode);
  return {
    mode,
    ...descriptor,
    ffmpegArguments: ["-i", "$INPUT", ...mapArguments, ...codecs, "$OUTPUT"],
    codecArguments: codecs,
  };
}

export function materializeFfmpegArguments(
  decision: ProcessingDecision,
  inputPath: string,
  outputPath: string,
): string[] {
  return decision.ffmpegArguments.map((argument) => {
    if (argument === "$INPUT") return inputPath;
    if (argument === "$OUTPUT") return outputPath;
    return argument;
  });
}

export function materializeFfmpegArgumentsForInputs(
  decision: ProcessingDecision,
  inputs: readonly {
    readonly path: string;
    readonly kind?: Track["kind"];
  }[],
  outputPath: string,
): string[] {
  return [
    ...inputs.flatMap((input) => ["-i", input.path]),
    ...inputs.flatMap((input, index) =>
      input.kind === undefined
        ? inputs.length === 1
          ? []
          : ["-map", `${index}:0`]
        : [
            "-map",
            input.kind === "audio"
              ? `${index}:a:0`
              : input.kind === "video"
                ? `${index}:v:0`
                : `${index}:s:0`,
          ],
    ),
    ...decision.codecArguments,
    outputPath,
  ];
}

function resolveSelectedTracks(
  source: ResolvedSource,
  selectedTrackIds: readonly string[],
): readonly Track[] {
  if (selectedTrackIds.length === 0) {
    return source.tracks;
  }
  if (source.tracks.length === 0) {
    throw new MediaProcessingError(
      "invalid_track_selection",
      "La fuente no declara pistas que puedan seleccionarse.",
    );
  }

  const requested = new Set(selectedTrackIds);
  const selected = source.tracks.filter((track) => requested.has(track.id));
  const missing = selectedTrackIds.filter(
    (trackId) => !selected.some((track) => track.id === trackId),
  );
  if (missing.length > 0) {
    throw new MediaProcessingError(
      "invalid_track_selection",
      `La fuente no contiene las pistas solicitadas: ${missing.join(", ")}.`,
    );
  }
  return selected;
}

function buildMapArguments(
  sourceTracks: readonly Track[],
  selectedTracks: readonly Track[],
): string[] {
  if (sourceTracks.length === 0 || selectedTracks.length === 0) {
    return [];
  }
  return selectedTracks.flatMap((track) => {
    const index = sourceTracks.findIndex(
      (candidate) => candidate.id === track.id,
    );
    return ["-map", `0:${index}`];
  });
}

function determineFfmpegMode(
  format: ContainerFormat,
  tracks: readonly Track[],
): Exclude<ProcessingMode, "passthrough"> {
  if (format === "original") {
    return "remux";
  }
  if (format === "mp3" || format === "wav") {
    return "transcode";
  }
  return tracks.every((track) => codecFitsContainer(track, format))
    ? "remux"
    : "transcode";
}

function codecFitsContainer(track: Track, format: ContainerFormat): boolean {
  if (track.kind === "subtitle") {
    return format === "mp4" && /^(?:mov_text|tx3g)$/i.test(track.codec ?? "");
  }
  const codec = (track.codec ?? "").toLowerCase();
  if (codec.length === 0) return false;
  if (format === "m4a") {
    return track.kind === "audio" && /^(?:aac|alac|mp3)$/.test(codec);
  }
  if (format === "mp4") {
    return track.kind === "video"
      ? /^(?:av1|h264|hevc|mpeg4)$/.test(codec)
      : /^(?:aac|alac|mp3)$/.test(codec);
  }
  if (format === "webm") {
    return track.kind === "video"
      ? /^(?:av1|vp8|vp9)$/.test(codec)
      : /^(?:opus|vorbis)$/.test(codec);
  }
  return false;
}

function codecArguments(
  format: ContainerFormat,
  mode: Exclude<ProcessingMode, "passthrough">,
): string[] {
  if (mode === "remux") return ["-c", "copy"];
  switch (format) {
    case "mp3":
      return ["-vn", "-c:a", "libmp3lame", "-q:a", "2"];
    case "wav":
      return ["-vn", "-c:a", "pcm_s16le"];
    case "m4a":
      return ["-vn", "-c:a", "aac", "-b:a", "192k"];
    case "mp4":
      return ["-c:v", "libx264", "-c:a", "aac"];
    case "webm":
      return ["-c:v", "libvpx-vp9", "-c:a", "libopus"];
    case "original":
      return ["-c", "copy"];
  }
}

function outputDescriptorForFormat(
  format: ContainerFormat,
  source: ResolvedSource,
): { outputExtension: string; mimeType: string } {
  switch (format) {
    case "mp3":
      return outputDescriptor("mp3", "audio/mpeg");
    case "m4a":
      return outputDescriptor("m4a", "audio/mp4");
    case "mp4":
      return outputDescriptor("mp4", "video/mp4");
    case "webm":
      return outputDescriptor(
        "webm",
        source.tracks.some((track) => track.kind === "video")
          ? "video/webm"
          : "audio/webm",
      );
    case "wav":
      return outputDescriptor("wav", "audio/wav");
    case "original":
      return outputDescriptor(
        extensionFromSource(source),
        source.kind === "adaptive"
          ? source.tracks.some((track) => track.kind === "video")
            ? "video/mp4"
            : "audio/mp4"
          : (normalizedMimeType(source.mimeType) ?? "application/octet-stream"),
      );
  }
}

function outputDescriptor(
  outputExtension: string,
  mimeType: string,
): { outputExtension: string; mimeType: string } {
  return { outputExtension, mimeType };
}

function extensionFromSource(source: ResolvedSource): string {
  if (source.kind === "adaptive") {
    return source.tracks.some((track) => track.kind === "video")
      ? "mp4"
      : "m4a";
  }
  const mime = normalizedMimeType(source.mimeType);
  const byMime: Readonly<Record<string, string>> = {
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/webm": "webm",
    "video/mp4": "mp4",
    "video/webm": "webm",
  };
  const mimeExtension = mime === undefined ? undefined : byMime[mime];
  if (mimeExtension !== undefined) return mimeExtension;

  const pathname = new URL(source.url).pathname;
  const match = /\.([a-z0-9]{1,8})$/i.exec(pathname);
  return match?.[1]?.toLowerCase() ?? "bin";
}

function normalizedMimeType(mimeType: string | undefined): string | undefined {
  return mimeType?.split(";", 1)[0]?.trim().toLowerCase();
}

function looksLikeIsoBmff(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && ascii(bytes, 4, 8) === "ftyp";
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function drmError(): MediaProcessingError {
  return new MediaProcessingError(
    "drm_protected",
    "La fuente parece cifrada o protegida con DRM y no se procesará.",
  );
}
