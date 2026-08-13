import { describe, expect, it } from "vitest";
import {
  classifyMediaUrl,
  normalizeCollectionItemLinks,
  normalizeCollectionItemUrl,
  parseUrlImport,
  tracksForQuality,
} from "./utils";
import { MediaCandidateSchema } from "../domain/schemas";

describe("collection link classification and normalization", () => {
  it("classifies supported collection, item, page, and invalid URLs", () => {
    expect(
      classifyMediaUrl("https://www.youtube.com/playlist?list=synthetic"),
    ).toBe("collection");
    expect(classifyMediaUrl("https://www.tiktok.com/@synthetic")).toBe(
      "collection",
    );
    expect(classifyMediaUrl("https://vimeo.com/showcase/synthetic")).toBe(
      "collection",
    );
    expect(classifyMediaUrl("https://vimeo.com/synthetic-profile")).toBe(
      "collection",
    );
    expect(
      classifyMediaUrl("https://www.youtube.com/watch?v=abcdefghijk"),
    ).toBe("item");
    expect(classifyMediaUrl("https://example.test/article")).toBe("page");
    expect(classifyMediaUrl("javascript:alert(1)")).toBe("invalid");
  });

  it("normalizes supported visible item links without tracking data", () => {
    const baseUrl = "https://www.youtube.com/@synthetic/videos";

    expect(
      normalizeCollectionItemUrl(
        "/watch?v=abcdefghijk&list=synthetic&index=2",
        baseUrl,
      ),
    ).toBe("https://www.youtube.com/watch?v=abcdefghijk");
    expect(
      normalizeCollectionItemUrl(
        "https://m.youtube.com/shorts/lmnopqrstuv?feature=share",
        baseUrl,
      ),
    ).toBe("https://www.youtube.com/shorts/lmnopqrstuv");
    expect(
      normalizeCollectionItemUrl(
        "https://www.tiktok.com/@profile/video/1234567890123456789?lang=en",
        baseUrl,
      ),
    ).toBe("https://www.tiktok.com/@profile/video/1234567890123456789");
    expect(
      normalizeCollectionItemUrl(
        "https://player.vimeo.com/video/987654321?autoplay=1",
        baseUrl,
      ),
    ).toBe("https://vimeo.com/987654321");
    expect(
      normalizeCollectionItemUrl(
        "https://cdn.example.test/media/clip.webm?token=synthetic#part",
        baseUrl,
      ),
    ).toBe("https://cdn.example.test/media/clip.webm?token=synthetic");
    expect(
      normalizeCollectionItemUrl("https://example.test/article", baseUrl),
    ).toBeNull();
  });

  it("deduplicates normalized links and reports the configured limit", () => {
    const result = normalizeCollectionItemLinks(
      [
        "/watch?v=abcdefghijk&index=1",
        "https://youtu.be/abcdefghijk",
        "/shorts/lmnopqrstuv",
        "/watch?v=zyxwvutsrqp",
      ],
      "https://www.youtube.com/playlist?list=synthetic",
      2,
    );

    expect(result.urls).toEqual([
      "https://www.youtube.com/watch?v=abcdefghijk",
      "https://www.youtube.com/shorts/lmnopqrstuv",
    ]);
    expect(result.truncated).toBe(true);
  });
});

describe("parseUrlImport", () => {
  it("reads TXT and first-column CSV URLs, deduplicates, and applies a limit", () => {
    const result = parseUrlImport(
      [
        "url,title",
        '"https://example.test/one","One"',
        "https://example.test/two,Two",
        "https://example.test/one,Duplicate",
        "not-a-url,Invalid",
      ].join("\n"),
      1,
    );

    expect(result.urls).toEqual(["https://example.test/one"]);
    expect(result.rejected).toEqual(["not-a-url"]);
    expect(result.truncated).toBe(true);
  });
});

describe("tracksForQuality", () => {
  it("selects one quality per track kind", () => {
    const candidate = MediaCandidateSchema.parse({
      id: "candidate",
      pageUrl: "https://example.test/media",
      kind: "video",
      discoveredAt: 1,
      sourceHints: [{ adapterId: "direct", reference: "media" }],
      tracks: [
        { id: "video-low", kind: "video", height: 360 },
        { id: "video-high", kind: "video", height: 1080 },
        { id: "audio-low", kind: "audio", bitrate: 64_000 },
        { id: "audio-high", kind: "audio", bitrate: 256_000 },
      ],
    });

    expect(tracksForQuality(candidate, "best")).toEqual([
      "video-high",
      "audio-high",
    ]);
    expect(tracksForQuality(candidate, "small")).toEqual([
      "video-low",
      "audio-low",
    ]);
  });
});
