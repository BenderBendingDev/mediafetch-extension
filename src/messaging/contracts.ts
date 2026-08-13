import { z } from "zod";
import {
  AppSettingsSchema,
  ExperimentalConsentSchema,
  HistoryEntrySchema,
  HttpUrlSchema,
  JobErrorSchema,
  JobProgressSchema,
  MediaCandidateSchema,
  MediaJobSchema,
  NonEmptyIdSchema,
  OutputArtifactSchema,
  OutputRequestSchema,
  ResolvedSourceSchema,
  TimestampSchema,
} from "../domain/schemas";

export const MESSAGE_PROTOCOL_VERSION = 1 as const;

export const ExtensionContextSchema = z.enum([
  "popup",
  "dashboard",
  "content",
  "background",
  "offscreen",
]);
export type ExtensionContext = z.infer<typeof ExtensionContextSchema>;

const ScanRequestMessageSchema = z
  .object({
    kind: z.literal("candidate.scan.request"),
    payload: z
      .object({
        tabId: z.number().int().nonnegative(),
        pageUrl: HttpUrlSchema,
      })
      .strict(),
  })
  .strict();

const ScanResultMessageSchema = z
  .object({
    kind: z.literal("candidate.scan.result"),
    payload: z
      .object({
        tabId: z.number().int().nonnegative(),
        candidates: z.array(MediaCandidateSchema).max(1_000),
      })
      .strict(),
  })
  .strict();

const EnqueueMessageSchema = z
  .object({
    kind: z.literal("queue.enqueue"),
    payload: z
      .object({
        candidate: MediaCandidateSchema,
        output: OutputRequestSchema,
        batchId: NonEmptyIdSchema.optional(),
      })
      .strict(),
  })
  .strict();

const QueueSnapshotRequestMessageSchema = z
  .object({
    kind: z.literal("queue.snapshot.request"),
    payload: z.object({}).strict(),
  })
  .strict();

const QueueSnapshotMessageSchema = z
  .object({
    kind: z.literal("queue.snapshot"),
    payload: z
      .object({
        jobs: z.array(MediaJobSchema),
        history: z.array(HistoryEntrySchema),
      })
      .strict(),
  })
  .strict();

