import { describe, expect, it } from "vitest";
import {
  beginJobAttempt,
  failOrRequeueJob,
  pauseJob,
  requestJobCancellation,
  retryFailedJob,
} from "./job-lifecycle";
import {
  createDedupeKey,
  renderFilename,
  sanitizeFilenameSegment,
} from "./media-utils";
import {
  MediaCandidateSchema,
  OutputRequestSchema,
  type MediaJob,
} from "./schemas";
import { createMediaJob } from "./job-lifecycle";

const candidate = MediaCandidateSchema.parse({
  id: "candidate-1",
  pageUrl: "https://example.test/authorized",
  kind: "audio",
  title: "../CON: sample",
  mimeType: "audio/mpeg",
  discoveredAt: 1,
  sourceHints: [{ adapterId: "direct", reference: "reference-1" }],
});

const output = OutputRequestSchema.parse({
  format: "mp3",
  filenameTemplate: "{title}-{date}",
});

describe("safe media utilities", () => {
  it("removes path and platform-reserved filename characters", () => {
    expect(sanitizeFilenameSegment("../CON: sample")).toBe(".._CON_ sample");
    expect(renderFilename(candidate, output, Date.UTC(2026, 0, 2))).toBe(
      ".._CON_ sample-2026-01-02.mp3",
    );
  });

  it("creates the same dedupe key regardless of track order", () => {
    const first = OutputRequestSchema.parse({
      ...output,
      selectedTrackIds: ["video", "audio"],
    });
    const second = OutputRequestSchema.parse({
      ...output,
      selectedTrackIds: ["audio", "video"],
    });
    expect(createDedupeKey(candidate, first)).toBe(
      createDedupeKey(candidate, second),
    );
  });
});

describe("job lifecycle", () => {
  it("applies bounded exponential retry delays", () => {
    const retryPolicy = {
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 1_500,
    };
    const queued = createMediaJob({
      id: "job-1",
      batchId: "batch-1",
      candidate,
      output,
      retryPolicy,
      now: 10,
    });
    const firstAttempt = beginJobAttempt(queued, 20);
    const firstRetry = failOrRequeueJob(
      firstAttempt,
      { code: "network", message: "Temporary failure", retryable: true },
      retryPolicy,
      30,
    );
    expect(firstRetry.state).toEqual({
      status: "queued",
      queuedAt: 30,
      nextAttemptAt: 1_030,
    });

    const secondAttempt = beginJobAttempt(firstRetry, 1_030);
    const secondRetry = failOrRequeueJob(
      secondAttempt,
      { code: "network", message: "Temporary failure", retryable: true },
      retryPolicy,
      1_040,
    );
    expect(secondRetry.state).toEqual({
      status: "queued",
      queuedAt: 1_040,
      nextAttemptAt: 2_540,
    });
  });

  it("ends in failure when retry attempts are exhausted", () => {
    const exhausted = {
      ...createMediaJob({
        id: "job-2",
        candidate,
        output,
        retryPolicy: {
          maxAttempts: 1,
          baseDelayMs: 1_000,
          maxDelayMs: 1_000,
        },
        now: 10,
      }),
      attempts: 1,
      state: { status: "resolving", startedAt: 20 },
    } satisfies MediaJob;

    expect(
      failOrRequeueJob(
        exhausted,
        { code: "network", message: "Final failure", retryable: true },
        { maxAttempts: 1, baseDelayMs: 1_000, maxDelayMs: 1_000 },
        30,
      ).state.status,
    ).toBe("failed");
  });

  it("manually retries a cancelled job and clears cancellation state", () => {
    const queued = createMediaJob({
      id: "job-cancelled",
      candidate,
      output,
      retryPolicy: {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
      },
      now: 10,
    });
    const cancelled = requestJobCancellation(queued, 20, "Paused");
    const retried = retryFailedJob(cancelled, 30);

    expect(retried.state).toEqual({ status: "queued", queuedAt: 30 });
    expect(retried.attempts).toBe(0);
    expect(retried.cancellationRequested).toBe(false);
  });

  it("pauses an active job and resumes it from the queue", () => {
    const active = beginJobAttempt(
      createMediaJob({
        id: "job-paused",
        candidate,
        output,
        retryPolicy: {
          maxAttempts: 3,
          baseDelayMs: 1_000,
          maxDelayMs: 10_000,
        },
        now: 10,
      }),
      20,
    );

    const paused = pauseJob(active, 30);
    expect(paused.state).toEqual({ status: "paused", pausedAt: 30 });
    expect(paused.attempts).toBe(1);

    const resumed = retryFailedJob(paused, 40);
    expect(resumed.state).toEqual({ status: "queued", queuedAt: 40 });
    expect(resumed.attempts).toBe(0);
  });

  it("recovers interrupted work using the bounded retry policy", () => {
    const active = beginJobAttempt(
      createMediaJob({
        id: "job-recovered",
        candidate,
        output,
        retryPolicy: {
          maxAttempts: 3,
          baseDelayMs: 1_000,
          maxDelayMs: 10_000,
        },
        now: 10,
      }),
      20,
    );

    const recovered = failOrRequeueJob(
      active,
      {
        code: "background_restarted",
        message: "The extension restarted.",
        retryable: true,
      },
      { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000 },
      30,
    );

    expect(recovered.state).toEqual({
      status: "queued",
      queuedAt: 30,
      nextAttemptAt: 1_030,
    });
  });
});
