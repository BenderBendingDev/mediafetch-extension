import type { ContainerFormat, MediaCandidate, Track } from "../domain/schemas";

export interface ImportedUrls {
  urls: string[];
  rejected: string[];
  truncated: boolean;
}

export type MediaUrlClassification = "collection" | "item" | "page" | "invalid";

export interface NormalizedCollectionLinks {
  urls: string[];
  truncated: boolean;
}

const DIRECT_MEDIA_PATH =
  /\.(?:mp3|m4a|aac|wav|flac|ogg|opus|mp4|m4v|webm|mov|m3u8|mpd)$/i;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);
const TIKTOK_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com"]);
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);

function safeHttpUrl(value: string, baseUrl?: string): URL | null {
  try {
    const url =
      baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function youtubeVideoId(url: URL): { id: string; shorts: boolean } | null {
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id && /^[\w-]{6,}$/.test(id) ? { id, shorts: false } : null;
  }
  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v");
    return id && /^[\w-]{6,}$/.test(id) ? { id, shorts: false } : null;
  }
  const shorts = url.pathname.match(/^\/shorts\/([\w-]{6,})(?:\/|$)/);
  return shorts?.[1] ? { id: shorts[1], shorts: true } : null;
}

function isYoutubeCollection(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host) || host === "youtu.be") return false;
  if (url.searchParams.has("list")) return true;
  return (
    url.pathname === "/playlist" ||
    /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(?:\/(?:videos|shorts|streams|playlists))?\/?$/.test(
      url.pathname,
    )
  );
}

function tiktokVideoId(url: URL): { handle: string; id: string } | null {
  if (!TIKTOK_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = url.pathname.match(/^\/@([^/]+)\/video\/(\d+)(?:\/|$)/);
  return match?.[1] && match[2] ? { handle: match[1], id: match[2] } : null;
}

function isTiktokCollection(url: URL): boolean {
  return (
    TIKTOK_HOSTS.has(url.hostname.toLowerCase()) &&
    /^\/@[^/]+\/?$/.test(url.pathname)
  );
}

function vimeoVideoId(url: URL): string | null {
  if (!VIMEO_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match =
    url.hostname.toLowerCase() === "player.vimeo.com"
      ? url.pathname.match(/^\/video\/(\d+)(?:\/|$)/)
      : url.pathname.match(/^\/(\d+)(?:\/|$)/);
  return match?.[1] ?? null;
}

function isVimeoCollection(url: URL): boolean {
  if (!VIMEO_HOSTS.has(url.hostname.toLowerCase())) return false;
  if (
    /^\/(?:showcase|album|channels)\/[^/]+(?:\/videos)?\/?$/.test(url.pathname)
  ) {
    return true;
  }
  const profile = url.pathname.match(/^\/([^/]+)\/?$/)?.[1];
  return (
    profile !== undefined &&
    !/^\d+$/.test(profile) &&
    !new Set([
      "about",
      "categories",
      "features",
      "help",
      "join",
      "log_in",
      "ondemand",
      "search",
      "terms",
      "upgrade",
      "watch",
    ]).has(profile.toLowerCase())
  );
}

export function classifyMediaUrl(value: string): MediaUrlClassification {
  const url = safeHttpUrl(value);
  if (url === null) return "invalid";
  if (
    isYoutubeCollection(url) ||
    isTiktokCollection(url) ||
    isVimeoCollection(url)
  ) {
    return "collection";
  }
  if (
    youtubeVideoId(url) !== null ||
    tiktokVideoId(url) !== null ||
    vimeoVideoId(url) !== null ||
    DIRECT_MEDIA_PATH.test(url.pathname)
  ) {
    return "item";
  }
  return "page";
}

export function normalizeCollectionItemUrl(
  value: string,
  baseUrl: string,
): string | null {
  const url = safeHttpUrl(value, baseUrl);
  if (url === null) return null;

  const youtube = youtubeVideoId(url);
  if (youtube !== null) {
    return youtube.shorts
      ? `https://www.youtube.com/shorts/${youtube.id}`
      : `https://www.youtube.com/watch?v=${youtube.id}`;
  }

  const tiktok = tiktokVideoId(url);
  if (tiktok !== null) {
    return `https://www.tiktok.com/@${tiktok.handle}/video/${tiktok.id}`;
  }

  const vimeo = vimeoVideoId(url);
  if (vimeo !== null) return `https://vimeo.com/${vimeo}`;

  if (!DIRECT_MEDIA_PATH.test(url.pathname)) return null;
  url.hash = "";
  return url.href;
}

export function normalizeCollectionItemLinks(
  values: readonly string[],
  baseUrl: string,
  limit: number,
): NormalizedCollectionLinks {
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = normalizeCollectionItemUrl(value, baseUrl);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }

  return {
    urls: urls.slice(0, safeLimit),
    truncated: urls.length > safeLimit,
  };
}

function firstColumn(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('"'))
    return (trimmed.split(/[,\t;]/, 1)[0] ?? "").trim();
  const closingQuote = trimmed.indexOf('"', 1);
  return (
    closingQuote === -1 ? trimmed.slice(1) : trimmed.slice(1, closingQuote)
  )
    .replaceAll('""', '"')
    .trim();
}

export function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function parseUrlImport(text: string, limit: number): ImportedUrls {
  const urls: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const value = firstColumn(rawLine);
    if (!value || /^url$/i.test(value)) continue;
    if (!isHttpUrl(value)) {
      rejected.push(value);
      continue;
    }
    if (!seen.has(value)) {
      seen.add(value);
      urls.push(value);
    }
  }

  const safeLimit = Math.max(1, Math.floor(limit));
  return {
    urls: urls.slice(0, safeLimit),
    rejected,
    truncated: urls.length > safeLimit,
  };
}

export function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return "—";
  const seconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "—";
  if (bytes < 1_024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_024;
  let unit = units[0]!;
  for (let index = 1; value >= 1_024 && index < units.length; index += 1) {
    value /= 1_024;
    unit = units[index]!;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function trackScore(track: Track): number {
  return (track.height ?? 0) * 1_000_000 + (track.bitrate ?? 0);
}

export type QualityPreference = "best" | "balanced" | "small";

export function tracksForQuality(
  candidate: MediaCandidate,
  quality: QualityPreference,
): string[] {
  const groups = new Map<Track["kind"], Track[]>();
  for (const track of candidate.tracks) {
    const group = groups.get(track.kind) ?? [];
    group.push(track);
    groups.set(track.kind, group);
  }

  const selected: string[] = [];
  for (const tracks of groups.values()) {
    const ordered = [...tracks].sort((a, b) => trackScore(a) - trackScore(b));
    const index =
      quality === "best"
        ? ordered.length - 1
        : quality === "small"
          ? 0
          : Math.floor((ordered.length - 1) / 2);
    const track = ordered[index];
    if (track !== undefined) selected.push(track.id);
  }
  return selected;
}

export function availableFormats(candidate: MediaCandidate): ContainerFormat[] {
  return candidate.kind === "audio"
    ? ["original", "mp3", "m4a", "wav"]
    : ["original", "mp4", "webm", "mp3"];
}
