// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { MediaCandidateSchema } from "../domain/schemas";
import {
  PageBridgeResponseSchema,
  PAGE_BRIDGE_CHANNEL,
  PAGE_BRIDGE_VERSION,
  collectPageSnapshot,
  normalizeSnapshotCandidates,
  parseSnapshotCollection,
} from ".";
import {
  parseUnencryptedDashManifest,
  parseUnencryptedHlsManifest,
} from "./manifests";
import { createDefaultResolverRegistry } from "./registry";
import { VimeoSourceResolver } from "./resolvers";

const SYNTHETIC_PAGE_FIXTURE = `<!doctype html>
<html>
  <head>
    <title>Authorized sample</title>
    <script type="application/ld+json">
      {
        "@type": "AudioObject",
        "name": "JSON-LD track",
        "contentUrl": "/media/track.mp3",
        "thumbnailUrl": "/cover.jpg"
      }
    </script>
  </head>
  <body>
    <video title="Demo video" poster="/poster.jpg">
      <source src="/media/video.mp4" type="video/mp4">
      <source src="javascript:alert(1)">
    </video>
    <a download href="/media/archive.webm">Public download</a>
  </body>
</html>`;

const CONSENT_DENIED = {
  granted: false,
  policyVersion: "1",
  updatedAt: 0,
} as const;
const CONSENT_GRANTED = {
  ...CONSENT_DENIED,
  granted: true,
} as const;

describe("safe page detection", () => {
  it("extracts and normalizes media, performance and JSON-LD URLs", () => {
    window.history.replaceState({}, "", "/watch/1");
    document.open();
    document.write(SYNTHETIC_PAGE_FIXTURE);
    document.close();
    const snapshot = collectPageSnapshot(document, [
      {
        name: "https://cdn.example.test/master.m3u8",
        initiatorType: "fetch",
      },
      { name: "data:video/mp4;base64,AAAA", initiatorType: "video" },
      { name: "https://example.test/analytics", initiatorType: "fetch" },
    ]);
    const candidates = normalizeSnapshotCandidates(snapshot, 100);

    expect(snapshot.resources.map((resource) => resource.url)).toEqual(
      expect.arrayContaining([
        `${window.location.origin}/media/video.mp4`,
        `${window.location.origin}/media/track.mp3`,
        `${window.location.origin}/media/archive.webm`,
        "https://cdn.example.test/master.m3u8",
      ]),
    );
    expect(
      snapshot.resources.some((resource) =>
        resource.url.startsWith("javascript:"),
      ),
    ).toBe(false);
    expect(
      candidates.every((candidate) => candidate.discoveredAt === 100),
    ).toBe(true);
    expect(
      candidates.find((candidate) => candidate.title === "JSON-LD track")?.kind,
    ).toBe("audio");
  });

  it("marks YouTube and TikTok candidates as experimental-only", async () => {
    const candidate = normalizeSnapshotCandidates(
      {
        pageUrl: "https://www.youtube.com/watch?v=public",
        title: "Exposed metadata",
        resources: [
          {
            url: "https://media.example.test/exposed.mp4",
            source: "json-ld",
            kind: "video",
          },
        ],
      },
      1,
    )[0];
    expect(candidate?.sourceHints[0]?.adapterId).toBe("youtube-experimental");

    const registry = createDefaultResolverRegistry();
    expect(registry.supporting(candidate!, CONSENT_DENIED)).toEqual([]);
    await expect(
      registry.resolve(candidate!, {
        signal: new AbortController().signal,
        consent: CONSENT_DENIED,
      }),
    ).rejects.toThrow("consent");

    const sources = await registry.resolve(candidate!, {
      signal: new AbortController().signal,
      consent: CONSENT_GRANTED,
    });
    expect(sources).toHaveLength(1);
    expect(sources[0]?.requiresExperimentalConsent).toBe(true);
  });

  it("rejects forged or oversized page-world payloads", () => {
    expect(
      PageBridgeResponseSchema.safeParse({
        channel: PAGE_BRIDGE_CHANNEL,
        version: PAGE_BRIDGE_VERSION,
        direction: "page-to-content",
        requestId: "request-1",
        kind: "snapshot.result",
        payload: {
          pageUrl: "https://example.test/",
          title: "",
          resources: [
            {
              url: `https://example.test/${"x".repeat(5_000)}`,
              source: "performance",
            },
          ],
        },
        injected: true,
      }).success,
    ).toBe(false);
  });
});

describe("source adapters", () => {
  it("accepts only page-exposed Vimeo links from Vimeo pages", async () => {
    const candidate = MediaCandidateSchema.parse({
      id: "vimeo-public",
      pageUrl: "https://vimeo.com/123",
      kind: "video",
      discoveredAt: 1,
      sourceHints: [
        {
          adapterId: "vimeo",
          reference: "https://cdn.example.test/public-download.mp4",
        },
      ],
    });
    const sources = await new VimeoSourceResolver().resolve(candidate, {
      signal: new AbortController().signal,
      consent: CONSENT_DENIED,
    });
    expect(sources.map((source) => source.url)).toEqual([
      "https://cdn.example.test/public-download.mp4",
    ]);
  });

  it("rejects encrypted HLS and protected DASH fixtures", () => {
    expect(() =>
      parseUnencryptedHlsManifest(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\nsegment.ts',
        "https://media.example/master.m3u8",
      ),
    ).toThrow("Encrypted HLS");
    expect(() =>
      parseUnencryptedDashManifest(
        '<MPD><Period><ContentProtection schemeIdUri="urn:uuid:test"/></Period></MPD>',
        "https://media.example/manifest.mpd",
      ),
    ).toThrow("Protected DASH");

    expect(
      parseUnencryptedHlsManifest(
        "#EXTM3U\n#EXT-X-KEY:METHOD=NONE\nsegment-1.ts\nsegment-2.ts",
        "https://media.example/path/master.m3u8",
      ).mediaUrls,
    ).toEqual([
      "https://media.example/path/segment-1.ts",
      "https://media.example/path/segment-2.ts",
    ]);
  });
});

describe("bounded snapshot pagination", () => {
  it("follows only supplied snapshots and enforces limits", () => {
    const result = parseSnapshotCollection(
      {
        type: "channel",
        id: "channel-1",
        snapshots: [
          {
            pageUrl: "https://example.test/channel?page=1",
            nextPageUrl: "https://example.test/channel?page=2",
            items: [{ id: "one", url: "https://example.test/media/one.mp4" }],
          },
          {
            pageUrl: "https://example.test/channel?page=2",
            nextPageUrl: "https://example.test/channel?page=3",
            items: [{ id: "two", url: "https://example.test/media/two.mp4" }],
          },
          {
            pageUrl: "https://example.test/channel?page=3",
            items: [
              { id: "three", url: "https://example.test/media/three.mp4" },
            ],
          },
        ],
      },
      { maxPages: 2, maxItems: 10 },
    );

    expect(result.items.map((item) => item.id)).toEqual(["one", "two"]);
    expect(result.visitedPages).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
