import { describe, expect, it, vi } from "vitest";
import { beginJobAttempt, createMediaJob } from "../domain/job-lifecycle";
import {
  DEFAULT_SETTINGS,
  MediaCandidateSchema,
  OutputRequestSchema,
  type MediaJob,
} from "../domain/schemas";
import { recoverBackgroundJobs, type RecoveryQueue } from "./recovery";

class MemoryRecoveryQueue implements RecoveryQueue {
  readonly jobs = new Map<string, MediaJob>();
  readonly archived: MediaJob[] = [];

  async list(): Promise<readonly MediaJob[]> {
    return [...this.jobs.values()];
  }

  async save(job: MediaJob): Promise<void> {
    this.jobs.set(job.id, job);
  }

  async archive(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job === undefined) throw new Error(`Missing job: ${id}`);
    this.archived.push(job);
    this.jobs.delete(id);
  }
}

describe("background suspension recovery", () => {
  it("cancels stale offscreen work, requeues retryable jobs and archives exhausted jobs", async () => {
    const queue = new MemoryRecoveryQueue();
    const queued = makeJob("queued", 3);
    const interrupted = beginJobAttempt(makeJob("interrupted", 3), 100);
    const exhausted = beginJobAttempt(makeJob("exhausted", 1), 100);
    for (const job of [queued, interrupted, exhausted]) {
      queue.jobs.set(job.id, job);
    }
    const cancelOffscreenJob = vi.fn(async (_jobId: string) => undefined);

    await recoverBackgroundJobs({
      queue,
      settings: DEFAULT_SETTINGS,
      now: 1_000,
      hasOffscreenDocument: async () => true,
      cancelOffscreenJob,
    });

    expect(cancelOffscreenJob.mock.calls.map(([jobId]) => jobId)).toEqual([
      "interrupted",
      "exhausted",
    ]);
    expect(queue.jobs.get("queued")).toEqual(queued);
    expect(queue.jobs.get("interrupted")?.state).toEqual({
      status: "queued",
      queuedAt: 1_000,
      nextAttemptAt: 2_000,
    });
    expect(queue.jobs.get("interrupted")?.progress.message).toMatch(
      /reiniciarse/,
    );
    expect(queue.jobs.has("exhausted")).toBe(false);
    expect(queue.archived[0]?.state).toMatchObject({
      status: "failed",
      error: { code: "background_restarted", retryable: true },
    });
  });
});

function makeJob(id: string, maxAttempts: number): MediaJob {
  return createMediaJob({
    id,
    candidate: MediaCandidateSchema.parse({
      id: `candidate-${id}`,
      pageUrl: "https://fixture.test/page",
      kind: "audio",
      discoveredAt: 1,
      sourceHints: [
        {
          adapterId: "generic",
          reference: `https://fixture.test/${id}.wav`,
        },
      ],
    }),
    output: OutputRequestSchema.parse({
      format: "original",
      filenameTemplate: "{title}",
    }),
    retryPolicy: {
      maxAttempts,
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
    },
    now: 1,
  });
}
