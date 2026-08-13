import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMediaJob } from "../domain/job-lifecycle";
import {
  MediaCandidateSchema,
  OutputRequestSchema,
  type MediaJob,
} from "../domain/schemas";
import { openMediaFetchDatabase, type MediaFetchDatabase } from "./database";
import {
  HistoryRepository,
  QueueRepository,
  SettingsRepository,
} from "./repositories";

const databaseName = `mediafetch-test-${crypto.randomUUID()}`;
let database: MediaFetchDatabase;

beforeEach(async () => {
  database = await openMediaFetchDatabase(databaseName);
});

afterEach(async () => {
  database.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Database deletion blocked"));
  });
});

function makeJob(id: string): MediaJob {
  return createMediaJob({
    id,
    batchId: "batch-1",
    candidate: MediaCandidateSchema.parse({
      id: "candidate-1",
      pageUrl: "https://example.test/authorized",
      kind: "audio",
      discoveredAt: 1,
      sourceHints: [{ adapterId: "direct", reference: "reference-1" }],
    }),
    output: OutputRequestSchema.parse({
      format: "mp3",
      filenameTemplate: "{title}",
    }),
    retryPolicy: {
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 10_000,
    },
    now: 10,
  });
}

describe("QueueRepository", () => {
  it("deduplicates and atomically claims persistent jobs", async () => {
    const repository = new QueueRepository(database);
    const first = await repository.enqueue(makeJob("job-1"));
    const duplicate = await repository.enqueue(makeJob("job-2"));

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.job.id).toBe("job-1");

    const claimed = await repository.claimNext(20);
    expect(claimed?.state.status).toBe("resolving");
    expect((await repository.get("job-1"))?.attempts).toBe(1);
    expect(await repository.claimNext(20)).toBeUndefined();
  });

  it("cancels and archives a terminal job", async () => {
    const queue = new QueueRepository(database);
    const history = new HistoryRepository(database);
    await queue.enqueue(makeJob("job-1"));

    const cancelled = await queue.cancel("job-1", 20, "Requested by user");
    expect(cancelled.state.status).toBe("cancelled");
    await queue.archive("job-1", 30);

    expect(await queue.get("job-1")).toBeUndefined();
    expect((await history.get("job-1"))?.job.state.status).toBe("cancelled");

    const retried = await queue.retry("job-1", 40);
    expect(retried.state).toEqual({ status: "queued", queuedAt: 40 });
    expect(await history.get("job-1")).toBeUndefined();
  });

  it("requeues a cancelled job for a manual retry", async () => {
    const queue = new QueueRepository(database);
    await queue.enqueue(makeJob("job-retry-cancelled"));
    await queue.cancel("job-retry-cancelled", 20, "Paused");

    const retried = await queue.retry("job-retry-cancelled", 30);

    expect(retried.state).toEqual({ status: "queued", queuedAt: 30 });
    expect(retried.cancellationRequested).toBe(false);
  });

  it("persists pause state and resumes without archiving", async () => {
    const queue = new QueueRepository(database);
    const history = new HistoryRepository(database);
    await queue.enqueue(makeJob("job-pause"));
    await queue.claimNext(20);

    const paused = await queue.pause("job-pause", 30);
    expect(paused.state).toEqual({ status: "paused", pausedAt: 30 });
    expect(await history.get("job-pause")).toBeUndefined();

    const resumed = await queue.retry("job-pause", 40);
    expect(resumed.state).toEqual({ status: "queued", queuedAt: 40 });
    expect(resumed.attempts).toBe(0);
  });
});

describe("SettingsRepository", () => {
  it("persists explicit experimental consent separately", async () => {
    const repository = new SettingsRepository(database);
    expect((await repository.get()).experimentalConsent.granted).toBe(false);

    const updated = await repository.setExperimentalConsent(
      {
        granted: true,
        policyVersion: "1",
        updatedAt: 50,
      },
      50,
    );
    expect(updated.experimentalConsent.granted).toBe(true);
    expect((await repository.get()).experimentalConsent.updatedAt).toBe(50);
  });
});
