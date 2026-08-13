import {
  MAX_ADAPTIVE_SEGMENTS,
  MAX_MANIFEST_BYTES,
  parseUnencryptedDashManifest,
  parseUnencryptedHlsManifest,
  type ParsedManifest,
  type ParsedManifestTrack,
} from "../adapters/manifests";
import type { ResolvedSource, Track } from "../domain/schemas";
import {
  MediaProcessingError,
  normalizeMediaError,
  throwIfAborted,
} from "./errors";
import {
  assertSourceIsClear,
  assertWithinProcessingLimit,
  MAX_PROCESSING_BYTES,
} from "./policy";

export interface DownloadProgress {
  readonly completedBytes: number;
  readonly totalBytes?: number;
}

export interface DownloadedSource {
  readonly blob: Blob;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType?: string;
  readonly inputs: readonly DownloadedInput[];
}

export interface DownloadedInput {
  readonly blob: Blob;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType?: string;
  readonly track?: Track;
}

export interface DownloadOptions {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: DownloadProgress) => void | Promise<void>;
  readonly fetchImpl?: typeof fetch;
  readonly selectedTrackIds?: readonly string[];
}

export async function downloadSource(
  source: ResolvedSource,
  options: DownloadOptions,
): Promise<DownloadedSource> {
  assertSourceIsClear(source);
  assertWithinProcessingLimit(source.contentLength, "La fuente");
  throwIfAborted(options.signal);

  if (source.kind === "adaptive") {
    return downloadAdaptiveSource(source, options);
  }
  const state: DownloadState = {
    completedBytes: 0,
    ...(source.contentLength === undefined
      ? {}
      : { expectedBytes: source.contentLength }),
  };
  const resource = await downloadResource(source.url, options, state);
  if (
    source.contentLength !== undefined &&
    resource.bytes.byteLength < source.contentLength
  ) {
    throw new MediaProcessingError(
      "download_failed",
      `La descarga quedó incompleta (${resource.bytes.byteLength} de ${source.contentLength} bytes).`,
      true,
    );
  }
  assertSourceIsClear(source, resource.bytes);
  const mimeType = resource.mimeType ?? normalizedMimeType(source.mimeType);
  const input = downloadedInput(resource.bytes, mimeType);
  return {
    ...input,
    inputs: [input],
  };
}

interface DownloadState {
  completedBytes: number;
  readonly expectedBytes?: number;
}

interface DownloadedResource {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly mimeType?: string;
}

