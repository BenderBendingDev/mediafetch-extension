import {
  MediaCandidateSchema,
  type MediaCandidate,
  type MediaKind,
} from "../domain/schemas";
import {
  DetectedResourceSchema,
  PageSnapshotSchema,
  type DetectedResource,
  type PageSnapshot,
} from "./contracts";

const MEDIA_URL_PATTERN =
  /\.(?:mp3|m4a|aac|wav|flac|ogg|opus|mp4|m4v|webm|mov|m3u8|mpd)(?:$|[?#])/i;
const MAX_JSON_LD_BYTES = 1_000_000;
const MAX_JSON_LD_NODES = 1_000;

interface PerformanceEntryLike {
  readonly name: string;
  readonly initiatorType?: string;
}

export function collectPageSnapshot(
  document: Document,
  performanceEntries: readonly PerformanceEntryLike[] = [],
): PageSnapshot {
  const pageUrl = requireSafeHttpUrl(document.location.href);
  const resources: DetectedResource[] = [];

  for (const media of document.querySelectorAll("video, audio")) {
    const element = media as HTMLMediaElement;
    const kind: MediaKind =
      element.tagName.toLowerCase() === "audio" ? "audio" : "video";
    const durationMs =
      Number.isFinite(element.duration) && element.duration >= 0
        ? Math.round(element.duration * 1_000)
        : undefined;
    pushResource(resources, {
      url: element.currentSrc || element.getAttribute("src"),
      baseUrl: pageUrl,
      source: "media",
      kind,
      mimeType: element.getAttribute("type") ?? undefined,
      title:
        element.getAttribute("title") ??
        element.getAttribute("aria-label") ??
        undefined,
      durationMs,
      thumbnailUrl:
        kind === "video"
          ? (element.getAttribute("poster") ?? undefined)
          : undefined,
    });

    for (const source of element.querySelectorAll("source[src]")) {
      pushResource(resources, {
        url: source.getAttribute("src"),
        baseUrl: pageUrl,
        source: "source",
        kind,
        mimeType: source.getAttribute("type") ?? undefined,
      });
    }
  }

  for (const source of document.querySelectorAll("source[src]")) {
    if (source.closest("video, audio") !== null) {
      continue;
    }
    pushResource(resources, {
      url: source.getAttribute("src"),
      baseUrl: pageUrl,
      source: "source",
      mimeType: source.getAttribute("type") ?? undefined,
    });
  }

  for (const entry of performanceEntries.slice(0, 2_000)) {
    if (
      MEDIA_URL_PATTERN.test(entry.name) ||
      entry.initiatorType === "audio" ||
      entry.initiatorType === "video"
    ) {
      pushResource(resources, {
        url: entry.name,
        baseUrl: pageUrl,
        source: "performance",
      });
    }
  }

  for (const script of document.querySelectorAll(
    'script[type="application/ld+json"]',
  )) {
    const text = script.textContent?.trim() ?? "";
    if (text.length === 0 || text.length > MAX_JSON_LD_BYTES) {
      continue;
    }
    try {
      collectJsonLdResources(JSON.parse(text) as unknown, pageUrl, resources);
    } catch {
      // Malformed page-owned JSON-LD is ignored.
    }
  }

  const isVimeoPage = isHost(pageUrl, ["vimeo.com"]);
  for (const anchor of document.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (
      anchor.hasAttribute("download") ||
      (isVimeoPage && href !== null && MEDIA_URL_PATTERN.test(href))
    ) {
      pushResource(resources, {
        url: href,
        baseUrl: pageUrl,
        source: "link",
        title: anchor.textContent?.trim() || undefined,
      });
    }
  }

  return PageSnapshotSchema.parse({
    pageUrl,
    title: document.title.trim().slice(0, 500),
    resources: deduplicateResources(resources).slice(0, 500),
  });
}

export function normalizeSnapshotCandidates(
  snapshotValue: unknown,
  discoveredAt = Date.now(),
): readonly MediaCandidate[] {
  const snapshot = PageSnapshotSchema.parse(snapshotValue);
  const platformAdapter = adapterForPage(snapshot.pageUrl);
  const candidates: MediaCandidate[] = [];

  for (const resource of deduplicateResources(snapshot.resources)) {
    const kind = resource.kind ?? inferKind(resource.url, resource.mimeType);
    const adapterId = platformAdapter ?? "generic";
    const value = {
      id: stableId(`${adapterId}\0${resource.url}`),
      pageUrl: snapshot.pageUrl,
      kind,
      discoveredAt,
      sourceHints: [{ adapterId, reference: resource.url }],
      ...(resource.title !== undefined || snapshot.title.length > 0
        ? { title: resource.title ?? snapshot.title }
        : {}),
      ...(resource.mimeType === undefined
        ? {}
        : { mimeType: normalizeMimeType(resource.mimeType) }),
      ...(resource.durationMs === undefined
        ? {}
        : { durationMs: resource.durationMs }),
      ...(resource.thumbnailUrl === undefined
        ? {}
        : { thumbnailUrl: resource.thumbnailUrl }),
    };
    const parsed = MediaCandidateSchema.safeParse(value);
    if (parsed.success) {
      candidates.push(parsed.data);
    }
  }
  return candidates;
}

export function mergeSnapshots(
  first: PageSnapshot,
  second: PageSnapshot,
): PageSnapshot {
  if (first.pageUrl !== second.pageUrl) {
    return first;
  }
  return PageSnapshotSchema.parse({
    pageUrl: first.pageUrl,
    title: first.title || second.title,
    resources: deduplicateResources([
      ...first.resources,
      ...second.resources,
    ]).slice(0, 500),
  });
}

interface ResourceInput {
  readonly url: string | null | undefined;
  readonly baseUrl: string;
  readonly source: DetectedResource["source"];
  readonly kind?: MediaKind | undefined;
  readonly mimeType?: string | undefined;
  readonly title?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly thumbnailUrl?: string | undefined;
}

function pushResource(
  resources: DetectedResource[],
  input: ResourceInput,
): void {
  const url = safeHttpUrl(input.url, input.baseUrl);
  if (url === undefined) {
    return;
  }
  const thumbnailUrl = safeHttpUrl(input.thumbnailUrl, input.baseUrl);
  const parsed = DetectedResourceSchema.safeParse({
    url,
    source: input.source,
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(cleanText(input.mimeType) === undefined
      ? {}
      : { mimeType: cleanText(input.mimeType) }),
    ...(cleanText(input.title) === undefined
      ? {}
      : { title: cleanText(input.title) }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }),
  });
  if (parsed.success) {
    resources.push(parsed.data);
  }
}

function collectJsonLdResources(
  root: unknown,
  pageUrl: string,
  resources: DetectedResource[],
): void {
  const queue: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_JSON_LD_NODES) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    visited += 1;
    if (current.depth > 12 || current.value === null) {
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const value of current.value.slice(0, 100)) {
        queue.push({ value, depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof current.value !== "object") {
      continue;
    }

    const object = current.value as Record<string, unknown>;
    const schemaType = stringValue(object["@type"])?.toLowerCase();
    const kind =
      schemaType?.includes("audio") === true
        ? "audio"
        : schemaType?.includes("video") === true
          ? "video"
          : undefined;
    const title = stringValue(object["name"]);
    const thumbnailUrl =
      stringValue(object["thumbnailUrl"]) ??
      (Array.isArray(object["thumbnailUrl"])
        ? stringValue(object["thumbnailUrl"][0])
        : undefined);

    for (const key of ["contentUrl", "embedUrl"] as const) {
      pushResource(resources, {
        url: stringValue(object[key]),
        baseUrl: pageUrl,
        source: "json-ld",
        ...(kind === undefined ? {} : { kind }),
        ...(title === undefined ? {} : { title }),
        ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }),
      });
    }

    for (const value of Object.values(object).slice(0, 100)) {
      if (typeof value === "object" && value !== null) {
        queue.push({ value, depth: current.depth + 1 });
      }
    }
  }
}