const CancelJobMessageSchema = z
  .object({
    kind: z.literal("job.cancel"),
    payload: z
      .object({
        jobId: NonEmptyIdSchema,
        reason: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
  })
  .strict();

const PauseJobMessageSchema = z
  .object({
    kind: z.literal("job.pause"),
    payload: z.object({ jobId: NonEmptyIdSchema }).strict(),
  })
  .strict();

const RetryJobMessageSchema = z
  .object({
    kind: z.literal("job.retry"),
    payload: z.object({ jobId: NonEmptyIdSchema }).strict(),
  })
  .strict();

const JobProgressMessageSchema = z
  .object({
    kind: z.literal("job.progress"),
    payload: z
      .object({
        jobId: NonEmptyIdSchema,
        batchId: NonEmptyIdSchema.optional(),
        progress: JobProgressSchema,
      })
      .strict(),
  })
  .strict();

const JobCompletedMessageSchema = z
  .object({
    kind: z.literal("job.completed"),
    payload: z
      .object({
        jobId: NonEmptyIdSchema,
        batchId: NonEmptyIdSchema.optional(),
        output: OutputArtifactSchema,
      })
      .strict(),
  })
  .strict();

const JobFailedMessageSchema = z
  .object({
    kind: z.literal("job.failed"),
    payload: z
      .object({
        jobId: NonEmptyIdSchema,
        batchId: NonEmptyIdSchema.optional(),
        error: JobErrorSchema,
      })
      .strict(),
  })
  .strict();

const OffscreenExecuteMessageSchema = z
  .object({
    kind: z.literal("offscreen.execute"),
    payload: z
      .object({
        job: MediaJobSchema,
        source: ResolvedSourceSchema,
      })
      .strict(),
  })
  .strict();

const OffscreenCancelMessageSchema = z
  .object({
    kind: z.literal("offscreen.cancel"),
    payload: z.object({ jobId: NonEmptyIdSchema }).strict(),
  })
  .strict();

const OffscreenDownloadMessageSchema = z
  .object({
    kind: z.literal("offscreen.download"),
    payload: z
      .object({
        jobId: NonEmptyIdSchema,
        blobUrl: z.string().startsWith("blob:").max(4_096),
        output: OutputArtifactSchema.omit({ downloadId: true }),
      })
      .strict(),
  })
  .strict();

const OffscreenDownloadResultMessageSchema = z
  .object({
    kind: z.literal("offscreen.download.result"),
    payload: OutputArtifactSchema,
  })
  .strict();

const SettingsGetMessageSchema = z
  .object({
    kind: z.literal("settings.get"),
    payload: z.object({}).strict(),
  })
  .strict();

const SettingsPatchSchema = AppSettingsSchema.omit({
  updatedAt: true,
  experimentalConsent: true,
})
  .partial()
  .strict();

const SettingsUpdateMessageSchema = z
  .object({
    kind: z.literal("settings.update"),
    payload: SettingsPatchSchema,
  })
  .strict();

const SettingsValueMessageSchema = z
  .object({
    kind: z.literal("settings.value"),
    payload: AppSettingsSchema,
  })
  .strict();

const ConsentSetMessageSchema = z
  .object({
    kind: z.literal("experimental-consent.set"),
    payload: ExperimentalConsentSchema,
  })
  .strict();

const AcknowledgementMessageSchema = z
  .object({
    kind: z.literal("ack"),
    payload: z.object({ accepted: z.boolean() }).strict(),
  })
  .strict();

const ContractErrorMessageSchema = z
  .object({
    kind: z.literal("error"),
    payload: z
      .object({
        code: z.string().trim().min(1).max(100),
        message: z.string().trim().min(1).max(1_000),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const ExtensionMessageSchema = z.discriminatedUnion("kind", [
  ScanRequestMessageSchema,
  ScanResultMessageSchema,
  EnqueueMessageSchema,
  QueueSnapshotRequestMessageSchema,
  QueueSnapshotMessageSchema,
  CancelJobMessageSchema,
  PauseJobMessageSchema,
  RetryJobMessageSchema,
  JobProgressMessageSchema,
  JobCompletedMessageSchema,
  JobFailedMessageSchema,
  OffscreenExecuteMessageSchema,
  OffscreenCancelMessageSchema,
  OffscreenDownloadMessageSchema,
  OffscreenDownloadResultMessageSchema,
  SettingsGetMessageSchema,
  SettingsUpdateMessageSchema,
  SettingsValueMessageSchema,
  ConsentSetMessageSchema,
  AcknowledgementMessageSchema,
  ContractErrorMessageSchema,
]);
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;
export type ExtensionMessageKind = ExtensionMessage["kind"];

export const MessageEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(MESSAGE_PROTOCOL_VERSION),
    requestId: NonEmptyIdSchema,
    correlationId: NonEmptyIdSchema.optional(),
    sentAt: TimestampSchema,
    source: ExtensionContextSchema,
    target: ExtensionContextSchema,
    message: ExtensionMessageSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    if (
      !isAllowedRoute(envelope.message.kind, envelope.source, envelope.target)
    ) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: `Invalid route for ${envelope.message.kind}`,
      });
    }
  });
export type MessageEnvelope = z.infer<typeof MessageEnvelopeSchema>;

export function parseMessageEnvelope(value: unknown): MessageEnvelope {
  return MessageEnvelopeSchema.parse(value);
}

function isAllowedRoute(
  kind: ExtensionMessageKind,
  source: ExtensionContext,
  target: ExtensionContext,
): boolean {
  switch (kind) {
    case "candidate.scan.request":
      return (
        (source === "popup" ||
          source === "dashboard" ||
          source === "background") &&
        target === "content"
      );
    case "candidate.scan.result":
      return source === "content" && target === "background";
    case "offscreen.download":
      return source === "offscreen" && target === "background";
    case "queue.enqueue":
    case "queue.snapshot.request":
    case "job.cancel":
    case "job.pause":
    case "job.retry":
    case "settings.get":
    case "settings.update":
    case "experimental-consent.set":
      return (
        (source === "popup" || source === "dashboard") &&
        target === "background"
      );
    case "queue.snapshot":
    case "settings.value":
      return (
        source === "background" &&
        (target === "popup" || target === "dashboard")
      );
    case "offscreen.execute":
    case "offscreen.cancel":
      return source === "background" && target === "offscreen";
    case "offscreen.download.result":
      return source === "background" && target === "offscreen";
    case "job.progress":
    case "job.completed":
    case "job.failed":
      return (
        (source === "offscreen" && target === "background") ||
        (source === "background" &&
          (target === "popup" || target === "dashboard"))
      );
    case "ack":
    case "error":
      return source !== target;
  }
}