async function downloadAdaptiveSource(
  source: ResolvedSource,
  options: DownloadOptions,
): Promise<DownloadedSource> {
  const state: DownloadState = {
    completedBytes: 0,
  };
  const manifestResource = await downloadResource(
    source.url,
    options,
    state,
    MAX_MANIFEST_BYTES,
  );
  assertSourceIsClear(source, manifestResource.bytes);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(
    manifestResource.bytes,
  );
  let manifest: ParsedManifest;
  try {
    manifest = isHlsSource(source)
      ? parseUnencryptedHlsManifest(text, source.url)
      : isDashSource(source)
        ? parseUnencryptedDashManifest(text, source.url)
        : parseAdaptiveByContent(text, source.url);
  } catch (error) {
    throw new MediaProcessingError(
      "unsupported_adaptive",
      `El manifiesto adaptativo no es compatible: ${
        error instanceof Error ? error.message : String(error)
      }`,
      false,
      { cause: error },
    );
  }

  const selected = selectManifestTracks(
    manifest.tracks,
    source.tracks,
    options.selectedTrackIds ?? [],
  );
  const inputs: DownloadedInput[] = [];
  let segmentCount = 0;
  for (const selectedTrack of selected) {
    let track = selectedTrack.manifestTrack;
    if (track.playlistUrl !== undefined) {
      const childResource = await downloadResource(
        track.playlistUrl,
        options,
        state,
        MAX_MANIFEST_BYTES,
      );
      const childText = new TextDecoder("utf-8", { fatal: false }).decode(
        childResource.bytes,
      );
      let child: ParsedManifest;
      try {
        child = parseUnencryptedHlsManifest(childText, track.playlistUrl);
      } catch (error) {
        throw new MediaProcessingError(
          "unsupported_adaptive",
          `La playlist HLS seleccionada no es compatible: ${
            error instanceof Error ? error.message : String(error)
          }`,
          false,
          { cause: error },
        );
      }
      if (child.playlistType !== "media" || child.tracks[0] === undefined) {
        throw new MediaProcessingError(
          "unsupported_adaptive",
          "Solo se admite un nivel de playlist maestra HLS.",
        );
      }
      track = {
        ...child.tracks[0],
        id: track.id,
        ...(track.kind === undefined ? {} : { kind: track.kind }),
        ...(track.codec === undefined ? {} : { codec: track.codec }),
        ...(track.mimeType === undefined ? {} : { mimeType: track.mimeType }),
      };
    }

    segmentCount += track.segmentUrls.length;
    if (segmentCount > MAX_ADAPTIVE_SEGMENTS) {
      throw new MediaProcessingError(
        "unsupported_adaptive",
        `Las pistas seleccionadas superan el límite global de ${MAX_ADAPTIVE_SEGMENTS} segmentos.`,
      );
    }
    const resourceUrls = [
      ...(track.initializationUrl === undefined
        ? []
        : [track.initializationUrl]),
      ...track.segmentUrls,
    ];
    if (resourceUrls.length === 0) {
      throw new MediaProcessingError(
        "unsupported_adaptive",
        `La pista adaptativa ${track.id} no contiene segmentos.`,
      );
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    let segmentMimeType: string | undefined;
    for (const url of resourceUrls) {
      const resource = await downloadResource(url, options, state);
      chunks.push(resource.bytes);
      length += resource.bytes.byteLength;
      segmentMimeType ??= resource.mimeType;
    }
    const bytes = concatenate(chunks, length);
    assertSourceIsClear(source, bytes);
    inputs.push(
      downloadedInput(
        bytes,
        track.mimeType ?? segmentMimeType,
        materializeTrack(track, selectedTrack.sourceTrack),
      ),
    );
  }
  if (inputs.length === 0) {
    throw new MediaProcessingError(
      "unsupported_adaptive",
      "El manifiesto no produjo ninguna pista descargable.",
    );
  }
  const primary = inputs[0]!;
  return {
    blob: primary.blob,
    bytes: primary.bytes,
    ...(primary.mimeType === undefined ? {} : { mimeType: primary.mimeType }),
    inputs,
  };
}

async function downloadResource(
  url: string,
  options: DownloadOptions,
  state: DownloadState,
  resourceLimit = MAX_PROCESSING_BYTES,
): Promise<DownloadedResource> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      signal: options.signal,
      credentials: "include",
    });
  } catch (error) {
    const normalized = normalizeMediaError(error);
    if (normalized.code === "cancelled") throw normalized;
    throw new MediaProcessingError(
      "download_failed",
      `No se pudo descargar la fuente: ${normalized.message}`,
      true,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new MediaProcessingError(
      "download_failed",
      `La descarga respondió HTTP ${response.status} ${response.statusText}`.trim(),
      response.status === 408 ||
        response.status === 429 ||
        response.status >= 500,
    );
  }

  const headerLength = parseContentLength(
    response.headers.get("content-length"),
  );
  assertWithinProcessingLimit(headerLength, "La respuesta");
  if (
    headerLength !== undefined &&
    state.completedBytes + headerLength >= MAX_PROCESSING_BYTES
  ) {
    assertWithinProcessingLimit(
      state.completedBytes + headerLength,
      "La descarga acumulada",
    );
  }
  if (headerLength !== undefined && headerLength > resourceLimit) {
    throw new MediaProcessingError(
      "unsupported_adaptive",
      `Un manifiesto supera el límite de ${resourceLimit} bytes.`,
    );
  }
  const chunks: Uint8Array[] = [];
  let resourceBytes = 0;

  try {
    if (response.body === null) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      assertWithinProcessingLimit(bytes.byteLength, "La descarga");
      if (bytes.byteLength > resourceLimit) {
        throw new MediaProcessingError(
          "unsupported_adaptive",
          `Un manifiesto supera el límite de ${resourceLimit} bytes.`,
        );
      }
      resourceBytes = bytes.byteLength;
      state.completedBytes += bytes.byteLength;
      assertWithinProcessingLimit(
        state.completedBytes,
        "La descarga acumulada",
      );
      chunks.push(bytes);
      await options.onProgress(
        progress(state.completedBytes, state.expectedBytes),
      );
    } else {
      const reader = response.body.getReader();
      try {
        while (true) {
          throwIfAborted(options.signal);
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined || value.byteLength === 0) continue;
          resourceBytes += value.byteLength;
          state.completedBytes += value.byteLength;
          if (
            resourceBytes > resourceLimit ||
            state.completedBytes >= MAX_PROCESSING_BYTES
          ) {
            await reader.cancel("processing size limit exceeded");
            if (resourceBytes > resourceLimit) {
              throw new MediaProcessingError(
                "unsupported_adaptive",
                `Un manifiesto supera el límite de ${resourceLimit} bytes.`,
              );
            }
            assertWithinProcessingLimit(
              state.completedBytes,
              "La descarga acumulada",
            );
          }
          chunks.push(value);
          await options.onProgress(
            progress(state.completedBytes, state.expectedBytes),
          );
        }
      } finally {
        reader.releaseLock();
      }
    }
  } catch (error) {
    if (error instanceof MediaProcessingError) throw error;
    const normalized = normalizeMediaError(error);
    throw new MediaProcessingError(
      "download_failed",
      `La descarga se interrumpió: ${normalized.message}`,
      true,
      { cause: error },
    );
  }

  if (
    headerLength !== undefined &&
    resourceBytes !== headerLength &&
    resourceBytes < headerLength
  ) {
    throw new MediaProcessingError(
      "download_failed",
      `La descarga quedó incompleta (${resourceBytes} de ${headerLength} bytes).`,
      true,
    );
  }

  const bytes = concatenate(chunks, resourceBytes);
  const mimeType = normalizedMimeType(response.headers.get("content-type"));
  return {
    bytes,
    ...(mimeType === undefined ? {} : { mimeType }),
  };
}

