import { z } from "zod";

export const TimestampSchema = z.number().int().nonnegative();
export const NonEmptyIdSchema = z.string().trim().min(1).max(200);
export const HttpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Only HTTP(S) URLs are supported");

export const MediaKindSchema = z.enum(["audio", "video"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const TrackKindSchema = z.enum(["audio", "video", "subtitle"]);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export const ContainerFormatSchema = z.enum([
  "original",
  "mp3",
  "m4a",
  "mp4",
  "webm",
  "wav",
]);
export type ContainerFormat = z.infer<typeof ContainerFormatSchema>;

export const TrackSchema = z
  .object({
    id: NonEmptyIdSchema,
    kind: TrackKindSchema,
    label: z.string().trim().min(1).max(200).optional(),
    language: z.string().trim().min(2).max(35).optional(),
    codec: z.string().trim().min(1).max(100).optional(),
    container: z.string().trim().min(1).max(50).optional(),
    bitrate: z.number().int().positive().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    isDefault: z.boolean().default(false),
  })
  .strict();
export type Track = z.infer<typeof TrackSchema>;

export const CandidateSourceHintSchema = z
  .object({
    adapterId: NonEmptyIdSchema,
    reference: z.string().trim().min(1).max(4_096),
  })
  .strict();
export type CandidateSourceHint = z.infer<typeof CandidateSourceHintSchema>;

export const MediaCandidateSchema = z
  .object({
    id: NonEmptyIdSchema,
    pageUrl: HttpUrlSchema,
    kind: MediaKindSchema,
    title: z.string().trim().min(1).max(500).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    mimeType: z.string().trim().min(1).max(200).optional(),
    contentLength: z.number().int().nonnegative().optional(),
    thumbnailUrl: HttpUrlSchema.optional(),
    discoveredAt: TimestampSchema,
    tracks: z.array(TrackSchema).max(100).default([]),
    sourceHints: z.array(CandidateSourceHintSchema).min(1).max(20),
  })
  .strict();
export type MediaCandidate = z.infer<typeof MediaCandidateSchema>;

export const ResolvedSourceKindSchema = z.enum([
  "direct",
  "segmented",
  "adaptive",
]);
export type ResolvedSourceKind = z.infer<typeof ResolvedSourceKindSchema>;

export const ResolvedSourceSchema = z
  .object({
    id: NonEmptyIdSchema,
    candidateId: NonEmptyIdSchema,
    adapterId: NonEmptyIdSchema,
    kind: ResolvedSourceKindSchema,
    url: HttpUrlSchema,
    mimeType: z.string().trim().min(1).max(200).optional(),
    contentLength: z.number().int().nonnegative().optional(),
    expiresAt: TimestampSchema.optional(),
    tracks: z.array(TrackSchema).max(100).default([]),
    requiresExperimentalConsent: z.boolean().default(false),
  })
  .strict();
export type ResolvedSource = z.infer<typeof ResolvedSourceSchema>;

export const OutputRequestSchema = z
  .object({
    format: ContainerFormatSchema,
    filenameTemplate: z.string().trim().min(1).max(200),
    selectedTrackIds: z.array(NonEmptyIdSchema).max(100).default([]),
  })
  .strict();
export type OutputRequest = z.infer<typeof OutputRequestSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "paused",
  "resolving",
  "downloading",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobProgressPhaseSchema = z.enum([
  "queued",
  "resolving",
  "downloading",
  "processing",
  "finalizing",
]);
export type JobProgressPhase = z.infer<typeof JobProgressPhaseSchema>;

export const JobProgressSchema = z
  .object({
    phase: JobProgressPhaseSchema,
    completedUnits: z.number().nonnegative(),
    totalUnits: z.number().positive().optional(),
    percent: z.number().min(0).max(100).optional(),
    message: z.string().trim().min(1).max(500).optional(),
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.totalUnits !== undefined &&
      value.completedUnits > value.totalUnits
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedUnits"],
        message: "completedUnits cannot exceed totalUnits",
      });
    }
  });
export type JobProgress = z.infer<typeof JobProgressSchema>;

export const JobErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
    occurredAt: TimestampSchema,
  })
  .strict();
export type JobError = z.infer<typeof JobErrorSchema>;

export const OutputArtifactSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    format: ContainerFormatSchema,
    size: z.number().int().nonnegative().optional(),
    downloadId: z.number().int().nonnegative().optional(),
  })
  .strict();
export type OutputArtifact = z.infer<typeof OutputArtifactSchema>;

export const JobStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("queued"),
      queuedAt: TimestampSchema,
      nextAttemptAt: TimestampSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("paused"),
      pausedAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("resolving"),
      startedAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("downloading"),
      startedAt: TimestampSchema,
      sourceId: NonEmptyIdSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("processing"),
      startedAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("completed"),
      completedAt: TimestampSchema,
      output: OutputArtifactSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      failedAt: TimestampSchema,
      error: JobErrorSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("cancelled"),
      cancelledAt: TimestampSchema,
      reason: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const MediaJobSchema = z
  .object({
    id: NonEmptyIdSchema,
    batchId: NonEmptyIdSchema.optional(),
    dedupeKey: z.string().trim().min(1).max(500),
    candidate: MediaCandidateSchema,
    output: OutputRequestSchema,
    state: JobStateSchema,
    progress: JobProgressSchema,
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive().max(20),
    cancellationRequested: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.attempts > value.maxAttempts) {
      context.addIssue({
        code: "custom",
        path: ["attempts"],
        message: "attempts cannot exceed maxAttempts",
      });
    }
  });
export type MediaJob = z.infer<typeof MediaJobSchema>;

export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(20),
    baseDelayMs: z.number().int().min(250).max(86_400_000),
    maxDelayMs: z.number().int().min(250).max(86_400_000),
  })
  .strict()
  .refine((value) => value.baseDelayMs <= value.maxDelayMs, {
    path: ["baseDelayMs"],
    message: "baseDelayMs cannot exceed maxDelayMs",
  });
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const ExperimentalConsentSchema = z
  .object({
    granted: z.boolean(),
    policyVersion: z.string().trim().min(1).max(50),
    updatedAt: TimestampSchema,
  })
  .strict();
export type ExperimentalConsent = z.infer<typeof ExperimentalConsentSchema>;

export const AppSettingsSchema = z
  .object({
    defaultFormat: ContainerFormatSchema,
    filenameTemplate: z.string().trim().min(1).max(200),
    concurrentJobs: z.number().int().min(1).max(8),
    historyRetentionDays: z.number().int().min(1).max(3650),
    retryPolicy: RetryPolicySchema,
    experimentalConsent: ExperimentalConsentSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const HistoryEntrySchema = z
  .object({
    id: NonEmptyIdSchema,
    job: MediaJobSchema,
    archivedAt: TimestampSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.job.state.status === "completed" ||
      value.job.state.status === "failed" ||
      value.job.state.status === "cancelled",
    {
      path: ["job", "state", "status"],
      message: "Only terminal jobs can be archived",
    },
  );
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  defaultFormat: "original",
  filenameTemplate: "{title}",
  concurrentJobs: 2,
  historyRetentionDays: 90,
  retryPolicy: {
    maxAttempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 60_000,
  },
  experimentalConsent: {
    granted: false,
    policyVersion: "1",
    updatedAt: 0,
  },
  updatedAt: 0,
};
