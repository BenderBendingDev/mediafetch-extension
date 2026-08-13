import { describe, expect, it, vi } from "vitest";
import {
  MediaJobSchema,
  ResolvedSourceSchema,
  type ResolvedSource,
} from "../domain/schemas";
import {
  parseUnencryptedDashManifest,
  parseUnencryptedHlsManifest,
} from "../adapters/manifests";
import { downloadSource } from "./download";
import {
  FfmpegEngine,
  type FfmpegLike,
  type FfmpegProgressEvent,
} from "./ffmpeg-engine";
import { LocalMediaProcessor } from "./processor";
import { MAX_PROCESSING_BYTES } from "./policy";

const DASH_FIXTURE = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT2S">
  <BaseURL>media/</BaseURL>
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="video-main" bandwidth="100000" codecs="avc1.42E01E">
        <SegmentList>
          <Initialization sourceURL="video-init.mp4"/>
          <SegmentURL media="video-1.m4s"/>
          <SegmentURL media="video-2.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="es">
      <Representation id="audio-es" bandwidth="64000" codecs="mp4a.40.2">
        <SegmentList>
          <Initialization sourceURL="audio-init.mp4"/>
          <SegmentURL media="audio-1.m4s"/>
          <SegmentURL media="audio-2.m4s"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

class FakeFfmpeg implements FfmpegLike {
  readonly load = vi.fn(async () => true);
  readonly writeFile = vi.fn(async () => true);
  readonly exec = vi.fn(async (_arguments: string[]) => 0);
  readonly readFile = vi.fn(async () => new Uint8Array([9, 8, 7]));
  readonly deleteFile = vi.fn(async () => true);
  readonly terminate = vi.fn();

  on(
    _event: "progress",
    _callback: (event: FfmpegProgressEvent) => void,
  ): void {}

  off(
    _event: "progress",
    _callback: (event: FfmpegProgressEvent) => void,
  ): void {}
}

