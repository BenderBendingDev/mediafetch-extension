import { failOrRequeueJob, isTerminalStatus } from "../domain/job-lifecycle";
import type { AppSettings, MediaJob } from "../domain/schemas";

export interface RecoveryQueue {
  list(): Promise<readonly MediaJob[]>;
  save(job: MediaJob): Promise<void>;
  archive(id: string, archivedAt: number): Promise<unknown>;
}

export interface BackgroundRecoveryOptions {
  readonly queue: RecoveryQueue;
  readonly settings: AppSettings;
  readonly now: number;
  readonly hasOffscreenDocument: () => Promise<boolean>;
  readonly cancelOffscreenJob: (jobId: string) => Promise<void>;
}

export async function recoverBackgroundJobs(
  options: BackgroundRecoveryOptions,
): Promise<void> {
  const jobs = await options.queue.list();
  const interrupted = jobs.filter(
    (job) =>
      !isTerminalStatus(job.state.status) && job.state.status !== "queued",
  );

  if (
    interrupted.length > 0 &&
    (await options.hasOffscreenDocument().catch(() => false))
  ) {
    for (const job of interrupted) {
      await options.cancelOffscreenJob(job.id).catch(() => undefined);
    }
  }

  for (const job of jobs) {
    if (isTerminalStatus(job.state.status)) {
      await options.queue.archive(job.id, options.now);
      continue;
    }
    if (job.state.status === "queued") continue;

    const recovered = failOrRequeueJob(
      job,
      {
        code: "background_restarted",
        message: "El trabajo se interrumpió al reiniciarse la extensión.",
        retryable: true,
      },
      options.settings.retryPolicy,
      options.now,
    );
    await options.queue.save(recovered);
    if (isTerminalStatus(recovered.state.status)) {
      await options.queue.archive(recovered.id, options.now);
    }
  }
}
