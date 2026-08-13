import { createDedupeKey } from "./media-utils";
import {
  JobProgressSchema,
  MediaJobSchema,
  type JobError,
  type JobProgress,
  type JobState,
  type JobStatus,
  type MediaCandidate,
  type MediaJob,
  type OutputArtifact,
  type OutputRequest,
  type RetryPolicy,
} from "./schemas";

const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["resolving", "paused", "cancelled"],
  paused: ["queued", "cancelled"],
  resolving: ["downloading", "failed", "queued", "paused", "cancelled"],
  downloading: [
    "processing",
    "completed",
    "failed",
    "queued",
    "paused",
    "cancelled",
  ],
  processing: ["completed", "failed", "queued", "paused", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: ["queued"],
};

export interface CreateMediaJobInput {
  readonly id: string;
  readonly batchId?: string;
  readonly candidate: MediaCandidate;
  readonly output: OutputRequest;
  readonly retryPolicy: RetryPolicy;
  readonly now: number;
}

export function createMediaJob(input: CreateMediaJobInput): MediaJob {
  const candidate = input.candidate;
  const output = input.output;
  const base = {
    id: input.id,
    dedupeKey: createDedupeKey(candidate, output),
    candidate,
    output,
    state: {
      status: "queued" as const,
      queuedAt: input.now,
    },
    progress: {
      phase: "queued" as const,
      completedUnits: 0,
      percent: 0,
      updatedAt: input.now,
    },
    attempts: 0,
    maxAttempts: input.retryPolicy.maxAttempts,
    cancellationRequested: false,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return MediaJobSchema.parse(
    input.batchId === undefined ? base : { ...base, batchId: input.batchId },
  );
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status: JobStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function beginJobAttempt(job: MediaJob, now: number): MediaJob {
  return replaceState(
    job,
    {
      status: "resolving",
      startedAt: now,
    },
    {
      phase: "resolving",
      completedUnits: 0,
      percent: 0,
      updatedAt: now,
    },
    now,
    job.attempts + 1,
  );
}

export function beginDownload(
  job: MediaJob,
  sourceId: string,
  now: number,
): MediaJob {
  return replaceState(
    job,
    {
      status: "downloading",
      startedAt: now,
      sourceId,
    },
    {
      phase: "downloading",
      completedUnits: 0,
      percent: 0,
      updatedAt: now,
    },
    now,
  );
}

export function beginProcessing(job: MediaJob, now: number): MediaJob {
  return replaceState(
    job,
    {
      status: "processing",
      startedAt: now,
    },
    {
      phase: "processing",
      completedUnits: 0,
      percent: 0,
      updatedAt: now,
    },
    now,
  );
}

export function updateJobProgress(
  job: MediaJob,
  progress: JobProgress,
): MediaJob {
  if (isTerminalStatus(job.state.status)) {
    throw new Error("Cannot update progress for a terminal job");
  }
  const parsedProgress = JobProgressSchema.parse(progress);
  return MediaJobSchema.parse({
    ...job,
    progress: parsedProgress,
    updatedAt: parsedProgress.updatedAt,
  });
}

export function completeJob(
  job: MediaJob,
  output: OutputArtifact,
  now: number,
): MediaJob {
  return replaceState(
    job,
    {
      status: "completed",
      completedAt: now,
      output,
    },
    {
      phase: "finalizing",
      completedUnits: 1,
      totalUnits: 1,
      percent: 100,
      updatedAt: now,
    },
    now,
  );
}

export function failOrRequeueJob(
  job: MediaJob,
  error: Omit<JobError, "occurredAt">,
  retryPolicy: RetryPolicy,
  now: number,
): MediaJob {
  if (error.retryable && job.attempts < job.maxAttempts) {
    const exponent = Math.max(0, job.attempts - 1);
    const delay = Math.min(
      retryPolicy.maxDelayMs,
      retryPolicy.baseDelayMs * 2 ** exponent,
    );
    return replaceState(
      job,
      {
        status: "queued",
        queuedAt: now,
        nextAttemptAt: now + delay,
      },
      {
        phase: "queued",
        completedUnits: 0,
        percent: 0,
        message: error.message,
        updatedAt: now,
      },
      now,
    );
  }
  return replaceState(
    job,
    {
      status: "failed",
      failedAt: now,
      error: {
        ...error,
        occurredAt: now,
      },
    },
    job.progress,
    now,
  );
}

export function retryFailedJob(job: MediaJob, now: number): MediaJob {
  if (
    job.state.status !== "failed" &&
    job.state.status !== "cancelled" &&
    job.state.status !== "paused"
  ) {
    throw new Error(
      "Only failed, cancelled or paused jobs can be retried manually",
    );
  }
  const retried = replaceState(
    job,
    {
      status: "queued",
      queuedAt: now,
    },
    {
      phase: "queued",
      completedUnits: 0,
      percent: 0,
      updatedAt: now,
    },
    now,
    0,
  );
  return MediaJobSchema.parse({
    ...retried,
    cancellationRequested: false,
  });
}

export function pauseJob(job: MediaJob, now: number): MediaJob {
  if (job.state.status === "paused") {
    return job;
  }
  if (isTerminalStatus(job.state.status)) {
    throw new Error("A terminal job cannot be paused");
  }
  return replaceState(
    job,
    { status: "paused", pausedAt: now },
    {
      phase: "queued",
      completedUnits: job.progress.completedUnits,
      ...(job.progress.totalUnits === undefined
        ? {}
        : { totalUnits: job.progress.totalUnits }),
      ...(job.progress.percent === undefined
        ? {}
        : { percent: job.progress.percent }),
      message: "Trabajo pausado por el usuario.",
      updatedAt: now,
    },
    now,
  );
}

export function requestJobCancellation(
  job: MediaJob,
  now: number,
  reason?: string,
): MediaJob {
  if (isTerminalStatus(job.state.status)) {
    return job;
  }
  const state: JobState =
    reason === undefined
      ? { status: "cancelled", cancelledAt: now }
      : { status: "cancelled", cancelledAt: now, reason };
  const cancelled = replaceState(job, state, job.progress, now);
  return MediaJobSchema.parse({
    ...cancelled,
    cancellationRequested: true,
  });
}

function replaceState(
  job: MediaJob,
  state: JobState,
  progress: JobProgress,
  now: number,
  attempts = job.attempts,
): MediaJob {
  if (!canTransitionJob(job.state.status, state.status)) {
    throw new Error(
      `Invalid job transition: ${job.state.status} -> ${state.status}`,
    );
  }
  return MediaJobSchema.parse({
    ...job,
    state,
    progress,
    attempts,
    updatedAt: now,
  });
}
