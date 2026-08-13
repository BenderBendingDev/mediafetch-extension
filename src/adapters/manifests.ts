import type { TrackKind } from "../domain/schemas";

export const MAX_ADAPTIVE_TRACKS = 64;
export const MAX_ADAPTIVE_SEGMENTS = 4_096;
export const MAX_MANIFEST_BYTES = 2_000_000;

export interface ParsedManifestTrack {
  readonly id: string;
  readonly kind?: TrackKind;
  readonly label?: string;
  readonly language?: string;
  readonly codec?: string;
  readonly mimeType?: string;
  readonly bandwidth?: number;
  readonly playlistUrl?: string;
  readonly initializationUrl?: string;
  readonly segmentUrls: readonly string[];
}

export interface ParsedManifest {
  readonly kind: "hls" | "dash";
  readonly playlistType?: "master" | "media";
  readonly mediaUrls: readonly string[];
  readonly tracks: readonly ParsedManifestTrack[];
}

const MAX_MANIFEST_LINES = 20_000;
const HLS_KEY_PATTERN = /^#EXT-X-(?:SESSION-)?KEY:(.*)$/i;
const HLS_UNSUPPORTED_PATTERN =
  /^#EXT-X-(?:BYTERANGE|DISCONTINUITY|DISCONTINUITY-SEQUENCE|PART|PRELOAD-HINT|SKIP)(?::|$)/i;

export function parseUnencryptedHlsManifest(
  text: string,
  manifestUrl: string,
): ParsedManifest {
  assertManifestSize(text);
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.length > MAX_MANIFEST_LINES || lines[0] !== "#EXTM3U") {
    throw new Error("Invalid or oversized HLS manifest");
  }
  assertSupportedHlsTags(lines);

  const isMaster = lines.some((line) =>
    /^#EXT-X-(?:STREAM-INF|MEDIA):/i.test(line),
  );
  return isMaster
    ? parseHlsMaster(lines, manifestUrl)
    : parseHlsMedia(lines, manifestUrl);
}

export function parseUnencryptedDashManifest(
  text: string,
  manifestUrl: string,
): ParsedManifest {
  assertManifestSize(text);
  if (!/<(?:[a-z][\w.-]*:)?MPD(?:\s|>)/i.test(text)) {
    throw new Error("Invalid DASH manifest");
  }
  if (
    /<(?:[a-z][\w.-]*:)?(?:ContentProtection|pssh|pro|license)\b/i.test(text)
  ) {
    throw new Error("Protected DASH manifests are not supported");
  }
  if (/<(?:[a-z][\w.-]*:)?SegmentBase\b/i.test(text)) {
    throw new Error("DASH SegmentBase and byte ranges are not supported");
  }
  if (/\b(?:mediaRange|indexRange|range)\s*=/i.test(text)) {
    throw new Error("DASH byte ranges are not supported");
  }
  if (/<(?:[a-z][\w.-]*:)?SegmentTimeline\b/i.test(text)) {
    throw new Error("DASH SegmentTimeline is not supported");
  }

  const mpd = requireElement(text, "MPD");
  const mpdAttributes = parseXmlAttributes(mpd.attributes);
  if ((mpdAttributes.type ?? "static").toLowerCase() !== "static") {
    throw new Error("Only static DASH MPDs are supported");
  }
  const mpdDuration = parseIsoDuration(mpdAttributes.mediaPresentationDuration);
  const mpdBase = resolveOptionalBase(manifestUrl, directBaseUrl(mpd.body));
  const periods = extractElements(mpd.body, "Period");
  if (periods.length === 0) {
    throw new Error("DASH MPD does not contain a Period");
  }
  if (periods.length > 1) {
    throw new Error("Only single-Period DASH MPDs are supported");
  }

  const tracks: ParsedManifestTrack[] = [];
  for (const period of periods) {
    const periodAttributes = parseXmlAttributes(period.attributes);
    const periodDuration =
      parseIsoDuration(periodAttributes.duration) ?? mpdDuration;
    const periodBase = resolveOptionalBase(mpdBase, directBaseUrl(period.body));
    for (const adaptation of extractElements(period.body, "AdaptationSet")) {
      appendDashAdaptationTracks(
        tracks,
        adaptation,
        periodBase,
        periodDuration,
      );
      if (tracks.length > MAX_ADAPTIVE_TRACKS) {
        throw new Error("DASH manifest exceeds the adaptive track limit");
      }
    }
  }
  if (tracks.length === 0) {
    throw new Error(
      "DASH MPD has no supported SegmentList or SegmentTemplate tracks",
    );
  }
  return {
    kind: "dash",
    mediaUrls: unique(
      tracks.flatMap((track) => [
        ...(track.initializationUrl === undefined
          ? []
          : [track.initializationUrl]),
        ...track.segmentUrls,
      ]),
    ),
    tracks,
  };
}