describe("adaptive source processing", () => {
  it("downloads an HLS media playlist with EXT-X-MAP and segments", async () => {
    const source = adaptiveSource(
      "https://fixtures.test/hls/media.m3u8",
      "application/vnd.apple.mpegurl",
    );
    const fetchImpl = fixtureFetch(
      new Map<string, string | Uint8Array>([
        [
          source.url,
          '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\none.m4s\n#EXTINF:1,\ntwo.m4s\n#EXT-X-ENDLIST',
        ],
        ["https://fixtures.test/hls/init.mp4", new Uint8Array([1])],
        ["https://fixtures.test/hls/one.m4s", new Uint8Array([2, 3])],
        ["https://fixtures.test/hls/two.m4s", new Uint8Array([4])],
      ]),
    );

    const result = await downloadSource(source, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
      fetchImpl,
    });

    expect([...result.bytes]).toEqual([1, 2, 3, 4]);
    expect(result.inputs).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("resolves an HLS master into separate audio and video inputs", async () => {
    const source = adaptiveSource(
      "https://fixtures.test/hls/master.m3u8",
      "application/vnd.apple.mpegurl",
    );
    const fetchImpl = fixtureFetch(
      new Map<string, string | Uint8Array>([
        [
          source.url,
          '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio-es",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,CODECS="avc1.42E01E",AUDIO="aud"\nvideo.m3u8',
        ],
        [
          "https://fixtures.test/hls/video.m3u8",
          '#EXTM3U\n#EXT-X-MAP:URI="video-init.mp4"\nvideo.m4s',
        ],
        [
          "https://fixtures.test/hls/audio.m3u8",
          '#EXTM3U\n#EXT-X-MAP:URI="audio-init.mp4"\naudio.m4s',
        ],
        ["https://fixtures.test/hls/video-init.mp4", bytes(1)],
        ["https://fixtures.test/hls/video.m4s", bytes(2)],
        ["https://fixtures.test/hls/audio-init.mp4", bytes(3)],
        ["https://fixtures.test/hls/audio.m4s", bytes(4)],
      ]),
    );

    const result = await downloadSource(source, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
      fetchImpl,
    });

    expect(result.inputs.map((input) => input.track?.kind)).toEqual([
      "video",
      "audio",
    ]);
    expect([...result.inputs[0]!.bytes]).toEqual([1, 2]);
    expect([...result.inputs[1]!.bytes]).toEqual([3, 4]);
  });

  it("downloads separate DASH A/V tracks and remuxes one output", async () => {
    const source = ResolvedSourceSchema.parse({
      ...adaptiveSource(
        "https://fixtures.test/dash/manifest.mpd",
        "application/dash+xml",
      ),
      tracks: [
        { id: "video-main", kind: "video", codec: "h264" },
        { id: "audio-es", kind: "audio", codec: "aac", language: "es" },
      ],
    });
    const resources = new Map<string, string | Uint8Array>([
      [source.url, DASH_FIXTURE],
      ["https://fixtures.test/dash/media/video-init.mp4", bytes(10)],
      ["https://fixtures.test/dash/media/video-1.m4s", bytes(11)],
      ["https://fixtures.test/dash/media/video-2.m4s", bytes(12)],
      ["https://fixtures.test/dash/media/audio-init.mp4", bytes(20)],
      ["https://fixtures.test/dash/media/audio-1.m4s", bytes(21)],
      ["https://fixtures.test/dash/media/audio-2.m4s", bytes(22)],
    ]);
    const ffmpeg = new FakeFfmpeg();
    const processor = new LocalMediaProcessor(
      new FfmpegEngine({
        runtimeGetURL: (path) => `extension://${path}`,
        createFfmpeg: () => ffmpeg,
        toFileData: async (blob) => new Uint8Array(await blob.arrayBuffer()),
      }),
    );
    const job = MediaJobSchema.parse({
      id: "dash-job",
      dedupeKey: "dash-job",
      candidate: {
        id: "dash-candidate",
        pageUrl: "https://fixtures.test/watch",
        kind: "video",
        title: "DASH fixture",
        discoveredAt: 1,
        tracks: source.tracks,
        sourceHints: [{ adapterId: "generic", reference: source.url }],
      },
      output: {
        format: "mp4",
        filenameTemplate: "{title}",
      },
      state: { status: "queued", queuedAt: 1 },
      progress: {
        phase: "queued",
        completedUnits: 0,
        updatedAt: 1,
      },
      attempts: 0,
      maxAttempts: 1,
      cancellationRequested: false,
      createdAt: 1,
      updatedAt: 1,
    });

    const output = await processor.process(job, source, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
      fetchImpl: fixtureFetch(resources),
      now: () => 2,
    });

    expect(output.blob.size).toBe(3);
    expect(output.filename).toBe("DASH fixture.mp4");
    expect(ffmpeg.writeFile).toHaveBeenCalledTimes(2);
    const arguments_ = ffmpeg.exec.mock.calls[0]?.[0] ?? [];
    expect(arguments_).toEqual(
      expect.arrayContaining(["-map", "0:v:0", "-map", "1:a:0", "-c", "copy"]),
    );
  });

  it("keeps explicit independent DASH track selection", async () => {
    const source = ResolvedSourceSchema.parse({
      ...adaptiveSource(
        "https://fixtures.test/dash/manifest.mpd",
        "application/dash+xml",
      ),
      tracks: [
        { id: "video-main", kind: "video", codec: "h264" },
        { id: "audio-es", kind: "audio", codec: "aac" },
      ],
    });
    const resources = new Map<string, string | Uint8Array>([
      [source.url, DASH_FIXTURE],
      ["https://fixtures.test/dash/media/audio-init.mp4", bytes(20)],
      ["https://fixtures.test/dash/media/audio-1.m4s", bytes(21)],
      ["https://fixtures.test/dash/media/audio-2.m4s", bytes(22)],
    ]);

    const result = await downloadSource(source, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
      selectedTrackIds: ["audio-es"],
      fetchImpl: fixtureFetch(resources),
    });

    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0]?.track?.id).toBe("audio-es");
    expect([...result.inputs[0]!.bytes]).toEqual([20, 21, 22]);
  });

  it("rejects encryption, byte ranges, discontinuities and the 2 GB edge", async () => {
    expect(() =>
      parseUnencryptedHlsManifest(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\none.ts',
        "https://fixtures.test/encrypted.m3u8",
      ),
    ).toThrow(/Encrypted HLS/);
    expect(() =>
      parseUnencryptedHlsManifest(
        "#EXTM3U\n#EXT-X-BYTERANGE:20@0\none.ts",
        "https://fixtures.test/range.m3u8",
      ),
    ).toThrow(/byte ranges/);
    expect(() =>
      parseUnencryptedHlsManifest(
        "#EXTM3U\none.ts\n#EXT-X-DISCONTINUITY\ntwo.ts",
        "https://fixtures.test/discontinuous.m3u8",
      ),
    ).toThrow(/discontinuities/);
    expect(() =>
      parseUnencryptedDashManifest(
        "<MPD><Period><AdaptationSet><ContentProtection/></AdaptationSet></Period></MPD>",
        "https://fixtures.test/protected.mpd",
      ),
    ).toThrow(/Protected DASH/);

    const tooLarge = adaptiveSource(
      "https://fixtures.test/large.m3u8",
      "application/vnd.apple.mpegurl",
    );
    await expect(
      downloadSource(tooLarge, {
        signal: new AbortController().signal,
        onProgress: () => undefined,
        fetchImpl: (async () =>
          new Response("#EXTM3U\none.ts", {
            headers: {
              "content-length": String(MAX_PROCESSING_BYTES),
            },
          })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "processing_too_large" });
  });

  it("expands a bounded static DASH SegmentTemplate", () => {
    const manifest = parseUnencryptedDashManifest(
      `<MPD type="static" mediaPresentationDuration="PT2S">
        <Period>
          <AdaptationSet contentType="audio" mimeType="audio/mp4">
            <SegmentTemplate timescale="1" duration="1"
              initialization="init-$RepresentationID$.mp4"
              media="chunk-$Number%02d$.m4s"/>
            <Representation id="a1" bandwidth="64000"/>
          </AdaptationSet>
        </Period>
      </MPD>`,
      "https://fixtures.test/template/manifest.mpd",
    );

    expect(manifest.tracks[0]).toMatchObject({
      id: "a1",
      initializationUrl: "https://fixtures.test/template/init-a1.mp4",
      segmentUrls: [
        "https://fixtures.test/template/chunk-01.m4s",
        "https://fixtures.test/template/chunk-02.m4s",
      ],
    });
  });
});

function adaptiveSource(url: string, mimeType: string): ResolvedSource {
  return ResolvedSourceSchema.parse({
    id: "adaptive-source",
    candidateId: "adaptive-candidate",
    adapterId: "generic",
    kind: "adaptive",
    url,
    mimeType,
  });
}

function bytes(value: number): Uint8Array {
  return new Uint8Array([value]);
}

function fixtureFetch(
  fixtures: ReadonlyMap<string, string | Uint8Array>,
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    const fixture = fixtures.get(url);
    if (fixture === undefined) {
      return new Response("Not found", { status: 404 });
    }
    const copy = new Uint8Array(
      fixture instanceof Uint8Array ? fixture.byteLength : 0,
    );
    if (fixture instanceof Uint8Array) copy.set(fixture);
    const body = typeof fixture === "string" ? fixture : copy.buffer;
    return new Response(body, {
      headers: {
        "content-length": String(
          typeof fixture === "string"
            ? new TextEncoder().encode(fixture).byteLength
            : fixture.byteLength,
        ),
      },
    });
  }) as typeof fetch;
}