interface SelectedManifestTrack {
  readonly manifestTrack: ParsedManifestTrack;
  readonly sourceTrack?: Track;
}

function selectManifestTracks(
  manifestTracks: readonly ParsedManifestTrack[],
  sourceTracks: readonly Track[],
  selectedTrackIds: readonly string[],
): readonly SelectedManifestTrack[] {
  if (selectedTrackIds.length > 0) {
    return selectedTrackIds.map((id) => {
      const exact = manifestTracks.find((track) => track.id === id);
      const sourceTrack = sourceTracks.find((track) => track.id === id);
      const byKind =
        sourceTrack === undefined
          ? undefined
          : manifestTracks.find((track) => track.kind === sourceTrack.kind);
      const manifestTrack = exact ?? byKind;
      if (manifestTrack === undefined) {
        throw new MediaProcessingError(
          "invalid_track_selection",
          `El manifiesto no contiene la pista solicitada: ${id}.`,
        );
      }
      return {
        manifestTrack,
        ...(sourceTrack === undefined ? {} : { sourceTrack }),
      };
    });
  }

  const selected: ParsedManifestTrack[] = [];
  for (const kind of ["video", "audio"] as const) {
    const track = manifestTracks.find((candidate) => candidate.kind === kind);
    if (track !== undefined) selected.push(track);
  }
  if (selected.length === 0 && manifestTracks[0] !== undefined) {
    selected.push(manifestTracks[0]);
  }
  return selected.map((manifestTrack) => ({ manifestTrack }));
}

function materializeTrack(
  parsed: ParsedManifestTrack,
  sourceTrack: Track | undefined,
): Track | undefined {
  if (sourceTrack !== undefined) return sourceTrack;
  if (parsed.kind === undefined) return undefined;
  return {
    id: parsed.id,
    kind: parsed.kind,
    ...(parsed.label === undefined ? {} : { label: parsed.label }),
    ...(parsed.language === undefined ? {} : { language: parsed.language }),
    ...(parsed.codec === undefined
      ? {}
      : { codec: normalizeCodec(parsed.codec) }),
    ...(parsed.mimeType === undefined
      ? {}
      : { container: parsed.mimeType.split("/", 2)[1] ?? parsed.mimeType }),
    ...(parsed.bandwidth === undefined ? {} : { bitrate: parsed.bandwidth }),
    isDefault: false,
  };
}

function normalizeCodec(codec: string): string {
  const first = codec.split(",", 1)[0]?.trim() ?? codec;
  if (/^(?:avc1|avc3)/i.test(first)) return "h264";
  if (/^(?:hev1|hvc1)/i.test(first)) return "hevc";
  if (/^mp4a/i.test(first)) return "aac";
  return first;
}

function downloadedInput(
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string | undefined,
  track?: Track,
): DownloadedInput {
  const blob =
    mimeType === undefined
      ? new Blob([bytes.buffer])
      : new Blob([bytes.buffer], { type: mimeType });
  return {
    blob,
    bytes,
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(track === undefined ? {} : { track }),
  };
}

function parseAdaptiveByContent(
  text: string,
  manifestUrl: string,
): ParsedManifest {
  if (text.trimStart().startsWith("#EXTM3U")) {
    return parseUnencryptedHlsManifest(text, manifestUrl);
  }
  if (/<(?:[a-z][\w.-]*:)?MPD(?:\s|>)/i.test(text)) {
    return parseUnencryptedDashManifest(text, manifestUrl);
  }
  throw new Error("Source is not an HLS or DASH manifest");
}

function isHlsSource(source: ResolvedSource): boolean {
  const mime = normalizedMimeType(source.mimeType);
  return (
    /\.m3u8(?:$|[?#])/i.test(source.url) ||
    mime === "application/vnd.apple.mpegurl" ||
    mime === "application/x-mpegurl"
  );
}

function isDashSource(source: ResolvedSource): boolean {
  return (
    /\.mpd(?:$|[?#])/i.test(source.url) ||
    normalizedMimeType(source.mimeType) === "application/dash+xml"
  );
}

function progress(
  completedBytes: number,
  totalBytes: number | undefined,
): DownloadProgress {
  const safeTotal =
    totalBytes === undefined ? undefined : Math.max(completedBytes, totalBytes);
  return {
    completedBytes,
    ...(safeTotal === undefined ? {} : { totalBytes: safeTotal }),
  };
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizedMimeType(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized === "" ? undefined : normalized;
}

function concatenate(
  chunks: readonly Uint8Array[],
  length: number,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
