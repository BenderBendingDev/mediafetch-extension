import { describe, expect, it, vi } from "vitest";
import { OutputRequestSchema, ResolvedSourceSchema } from "../domain/schemas";
import {
  FFMPEG_CORE_PUBLIC_PATH,
  FFMPEG_WASM_PUBLIC_PATH,
  FfmpegEngine,
  type FfmpegLike,
  type FfmpegProgressEvent,
} from "./ffmpeg-engine";
import { decideProcessing } from "./policy";

class FakeFfmpeg implements FfmpegLike {
  readonly load = vi.fn(async () => true);
  readonly writeFile = vi.fn(async () => true);
  readonly exec = vi.fn(async () => {
    this.progressListener?.({ progress: 0.5, time: 1 });
    return 0;
  });
  readonly readFile = vi.fn(async () => new Uint8Array([4, 5, 6]));
  readonly deleteFile = vi.fn(async () => true);
  readonly terminate = vi.fn();
  private progressListener: ((event: FfmpegProgressEvent) => void) | undefined;

  on(_event: "progress", callback: (event: FfmpegProgressEvent) => void): void {
    this.progressListener = callback;
  }

  off(
    _event: "progress",
    callback: (event: FfmpegProgressEvent) => void,
  ): void {
    if (this.progressListener === callback) this.progressListener = undefined;
  }
}

const source = ResolvedSourceSchema.parse({
  id: "source-1",
  candidateId: "candidate-1",
  adapterId: "direct",
  kind: "direct",
  url: "https://example.test/audio.m4a",
  mimeType: "audio/mp4",
  tracks: [{ id: "audio", kind: "audio", codec: "aac" }],
});
const output = OutputRequestSchema.parse({
  format: "mp3",
  filenameTemplate: "{title}",
});

describe("FfmpegEngine", () => {
  it("loads the packaged core lazily and reuses it between jobs", async () => {
    const ffmpeg = new FakeFfmpeg();
    const createFfmpeg = vi.fn(() => ffmpeg);
    const getRuntimeURL = vi.fn((path: string) => `extension://${path}`);
    const engine = new FfmpegEngine({
      runtimeGetURL: getRuntimeURL,
      createFfmpeg,
      toFileData: async () => new Uint8Array([1, 2, 3]),
    });
    const decision = decideProcessing(source, output);
    const progress = vi.fn();

    const first = await engine.process(
      "job-1",
      new Blob(["input"]),
      "mp3",
      decision,
      { signal: new AbortController().signal, onProgress: progress },
    );
    await engine.process("job-2", new Blob(["input"]), "mp3", decision, {
      signal: new AbortController().signal,
      onProgress: progress,
    });

    expect(first.type).toBe("audio/mpeg");
    expect(createFfmpeg).toHaveBeenCalledTimes(1);
    expect(ffmpeg.load).toHaveBeenCalledWith(
      {
        coreURL: `extension://${FFMPEG_CORE_PUBLIC_PATH}`,
        wasmURL: `extension://${FFMPEG_WASM_PUBLIC_PATH}`,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(ffmpeg.exec).toHaveBeenCalledTimes(2);
    expect(ffmpeg.deleteFile).toHaveBeenCalledTimes(4);
    expect(progress).toHaveBeenCalledWith(50);
  });

  it("terminates FFmpeg when a running operation is cancelled", async () => {
    const ffmpeg = new FakeFfmpeg();
    const controller = new AbortController();
    ffmpeg.exec.mockImplementation(async () => {
      controller.abort();
      return 0;
    });
    const engine = new FfmpegEngine({
      runtimeGetURL: (path) => `extension://${path}`,
      createFfmpeg: () => ffmpeg,
      toFileData: async () => new Uint8Array([1]),
    });

    await expect(
      engine.process(
        "job-1",
        new Blob(["input"]),
        "mp3",
        decideProcessing(source, output),
        { signal: controller.signal, onProgress: () => undefined },
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(ffmpeg.terminate).toHaveBeenCalledOnce();
  });
});
