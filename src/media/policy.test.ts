import { describe, expect, it } from "vitest";
import { OutputRequestSchema, ResolvedSourceSchema } from "../domain/schemas";
import { MediaProcessingError } from "./errors";
import {
  assertSourceIsClear,
  assertWithinProcessingLimit,
  decideProcessing,
  materializeFfmpegArguments,
  MAX_PROCESSING_BYTES,
} from "./policy";

const source = ResolvedSourceSchema.parse({
  id: "source-1",
  candidateId: "candidate-1",
  adapterId: "direct",
  kind: "direct",
  url: "https://example.test/media.mp4",
  mimeType: "video/mp4",
  contentLength: 1_000,
  tracks: [
    { id: "video", kind: "video", codec: "h264" },
    { id: "audio", kind: "audio", codec: "aac" },
  ],
});

describe("media processing policy", () => {
  it("uses passthrough for an unchanged original", () => {
    const decision = decideProcessing(
      source,
      OutputRequestSchema.parse({
        format: "original",
        filenameTemplate: "{title}",
      }),
    );

    expect(decision.mode).toBe("passthrough");
    expect(decision.outputExtension).toBe("mp4");
    expect(decision.ffmpegArguments).toEqual([]);
  });

  it("maps selected source tracks and transcodes MP3", () => {
    const decision = decideProcessing(
      source,
      OutputRequestSchema.parse({
        format: "mp3",
        filenameTemplate: "{title}",
        selectedTrackIds: ["audio"],
      }),
    );

    expect(decision.mode).toBe("transcode");
    expect(
      materializeFfmpegArguments(decision, "input.bin", "output.mp3"),
    ).toEqual([
      "-i",
      "input.bin",
      "-map",
      "0:1",
      "-vn",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "2",
      "output.mp3",
    ]);
  });

  it("chooses remux when declared codecs fit the destination", () => {
    const decision = decideProcessing(
      source,
      OutputRequestSchema.parse({
        format: "mp4",
        filenameTemplate: "{title}",
      }),
    );
    expect(decision.mode).toBe("remux");
    expect(decision.ffmpegArguments).toContain("copy");
  });

  it("rejects missing selected tracks", () => {
    expect(() =>
      decideProcessing(
        source,
        OutputRequestSchema.parse({
          format: "mp3",
          filenameTemplate: "{title}",
          selectedTrackIds: ["commentary"],
        }),
      ),
    ).toThrowError(MediaProcessingError);
  });

  it("rejects audio output when only video is selected", () => {
    expect(() =>
      decideProcessing(
        source,
        OutputRequestSchema.parse({
          format: "mp3",
          filenameTemplate: "{title}",
          selectedTrackIds: ["video"],
        }),
      ),
    ).toThrowError(/pista de audio/);
  });

  it("rejects sources at or above 2 GB", () => {
    expect(() =>
      assertWithinProcessingLimit(MAX_PROCESSING_BYTES - 1),
    ).not.toThrow();
    expect(() =>
      assertWithinProcessingLimit(MAX_PROCESSING_BYTES),
    ).toThrowError(/inferior a 2 GB/);
  });

  it("rejects encrypted manifests and DRM metadata", () => {
    expect(() =>
      assertSourceIsClear(
        source,
        new TextEncoder().encode(
          '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
        ),
      ),
    ).toThrowError(/cifrada|DRM/);

    const protectedSource = ResolvedSourceSchema.parse({
      ...source,
      id: "protected",
      tracks: [{ id: "audio", kind: "audio", codec: "cenc" }],
    });
    expect(() => assertSourceIsClear(protectedSource)).toThrowError(/DRM/);
  });
});
