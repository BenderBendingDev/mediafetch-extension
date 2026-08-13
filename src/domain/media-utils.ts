import type { ContainerFormat, MediaCandidate, OutputRequest } from "./schemas";

// Filename sanitization intentionally matches C0 controls and DEL.
// eslint-disable-next-line no-control-regex
const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001F\u007F]/g;
const TRAILING_DOTS_OR_SPACES = /[. ]+$/g;
const RESERVED_WINDOWS_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const TEMPLATE_TOKEN = /\{(title|kind|candidateId|date)\}/g;

const FORMAT_EXTENSIONS: Readonly<Record<ContainerFormat, string | undefined>> =
  {
    original: undefined,
    mp3: "mp3",
    m4a: "m4a",
    mp4: "mp4",
    webm: "webm",
    wav: "wav",
  };

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export interface FilenameTemplateValues {
  readonly title: string;
  readonly kind: string;
  readonly candidateId: string;
  readonly date: string;
}

export function sanitizeFilenameSegment(
  input: string,
  fallback = "media",
  maxLength = 180,
): string {
  const normalized = input
    .normalize("NFKC")
    .replace(INVALID_FILENAME_CHARACTERS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(TRAILING_DOTS_OR_SPACES, "");

  const safeName =
    normalized.length === 0 || RESERVED_WINDOWS_NAME.test(normalized)
      ? `_${normalized || fallback}`
      : normalized;
  const truncated = Array.from(safeName).slice(0, maxLength).join("");
  return truncated.replace(TRAILING_DOTS_OR_SPACES, "") || fallback;
}

export function extensionForFormat(
  format: ContainerFormat,
  originalMimeType?: string,
): string | undefined {
  const configured = FORMAT_EXTENSIONS[format];
  if (configured !== undefined) {
    return configured;
  }
  if (originalMimeType === undefined) {
    return undefined;
  }
  return MIME_EXTENSIONS[originalMimeType.toLowerCase().split(";", 1)[0] ?? ""];
}

export function renderFilename(
  candidate: MediaCandidate,
  output: OutputRequest,
  now: number,
): string {
  const values: FilenameTemplateValues = {
    title: candidate.title ?? "media",
    kind: candidate.kind,
    candidateId: candidate.id,
    date: new Date(now).toISOString().slice(0, 10),
  };
  const basename = output.filenameTemplate.replace(
    TEMPLATE_TOKEN,
    (_match, token: keyof FilenameTemplateValues) => values[token],
  );
  const safeBasename = sanitizeFilenameSegment(basename);
  const extension = extensionForFormat(output.format, candidate.mimeType);
  return extension === undefined
    ? safeBasename
    : `${stripKnownExtension(safeBasename)}.${extension}`;
}

export function stripKnownExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) {
    return filename;
  }
  const extension = filename.slice(lastDot + 1).toLowerCase();
  return Object.values(MIME_EXTENSIONS).includes(extension)
    ? filename.slice(0, lastDot)
    : filename;
}

export function createDedupeKey(
  candidate: Pick<MediaCandidate, "id" | "pageUrl">,
  output: OutputRequest,
): string {
  const tracks = [...output.selectedTrackIds].sort().join(",");
  return [
    encodeURIComponent(candidate.pageUrl),
    encodeURIComponent(candidate.id),
    output.format,
    encodeURIComponent(tracks),
  ].join("|");
}

export function assertSupportedConversion(
  kind: MediaCandidate["kind"],
  format: ContainerFormat,
): void {
  const audioFormats: readonly ContainerFormat[] = [
    "original",
    "mp3",
    "m4a",
    "wav",
    "webm",
  ];
  const videoFormats: readonly ContainerFormat[] = ["original", "mp4", "webm"];
  const supported = kind === "audio" ? audioFormats : videoFormats;
  if (!supported.includes(format)) {
    throw new Error(`Format ${format} is not supported for ${kind}`);
  }
}