function parseHlsMaster(
  lines: readonly string[],
  manifestUrl: string,
): ParsedManifest {
  const tracks: ParsedManifestTrack[] = [];
  const renditionUrls = new Set<string>();

  for (const line of lines) {
    const mediaMatch = /^#EXT-X-MEDIA:(.*)$/i.exec(line);
    if (mediaMatch === null) continue;
    const attributes = parseAttributeList(mediaMatch[1] ?? "");
    const type = attributes.TYPE?.toUpperCase();
    const kind =
      type === "AUDIO" ? "audio" : type === "VIDEO" ? "video" : undefined;
    if (kind === undefined || attributes.URI === undefined) continue;
    const playlistUrl = requireManifestUrl(attributes.URI, manifestUrl);
    renditionUrls.add(playlistUrl);
    tracks.push({
      id: boundedId(
        attributes.NAME ??
          attributes["GROUP-ID"] ??
          `hls-${kind}-${tracks.length + 1}`,
      ),
      kind,
      ...(attributes.NAME === undefined ? {} : { label: attributes.NAME }),
      ...(attributes.LANGUAGE === undefined
        ? {}
        : { language: attributes.LANGUAGE }),
      playlistUrl,
      segmentUrls: [],
    });
  }

  for (let index = 0; index < lines.length; index += 1) {
    const streamMatch = /^#EXT-X-STREAM-INF:(.*)$/i.exec(lines[index] ?? "");
    if (streamMatch === null) continue;
    const uri = nextUri(lines, index + 1);
    if (uri === undefined) {
      throw new Error("HLS EXT-X-STREAM-INF is missing its playlist URI");
    }
    const attributes = parseAttributeList(streamMatch[1] ?? "");
    const playlistUrl = requireManifestUrl(uri, manifestUrl);
    if (renditionUrls.has(playlistUrl)) continue;
    const codec = attributes.CODECS;
    const kind = inferHlsVariantKind(codec, attributes.AUDIO);
    tracks.push({
      id: boundedId(`hls-variant-${tracks.length + 1}`),
      ...(kind === undefined ? {} : { kind }),
      ...(codec === undefined ? {} : { codec }),
      ...(positiveInteger(attributes.BANDWIDTH) === undefined
        ? {}
        : { bandwidth: positiveInteger(attributes.BANDWIDTH)! }),
      playlistUrl,
      segmentUrls: [],
    });
  }

  if (tracks.length === 0) {
    throw new Error("HLS master playlist has no supported renditions");
  }
  if (tracks.length > MAX_ADAPTIVE_TRACKS) {
    throw new Error("HLS master playlist exceeds the adaptive track limit");
  }
  return {
    kind: "hls",
    playlistType: "master",
    mediaUrls: unique(
      tracks.flatMap((track) =>
        track.playlistUrl === undefined ? [] : [track.playlistUrl],
      ),
    ),
    tracks,
  };
}

