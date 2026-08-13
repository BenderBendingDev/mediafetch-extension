import type {
  ExtensionMessage,
  MessageEnvelope,
} from "../../src/messaging/contracts";
import {
  MESSAGE_PROTOCOL_VERSION,
  MessageEnvelopeSchema,
} from "../../src/messaging/contracts";
import {
  FfmpegEngine,
  LocalMediaProcessor,
  throwIfAborted,
  toJobError,
  type ProcessedMedia,
} from "../../src/media";
import { ffmpegCorePublicPath, ffmpegWasmPublicPath } from "./core-assets";

type ExecuteMessage = Omit<MessageEnvelope, "message"> & {
  readonly message: Extract<ExtensionMessage, { kind: "offscreen.execute" }>;
};
type OutgoingMessage = Extract<
  ExtensionMessage,
  {
    kind: "ack" | "error" | "job.completed" | "job.failed" | "job.progress";
  }
>;

interface ActiveJob {
  readonly jobId: string;
  readonly controller: AbortController;
}

const processor = new LocalMediaProcessor(
  new FfmpegEngine({
    runtimeGetURL: (path) =>
      (browser.runtime.getURL as (publicPath: string) => string)(path),
    corePublicPath: ffmpegCorePublicPath,
    wasmPublicPath: ffmpegWasmPublicPath,
  }),
);
const blobUrls = new Set<string>();
let activeJob: ActiveJob | undefined;

browser.runtime.onMessage.addListener(
  (value: unknown, sender): undefined | Promise<{ accepted: boolean }> => {
    if (sender.id !== browser.runtime.id) return undefined;
    const parsed = MessageEnvelopeSchema.safeParse(value);
    if (!parsed.success || parsed.data.target !== "offscreen") return undefined;

    const envelope = parsed.data;
    if (envelope.message.kind === "offscreen.execute") {
      if (activeJob !== undefined) {
        void emit(
          failedMessage(
            envelope.message.payload.job.id,
            envelope.message.payload.job.batchId,
            {
              code: "offscreen_busy",
              message: `El trabajo ${activeJob.jobId} sigue en curso.`,
              retryable: true,
              occurredAt: Date.now(),
            },
          ),
          envelope.requestId,
        );
        return Promise.resolve({ accepted: false });
      }
      startJob(envelope as ExecuteMessage);
      void emit(
        { kind: "ack", payload: { accepted: true } },
        envelope.requestId,
      );
      return Promise.resolve({ accepted: true });
    }

    if (envelope.message.kind === "offscreen.cancel") {
      const jobToCancel = activeJob;
      const matches = jobToCancel?.jobId === envelope.message.payload.jobId;
      if (matches && jobToCancel !== undefined) {
        jobToCancel.controller.abort(
          new DOMException("Cancelado por el background.", "AbortError"),
        );
      }
      void emit(
        { kind: "ack", payload: { accepted: matches } },
        envelope.requestId,
      );
      return Promise.resolve({ accepted: matches });
    }

    return undefined;
  },
);

window.addEventListener("pagehide", () => {
  activeJob?.controller.abort(
    new DOMException("El documento offscreen se cerró.", "AbortError"),
  );
  processor.dispose();
  revokeAllBlobUrls();
});

function startJob(envelope: ExecuteMessage): void {
  const { job, source } = envelope.message.payload;
  const controller = new AbortController();
  activeJob = { jobId: job.id, controller };

  void (async () => {
    try {
      const result = await processor.process(job, source, {
        signal: controller.signal,
        onProgress: async (progress) => {
          await emit(
            {
              kind: "job.progress",
              payload: {
                jobId: job.id,
                ...(job.batchId === undefined ? {} : { batchId: job.batchId }),
                progress,
              },
            },
            envelope.requestId,
          );
        },
      });
      const output = await saveBlob(result, controller.signal);
      await emit(
        {
          kind: "job.completed",
          payload: {
            jobId: job.id,
            ...(job.batchId === undefined ? {} : { batchId: job.batchId }),
            output,
          },
        },
        envelope.requestId,
      );
    } catch (error) {
      await emit(
        failedMessage(job.id, job.batchId, toJobError(error, Date.now())),
        envelope.requestId,
      );
    } finally {
      if (activeJob?.jobId === job.id) activeJob = undefined;
    }
  })();
}

async function saveBlob(
  result: ProcessedMedia,
  signal: AbortSignal,
): Promise<{
  filename: string;
  format: ProcessedMedia["format"];
  size: number;
  downloadId: number;
}> {
  throwIfAborted(signal);
  const blobUrl = URL.createObjectURL(result.blob);
  blobUrls.add(blobUrl);
  const abortDownload = (): void => {
    revokeBlobUrl(blobUrl);
  };
  signal.addEventListener("abort", abortDownload, { once: true });

  try {
    const request = MessageEnvelopeSchema.parse({
      protocolVersion: MESSAGE_PROTOCOL_VERSION,
      requestId: crypto.randomUUID(),
      sentAt: Date.now(),
      source: "offscreen",
      target: "background",
      message: {
        kind: "offscreen.download",
        payload: {
          jobId: activeJob?.jobId,
          blobUrl,
          output: {
            filename: result.filename,
            format: result.format,
            size: result.blob.size,
          },
        },
      },
    });
    const response = MessageEnvelopeSchema.parse(
      await browser.runtime.sendMessage(request),
    );
    throwIfAborted(signal);
    if (response.message.kind === "error") {
      throw new Error(response.message.payload.message);
    }
    if (response.message.kind !== "offscreen.download.result") {
      throw new Error("El background no confirmó la descarga procesada.");
    }
    const output = response.message.payload;
    if (output.downloadId === undefined || output.size === undefined) {
      throw new Error("El background devolvió una descarga incompleta.");
    }
    scheduleBlobUrlCleanup(blobUrl);
    return {
      filename: output.filename,
      format: output.format,
      size: output.size,
      downloadId: output.downloadId,
    };
  } catch (error) {
    revokeBlobUrl(blobUrl);
    throw error;
  } finally {
    signal.removeEventListener("abort", abortDownload);
  }
}

function scheduleBlobUrlCleanup(blobUrl: string): void {
  window.setTimeout(() => revokeBlobUrl(blobUrl), 60_000);
}

function revokeBlobUrl(blobUrl: string): void {
  if (!blobUrls.delete(blobUrl)) return;
  URL.revokeObjectURL(blobUrl);
}

function revokeAllBlobUrls(): void {
  for (const blobUrl of blobUrls) URL.revokeObjectURL(blobUrl);
  blobUrls.clear();
}

function failedMessage(
  jobId: string,
  batchId: string | undefined,
  error: Extract<ExtensionMessage, { kind: "job.failed" }>["payload"]["error"],
): Extract<ExtensionMessage, { kind: "job.failed" }> {
  return {
    kind: "job.failed",
    payload: {
      jobId,
      ...(batchId === undefined ? {} : { batchId }),
      error,
    },
  };
}

async function emit(
  message: OutgoingMessage,
  correlationId: string,
): Promise<void> {
  const envelope = {
    protocolVersion: MESSAGE_PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    correlationId,
    sentAt: Date.now(),
    source: "offscreen",
    target: "background",
    message,
  } satisfies MessageEnvelope;
  await browser.runtime.sendMessage(envelope).catch(() => undefined);
}