function deduplicateResources(
  resources: readonly DetectedResource[],
): DetectedResource[] {
  const byUrl = new Map<string, DetectedResource>();
  for (const resource of resources) {
    const existing = byUrl.get(resource.url);
    if (existing === undefined || resource.source !== "performance") {
      byUrl.set(resource.url, resource);
    }
  }
  return [...byUrl.values()];
}

function safeHttpUrl(
  value: string | null | undefined,
  baseUrl: string,
): string | undefined {
  if (value === undefined || value === null || value.trim().length === 0) {
    return undefined;
  }
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

function requireSafeHttpUrl(value: string): string {
  const parsed = safeHttpUrl(value, value);
  if (parsed === undefined) {
    throw new Error("The document URL is not a safe HTTP(S) URL");
  }
  return parsed;
}

function inferKind(url: string, mimeType?: string): MediaKind {
  const mime = mimeType?.toLowerCase() ?? "";
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  return /\.(?:mp3|m4a|aac|wav|flac|ogg|opus)(?:$|[?#])/i.test(url)
    ? "audio"
    : "video";
}

function normalizeMimeType(value: string): string {
  return value.toLowerCase().split(";", 1)[0]?.trim() || value.trim();
}

function adapterForPage(pageUrl: string): string | undefined {
  if (isHost(pageUrl, ["youtube.com", "youtu.be"])) {
    return "youtube-experimental";
  }
  if (isHost(pageUrl, ["tiktok.com"])) {
    return "tiktok-experimental";
  }
  if (isHost(pageUrl, ["vimeo.com"])) {
    return "vimeo";
  }
  return undefined;
}

function isHost(urlValue: string, domains: readonly string[]): boolean {
  const hostname = new URL(urlValue).hostname.toLowerCase();
  return domains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

function cleanText(value: string | undefined): string | undefined {
  const cleaned = value?.trim().slice(0, 500);
  return cleaned === undefined || cleaned.length === 0 ? undefined : cleaned;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? cleanText(value) : undefined;
}

function stableId(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `candidate-${(hash >>> 0).toString(36)}`;
}