function parseHlsMedia(
  lines: readonly string[],
  manifestUrl: string,
): ParsedManifest {
  const segmentUrls: string[] = [];
  let initializationUrl: string | undefined;
  for (const line of lines) {
    const mapMatch = /^#EXT-X-MAP:(.*)$/i.exec(line);
    if (mapMatch !== null) {
      const attributes = parseAttributeList(mapMatch[1] ?? "");
      if (attributes.BYTERANGE !== undefined) {
        throw new Error("HLS byte ranges are not supported");
      }
      if (attributes.URI === undefined) {
        throw new Error("HLS EXT-X-MAP is missing URI");
      }
      initializationUrl = requireManifestUrl(attributes.URI, manifestUrl);
      continue;
    }
    if (line.length > 0 && !line.startsWith("#")) {
      segmentUrls.push(requireManifestUrl(line, manifestUrl));
      if (segmentUrls.length > MAX_ADAPTIVE_SEGMENTS) {
        throw new Error("HLS media playlist exceeds the segment limit");
      }
    }
  }
  if (segmentUrls.length === 0) {
    throw new Error("HLS media playlist contains no segments");
  }
  const track: ParsedManifestTrack = {
    id: "hls-media",
    ...(initializationUrl === undefined ? {} : { initializationUrl }),
    segmentUrls,
  };
  return {
    kind: "hls",
    playlistType: "media",
    mediaUrls: [
      ...(initializationUrl === undefined ? [] : [initializationUrl]),
      ...segmentUrls,
    ],
    tracks: [track],
  };
}

function assertSupportedHlsTags(lines: readonly string[]): void {
  for (const line of lines) {
    const key = HLS_KEY_PATTERN.exec(line);
    if (
      key !== null &&
      !/(?:^|,)\s*METHOD\s*=\s*NONE(?:,|$)/i.test(key[1] ?? "")
    ) {
      throw new Error("Encrypted HLS manifests are not supported");
    }
    if (HLS_UNSUPPORTED_PATTERN.test(line)) {
      if (/BYTERANGE/i.test(line)) {
        throw new Error("HLS byte ranges are not supported");
      }
      if (/DISCONTINUITY/i.test(line)) {
        throw new Error("HLS discontinuities are not supported");
      }
      throw new Error("Low-latency or delta HLS playlists are not supported");
    }
  }
}

function appendDashAdaptationTracks(
  tracks: ParsedManifestTrack[],
  adaptation: XmlElement,
  inheritedBase: string,
  durationSeconds: number | undefined,
): void {
  const adaptationAttributes = parseXmlAttributes(adaptation.attributes);
  const adaptationBase = resolveOptionalBase(
    inheritedBase,
    directBaseUrl(adaptation.body),
  );
  const inheritedList = firstElementBefore(
    adaptation.body,
    "SegmentList",
    "Representation",
  );
  const inheritedTemplate = firstElementBefore(
    adaptation.body,
    "SegmentTemplate",
    "Representation",
  );
  const representations = extractElements(adaptation.body, "Representation");
  const candidates =
    representations.length === 0
      ? [{ attributes: adaptation.attributes, body: adaptation.body }]
      : representations;

  for (const [index, representation] of candidates.entries()) {
    const representationAttributes = parseXmlAttributes(
      representation.attributes,
    );
    const attributes = {
      ...adaptationAttributes,
      ...representationAttributes,
    };
    const baseUrl = resolveOptionalBase(
      adaptationBase,
      directBaseUrl(representation.body),
    );
    const segmentList =
      firstElement(representation.body, "SegmentList") ?? inheritedList;
    const segmentTemplate =
      firstElement(representation.body, "SegmentTemplate") ?? inheritedTemplate;
    const resources =
      segmentList !== undefined
        ? parseDashSegmentList(segmentList, baseUrl)
        : segmentTemplate !== undefined
          ? parseDashSegmentTemplate(
              segmentTemplate,
              baseUrl,
              attributes,
              durationSeconds,
            )
          : undefined;
    if (resources === undefined) continue;

    const kind = inferDashKind(attributes);
    const id = boundedId(
      representationAttributes.id ??
        adaptationAttributes.id ??
        `dash-${kind ?? "track"}-${tracks.length + index + 1}`,
    );
    tracks.push({
      id,
      ...(kind === undefined ? {} : { kind }),
      ...(attributes.lang === undefined ? {} : { language: attributes.lang }),
      ...(attributes.codecs === undefined ? {} : { codec: attributes.codecs }),
      ...(attributes.mimeType === undefined
        ? {}
        : { mimeType: attributes.mimeType }),
      ...(positiveInteger(attributes.bandwidth) === undefined
        ? {}
        : { bandwidth: positiveInteger(attributes.bandwidth)! }),
      ...resources,
    });
  }
}

