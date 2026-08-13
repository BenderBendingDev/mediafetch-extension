import {
  assertResolverConsent,
  type ResolveContext,
  type SourceResolver,
} from "../domain/adapters";
import {
  ResolvedSourceSchema,
  type MediaCandidate,
  type ResolvedSource,
  type ResolvedSourceKind,
} from "../domain/schemas";
import {
  parseUnencryptedDashManifest,
  parseUnencryptedHlsManifest,
  type ParsedManifest,
} from "./manifests";

const HLS_PATTERN = /\.m3u8(?:$|[?#])/i;
const DASH_PATTERN = /\.mpd(?:$|[?#])/i;

abstract class ExposedUrlResolver implements SourceResolver {
  abstract readonly id: string;
  abstract readonly experimental: boolean;

  supports(candidate: MediaCandidate): boolean {
    return candidate.sourceHints.some((hint) => hint.adapterId === this.id);
  }

  async resolve(
    candidate: MediaCandidate,
    context: ResolveContext,
  ): Promise<readonly ResolvedSource[]> {
    if (context.signal.aborted) {
      throw context.signal.reason;
    }
    assertResolverConsent(this, context.consent);
    if (!this.supports(candidate)) {
      return [];
    }

    const sources: ResolvedSource[] = [];
    for (const hint of candidate.sourceHints) {
      if (hint.adapterId !== this.id) {
        continue;
      }
      const url = parseExposedHttpUrl(hint.reference);
      if (url === undefined || !this.acceptUrl(url, candidate)) {
        continue;
      }
      const parsed = ResolvedSourceSchema.safeParse({
        id: resolvedId(this.id, url),
        candidateId: candidate.id,
        adapterId: this.id,
        kind: sourceKind(url, candidate.mimeType),
        url,
        ...(candidate.mimeType === undefined
          ? {}
          : { mimeType: candidate.mimeType }),
        tracks: candidate.tracks,
        requiresExperimentalConsent: this.experimental,
      });
      if (parsed.success) {
        sources.push(parsed.data);
      }
    }
    return deduplicateSources(sources);
  }

  protected acceptUrl(_url: string, _candidate: MediaCandidate): boolean {
    return true;
  }
}

export class GenericSourceResolver extends ExposedUrlResolver {
  readonly id = "generic";
  readonly experimental = false;

  validateAdaptiveManifest(
    source: ResolvedSource,
    manifestText: string,
  ): ParsedManifest {
    if (isHls(source.url, source.mimeType)) {
      return parseUnencryptedHlsManifest(manifestText, source.url);
    }
    if (isDash(source.url, source.mimeType)) {
      return parseUnencryptedDashManifest(manifestText, source.url);
    }
    throw new Error("Source is not an HLS or DASH manifest");
  }
}

export class VimeoSourceResolver extends ExposedUrlResolver {
  readonly id = "vimeo";
  readonly experimental = false;

  protected override acceptUrl(
    _url: string,
    candidate: MediaCandidate,
  ): boolean {
    return isDomain(candidate.pageUrl, ["vimeo.com"]);
  }
}

export class YouTubeExperimentalResolver extends ExposedUrlResolver {
  readonly id = "youtube-experimental";
  readonly experimental = true;

  protected override acceptUrl(
    _url: string,
    candidate: MediaCandidate,
  ): boolean {
    return isDomain(candidate.pageUrl, ["youtube.com", "youtu.be"]);
  }
}

export class TikTokExperimentalResolver extends ExposedUrlResolver {
  readonly id = "tiktok-experimental";
  readonly experimental = true;

  protected override acceptUrl(
    _url: string,
    candidate: MediaCandidate,
  ): boolean {
    return isDomain(candidate.pageUrl, ["tiktok.com"]);
  }
}

function parseExposedHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
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

function sourceKind(url: string, mimeType?: string): ResolvedSourceKind {
  if (isHls(url, mimeType) || isDash(url, mimeType)) {
    return "adaptive";
  }
  return "direct";
}

function isHls(url: string, mimeType?: string): boolean {
  const mime = mimeType?.toLowerCase();
  return (
    HLS_PATTERN.test(url) ||
    mime === "application/vnd.apple.mpegurl" ||
    mime === "application/x-mpegurl"
  );
}

function isDash(url: string, mimeType?: string): boolean {
  return (
    DASH_PATTERN.test(url) || mimeType?.toLowerCase() === "application/dash+xml"
  );
}

function isDomain(urlValue: string, domains: readonly string[]): boolean {
  const hostname = new URL(urlValue).hostname.toLowerCase();
  return domains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

function resolvedId(adapterId: string, url: string): string {
  let hash = 2_166_136_261;
  for (const character of `${adapterId}\0${url}`) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `source-${(hash >>> 0).toString(36)}`;
}

function deduplicateSources(
  sources: readonly ResolvedSource[],
): readonly ResolvedSource[] {
  return [...new Map(sources.map((source) => [source.url, source])).values()];
}