function parseDashSegmentList(
  element: XmlElement,
  baseUrl: string,
): Pick<ParsedManifestTrack, "initializationUrl" | "segmentUrls"> {
  const initialization = firstElement(element.body, "Initialization");
  const initializationAttributes =
    initialization === undefined
      ? {}
      : parseXmlAttributes(initialization.attributes);
  const initializationValue = initializationAttributes.sourceURL;
  const segmentUrls = extractElements(element.body, "SegmentURL").map(
    (segment) => {
      const media = parseXmlAttributes(segment.attributes).media;
      if (media === undefined) {
        throw new Error("DASH SegmentURL is missing media");
      }
      return requireManifestUrl(media, baseUrl);
    },
  );
  assertDashSegmentCount(segmentUrls);
  return {
    ...(initializationValue === undefined
      ? {}
      : {
          initializationUrl: requireManifestUrl(initializationValue, baseUrl),
        }),
    segmentUrls,
  };
}

function parseDashSegmentTemplate(
  element: XmlElement,
  baseUrl: string,
  representation: Readonly<Record<string, string>>,
  durationSeconds: number | undefined,
): Pick<ParsedManifestTrack, "initializationUrl" | "segmentUrls"> {
  const template = parseXmlAttributes(element.attributes);
  const media = template.media;
  const initialization = template.initialization;
  const duration = positiveNumber(template.duration);
  const timescale = positiveNumber(template.timescale) ?? 1;
  const startNumber = positiveInteger(template.startNumber) ?? 1;
  if (
    media === undefined ||
    duration === undefined ||
    durationSeconds === undefined
  ) {
    throw new Error(
      "DASH SegmentTemplate requires media, duration and a static MPD duration",
    );
  }
  const count = Math.ceil(durationSeconds / (duration / timescale));
  if (count < 1 || count > MAX_ADAPTIVE_SEGMENTS) {
    throw new Error("DASH SegmentTemplate exceeds the segment limit");
  }
  const segmentUrls = Array.from({ length: count }, (_, index) =>
    requireManifestUrl(
      substituteDashTemplate(media, representation, startNumber + index),
      baseUrl,
    ),
  );
  return {
    ...(initialization === undefined
      ? {}
      : {
          initializationUrl: requireManifestUrl(
            substituteDashTemplate(initialization, representation, startNumber),
            baseUrl,
          ),
        }),
    segmentUrls,
  };
}

interface XmlElement {
  readonly attributes: string;
  readonly body: string;
}

function extractElements(text: string, localName: string): XmlElement[] {
  const prefix = String.raw`(?:[a-z][\w.-]*:)?`;
  const pattern = new RegExp(
    String.raw`<${prefix}${localName}\b([^>]*?)(?:\/>|>([\s\S]*?)<\/${prefix}${localName}\s*>)`,
    "gi",
  );
  return [...text.matchAll(pattern)].map((match) => ({
    attributes: match[1] ?? "",
    body: match[2] ?? "",
  }));
}

function requireElement(text: string, localName: string): XmlElement {
  const element = extractElements(text, localName)[0];
  if (element === undefined) {
    throw new Error(`Invalid DASH manifest: missing ${localName}`);
  }
  return element;
}

function firstElement(text: string, localName: string): XmlElement | undefined {
  return extractElements(text, localName)[0];
}

function firstElementBefore(
  text: string,
  localName: string,
  boundaryName: string,
): XmlElement | undefined {
  const prefix = String.raw`(?:[a-z][\w.-]*:)?`;
  const elementPattern = new RegExp(
    String.raw`<${prefix}${localName}\b([^>]*?)(?:\/>|>([\s\S]*?)<\/${prefix}${localName}\s*>)`,
    "i",
  );
  const match = elementPattern.exec(text);
  if (match === null) return undefined;
  const boundary = text.search(
    new RegExp(String.raw`<${prefix}${boundaryName}\b`, "i"),
  );
  if (boundary >= 0 && match.index > boundary) return undefined;
  return { attributes: match[1] ?? "", body: match[2] ?? "" };
}

function parseXmlAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of value.matchAll(pattern)) {
    const rawName = match[1];
    if (rawName === undefined) continue;
    const name = rawName.includes(":")
      ? (rawName.split(":").at(-1) ?? rawName)
      : rawName;
    attributes[name] = decodeBasicXmlEntities(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function directBaseUrl(body: string): string | undefined {
  const match =
    /<(?:[a-z][\w.-]*:)?BaseURL(?:\s[^>]*)?>([^<]+)<\/(?:[a-z][\w.-]*:)?BaseURL\s*>/i.exec(
      body,
    );
  if (match === null) return undefined;
  const firstNested = body.search(
    /<(?:[a-z][\w.-]*:)?(?:Period|AdaptationSet|Representation)\b/i,
  );
  if (firstNested >= 0 && (match.index ?? 0) > firstNested) return undefined;
  return decodeBasicXmlEntities(match[1]?.trim() ?? "");
}

function resolveOptionalBase(
  baseUrl: string,
  value: string | undefined,
): string {
  return value === undefined ? baseUrl : requireManifestUrl(value, baseUrl);
}

function inferDashKind(
  attributes: Readonly<Record<string, string>>,
): TrackKind | undefined {
  const value = `${attributes.contentType ?? ""} ${attributes.mimeType ?? ""}`;
  if (/\baudio\b/i.test(value)) return "audio";
  if (/\bvideo\b/i.test(value)) return "video";
  if (/\b(?:text|subtitle|application)\b/i.test(value)) return "subtitle";
  return undefined;
}

function substituteDashTemplate(
  template: string,
  representation: Readonly<Record<string, string>>,
  number: number,
): string {
  const substituted = template
    .replaceAll("$$", "\0")
    .replaceAll("$RepresentationID$", representation.id ?? "")
    .replaceAll("$Bandwidth$", representation.bandwidth ?? "")
    .replace(/\$Number(?:%0(\d+)d)?\$/g, (_match, width: string | undefined) =>
      width === undefined
        ? String(number)
        : String(number).padStart(Number(width), "0"),
    )
    .replaceAll("\0", "$");
  if (/\$[^$]+\$/.test(substituted)) {
    throw new Error("DASH SegmentTemplate contains an unsupported placeholder");
  }
  return substituted;
}

function parseIsoDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      value,
    );
  if (match === null) return undefined;
  return (
    Number(match[1] ?? 0) * 86_400 +
    Number(match[2] ?? 0) * 3_600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0)
  );
}

function assertDashSegmentCount(segmentUrls: readonly string[]): void {
  if (segmentUrls.length === 0) {
    throw new Error("DASH SegmentList contains no segments");
  }
  if (segmentUrls.length > MAX_ADAPTIVE_SEGMENTS) {
    throw new Error("DASH SegmentList exceeds the segment limit");
  }
}

function parseAttributeList(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
  for (const match of value.matchAll(pattern)) {
    const name = match[1]?.toUpperCase();
    const raw = match[2]?.trim();
    if (name === undefined || raw === undefined) continue;
    attributes[name] =
      raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replaceAll('\\"', '"')
        : raw;
  }
  return attributes;
}

function nextUri(
  lines: readonly string[],
  startIndex: number,
): string | undefined {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) continue;
    return line.startsWith("#") ? undefined : line;
  }
  return undefined;
}

function inferHlsVariantKind(
  codecs: string | undefined,
  audioGroup: string | undefined,
): TrackKind | undefined {
  if (audioGroup !== undefined) return "video";
  if (codecs === undefined) return undefined;
  const hasVideo = /(?:avc|hvc|hev|av01|vp0?9|vp8)/i.test(codecs);
  const hasAudio = /(?:mp4a|aac|ac-3|ec-3|opus|vorbis)/i.test(codecs);
  if (hasVideo && !hasAudio) return "video";
  if (hasAudio && !hasVideo) return "audio";
  return undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function boundedId(value: string): string {
  const normalized = value.trim().slice(0, 200);
  return normalized.length === 0 ? "adaptive-track" : normalized;
}

function assertManifestSize(text: string): void {
  if (text.length === 0 || text.length > MAX_MANIFEST_BYTES) {
    throw new Error("Manifest is empty or oversized");
  }
}

function requireManifestUrl(value: string, baseUrl: string): string {
  const url = safeManifestUrl(value, baseUrl);
  if (url === undefined) {
    throw new Error("Manifest contains an invalid or non-HTTP(S) URL");
  }
  return url;
}

function safeManifestUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(value, baseUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.href.length > 4_096
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function decodeBasicXmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}
