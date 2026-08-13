import { createDefaultResolverRegistry } from "../src/adapters";
import { recoverBackgroundJobs } from "../src/background/recovery";
import {
  beginDownload,
  beginProcessing,
  completeJob,
  createMediaJob,
  failOrRequeueJob,
  isTerminalStatus,
} from "../src/domain/job-lifecycle";
import type {
  AppSettings,
  JobError,
  MediaJob,
  ResolvedSource,
} from "../src/domain/schemas";
import {
  MESSAGE_PROTOCOL_VERSION,
  MessageEnvelopeSchema,
  type ExtensionContext,
  type ExtensionMessage,
  type MessageEnvelope,
} from "../src/messaging";
import {
  HistoryRepository,
  QueueRepository,
  SettingsRepository,
  openMediaFetchDatabase,
  type SettingsPatch,
} from "../src/persistence";

const RETRY_ALARM = "mediafetch-retry";
const OFFSCREEN_PATH = "/offscreen.html";

type OffscreenEvent = Extract<
  ExtensionMessage,
  { kind: "job.progress" | "job.completed" | "job.failed" }
>;

function requestId(prefix = "background"): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function outgoingEnvelope(
  target: ExtensionContext,
  message: ExtensionMessage,
  correlationId?: string,
): MessageEnvelope {
  return MessageEnvelopeSchema.parse({
    protocolVersion: MESSAGE_PROTOCOL_VERSION,
    requestId: requestId(),
    ...(correlationId === undefined ? {} : { correlationId }),
    sentAt: Date.now(),
    source: "background",
    target,
    message,
  });
}

function errorDetails(error: unknown): Omit<JobError, "occurredAt"> {
  if (error instanceof DOMException && error.name === "AbortError") {
    return {
      code: "aborted",
      message: error.message || "El trabajo fue interrumpido.",
      retryable: true,
    };
  }
  const message =
    error instanceof Error ? error.message : "Error desconocido del trabajo.";
  const consentError = message.toLowerCase().includes("consent");
  return {
    code: consentError ? "experimental_consent_required" : "execution_failed",
    message,
    retryable: !consentError,
  };
}

function senderMatchesSource(
  envelope: MessageEnvelope,
  sender: {
    readonly url?: string | undefined;
    readonly tab?: { readonly id?: number | undefined } | undefined;
  },
): boolean {
  if (envelope.source === "content") {
    return (
      sender.tab?.id !== undefined &&
      envelope.message.kind === "candidate.scan.result" &&
      envelope.message.payload.tabId === sender.tab.id
    );
  }
  const expectedPath: Partial<Record<ExtensionContext, string>> = {
    popup: "/popup.html",
    dashboard: "/dashboard.html",
    offscreen: "/offscreen.html",
  };
  const path = expectedPath[envelope.source];
  if (path === undefined || sender.url === undefined) return false;
  try {
    const url = new URL(sender.url);
    return (
      url.origin === new URL(browser.runtime.getURL("/")).origin &&
      url.pathname === path
    );
  } catch {
    return false;
  }
}

class BackgroundCoordinator {
  readonly #resolvers = createDefaultResolverRegistry();
  readonly #databasePromise = openMediaFetchDatabase();
  readonly #queuePromise = this.#databasePromise.then(
    (database) => new QueueRepository(database),
  );
  readonly #historyPromise = this.#databasePromise.then(
    (database) => new HistoryRepository(database),
  );
  readonly #settingsPromise = this.#databasePromise.then(
    (database) => new SettingsRepository(database),
  );
  #active:
    | {
        readonly jobId: string;
        readonly controller: AbortController;
      }
    | undefined;
  #offscreenCreation: Promise<void> | undefined;
  #initialized = false;
  #pumpScheduled = false;

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;

    const queue = await this.#queuePromise;
    const settings = await (await this.#settingsPromise).get();
    await recoverBackgroundJobs({
      queue,
      settings,
      now: Date.now(),
      hasOffscreenDocument: () => browser.offscreen.hasDocument(),
      cancelOffscreenJob: (jobId) => this.#sendOffscreenCancel(jobId),
    });

    await this.#pruneHistory(settings);
    await this.#broadcastSnapshot();
    this.schedulePump();
  }

  async handle(
    envelope: MessageEnvelope,
  ): Promise<MessageEnvelope | undefined> {
    await this.initialize();
    const message = envelope.message;

    if (envelope.source === "offscreen") {
      if (message.kind === "offscreen.download") {
        return outgoingEnvelope(
          "offscreen",
          {
            kind: "offscreen.download.result",
            payload: await this.#downloadOffscreenOutput(
              message.payload.jobId,
              message.payload.blobUrl,
              message.payload.output,
            ),
          },
          envelope.requestId,
        );
      }
      if (
        message.kind === "job.progress" ||
        message.kind === "job.completed" ||
        message.kind === "job.failed"
      ) {
        await this.#handleOffscreenEvent(message);
      }
      return undefined;
    }

    if (envelope.source !== "popup" && envelope.source !== "dashboard") {
      return undefined;
    }
    const source = envelope.source;

    switch (message.kind) {
      case "queue.enqueue": {
        const settings = await (await this.#settingsPromise).get();
        const job = createMediaJob({
          id: `job-${requestId("job")}`,
          ...(message.payload.batchId === undefined
            ? {}
            : { batchId: message.payload.batchId }),
          candidate: message.payload.candidate,
          output: message.payload.output,
          retryPolicy: settings.retryPolicy,
          now: Date.now(),
        });
        await (await this.#queuePromise).enqueue(job);
        await this.#broadcastSnapshot();
        this.schedulePump();
        return outgoingEnvelope(
          source,
          { kind: "ack", payload: { accepted: true } },
          envelope.requestId,
        );
      }
      case "queue.snapshot.request":
        return outgoingEnvelope(
          source,
          {
            kind: "queue.snapshot",
            payload: await this.#snapshot(),
          },
          envelope.requestId,
        );
      case "job.cancel": {
        await this.#cancelJob(message.payload.jobId, message.payload.reason);
        return outgoingEnvelope(
          source,
          { kind: "ack", payload: { accepted: true } },
          envelope.requestId,
        );
      }
      case "job.pause": {
        await this.#pauseJob(message.payload.jobId);
        return outgoingEnvelope(
          source,
          { kind: "ack", payload: { accepted: true } },
          envelope.requestId,
        );
      }
      case "job.retry": {
        await this.#retryJob(message.payload.jobId);
        return outgoingEnvelope(
          source,
          { kind: "ack", payload: { accepted: true } },
          envelope.requestId,
        );
      }
      case "settings.get":
        return outgoingEnvelope(
          source,
          {
            kind: "settings.value",
            payload: await (await this.#settingsPromise).get(),
          },
          envelope.requestId,
        );
      case "settings.update":
        await (
          await this.#settingsPromise
        ).update(
          Object.fromEntries(
            Object.entries(message.payload).filter(
              ([, value]) => value !== undefined,
            ),
          ) as SettingsPatch,
          Date.now(),
        );
        return outgoingEnvelope(
          source,
          { kind: "ack", payload: { accepted: true } },
          envelope.requestId,
        );
      case "experimental-consent.set":
        await (
          await this.#settingsPromise
        ).setExperimentalConsent(message.payload, Date.now());
        return outgoingEnvelope(
          source,
          { kind: "ack", payload: { accepted: true } },
          envelope.requestId,
        );
      default:
        return undefined;
    }
  }

  schedulePump(): void {
    if (this.#pumpScheduled || this.#active !== undefined) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      void serialize(() => this.pump());
    });
  }

  async pump(): Promise<void> {
    await this.initialize();
    if (this.#active !== undefined) return;

    const queue = await this.#queuePromise;
    const job = await queue.claimNext(Date.now());
    if (job === undefined) {
      await this.#scheduleRetryAlarm();
      return;
    }

    const controller = new AbortController();
    this.#active = { jobId: job.id, controller };
    await this.#broadcastSnapshot();

    try {
      const settings = await (await this.#settingsPromise).get();
      const source = await this.#resolveSource(
        job,
        settings,
        controller.signal,
      );
      if (controller.signal.aborted) throw controller.signal.reason;

      const downloading = beginDownload(job, source.id, Date.now());
      await queue.save(downloading);
      await this.#ensureOffscreenDocument();
      const response = (await browser.runtime.sendMessage(
        outgoingEnvelope("offscreen", {
          kind: "offscreen.execute",
          payload: { job: downloading, source },
        }),
      )) as { accepted?: boolean } | undefined;
      if (response?.accepted !== true) {
        throw new Error("El documento offscreen no aceptó el trabajo.");
      }
      await this.#broadcastSnapshot();
    } catch (error) {
      if (this.#active?.jobId !== job.id) return;
      this.#active = undefined;
      await this.#persistFailure(job.id, errorDetails(error));
      this.schedulePump();
    }
  }

  async errorResponse(
    envelope: MessageEnvelope,
    error: unknown,
  ): Promise<MessageEnvelope> {
    const message = error instanceof Error ? error.message : "Error interno.";
    return outgoingEnvelope(
      envelope.source,
      {
        kind: "error",
        payload: {
          code: "background_error",
          message,
          retryable: false,
        },
      },
      envelope.requestId,
    );
  }

  async #resolveSource(
    job: MediaJob,
    settings: AppSettings,
    signal: AbortSignal,
  ): Promise<ResolvedSource> {
    const context = {
      signal,
      consent: settings.experimentalConsent,
    };
    const resolvers = this.#resolvers.supporting(
      job.candidate,
      settings.experimentalConsent,
    );
    for (const resolver of resolvers) {
      const [source] = await resolver.resolve(job.candidate, context);
      if (source !== undefined) return source;
    }
    if (
      job.candidate.sourceHints.some((hint) =>
        hint.adapterId.endsWith("-experimental"),
      ) &&
      !settings.experimentalConsent.granted
    ) {
      throw new Error("Experimental resolver consent is required.");
    }
    throw new Error("No se encontró una fuente compatible y autorizada.");
  }

  async #handleOffscreenEvent(message: OffscreenEvent): Promise<void> {
    const active = this.#active;
    if (active === undefined || active.jobId !== message.payload.jobId) return;

    const queue = await this.#queuePromise;
    const job = await queue.get(message.payload.jobId);
    if (job === undefined || isTerminalStatus(job.state.status)) return;

    if (message.kind === "job.progress") {
      let current = job;
      if (
        message.payload.progress.phase === "processing" &&
        current.state.status === "downloading"
      ) {
        current = beginProcessing(current, Date.now());
        await queue.save(current);
      }
      const updated = await queue.updateProgress(
        current.id,
        message.payload.progress,
      );
      await this.#broadcast({
        kind: "job.progress",
        payload: {
          jobId: updated.id,
          ...(updated.batchId === undefined
            ? {}
            : { batchId: updated.batchId }),
          progress: updated.progress,
        },
      });
      return;
    }

    this.#active = undefined;
    if (message.kind === "job.completed") {
      const completed = completeJob(job, message.payload.output, Date.now());
      await queue.save(completed);
      await this.#broadcast({
        kind: "job.completed",
        payload: {
          jobId: completed.id,
          ...(completed.batchId === undefined
            ? {}
            : { batchId: completed.batchId }),
          output: message.payload.output,
        },
      });
      await queue.archive(completed.id, Date.now());
      await this.#broadcastSnapshot();
      this.schedulePump();
      return;
    }

    await this.#persistFailure(message.payload.jobId, {
      code: message.payload.error.code,
      message: message.payload.error.message,
      retryable: message.payload.error.retryable,
    });
    this.schedulePump();
  }

  async #persistFailure(
    jobId: string,
    error: Omit<JobError, "occurredAt">,
  ): Promise<void> {
    const queue = await this.#queuePromise;
    const job = await queue.get(jobId);
    if (job === undefined || isTerminalStatus(job.state.status)) return;
    const settings = await (await this.#settingsPromise).get();
    const failed = failOrRequeueJob(
      job,
      error,
      settings.retryPolicy,
      Date.now(),
    );
    await queue.save(failed);
    await this.#broadcast({
      kind: "job.failed",
      payload: {
        jobId: failed.id,
        ...(failed.batchId === undefined ? {} : { batchId: failed.batchId }),
        error: {
          ...error,
          occurredAt: Date.now(),
        },
      },
    });
    if (failed.state.status === "failed") {
      await queue.archive(failed.id, Date.now());
    }
    await this.#broadcastSnapshot();
    await this.#scheduleRetryAlarm();
  }

  async #cancelJob(jobId: string, reason?: string): Promise<void> {
    const queue = await this.#queuePromise;
    const job = await queue.get(jobId);
    if (job === undefined) throw new Error(`Trabajo no encontrado: ${jobId}`);
    if (isTerminalStatus(job.state.status)) return;

    const active = this.#active?.jobId === jobId;
    if (active) {
      this.#active?.controller.abort(
        new DOMException("Cancelado por el usuario.", "AbortError"),
      );
      await this.#sendOffscreenCancel(jobId).catch(() => undefined);
      this.#active = undefined;
    }
    await queue.cancel(jobId, Date.now(), reason);
    await queue.archive(jobId, Date.now());
    await this.#broadcastSnapshot();
    this.schedulePump();
  }

  async #pauseJob(jobId: string): Promise<void> {
    const queue = await this.#queuePromise;
    const job = await queue.get(jobId);
    if (job === undefined) throw new Error(`Trabajo no encontrado: ${jobId}`);
    if (job.state.status === "paused") return;
    if (isTerminalStatus(job.state.status)) {
      throw new Error("No se puede pausar un trabajo finalizado.");
    }

    if (this.#active?.jobId === jobId) {
      this.#active.controller.abort(
        new DOMException("Pausado por el usuario.", "AbortError"),
      );
      await this.#sendOffscreenCancel(jobId).catch(() => undefined);
      this.#active = undefined;
    }
    await queue.pause(jobId, Date.now());
    await this.#broadcastSnapshot();
    this.schedulePump();
  }

  async #retryJob(jobId: string): Promise<void> {
    const queue = await this.#queuePromise;
    await queue.retry(jobId, Date.now());
    await this.#broadcastSnapshot();
    this.schedulePump();
  }

  async #downloadOffscreenOutput(
    jobId: string,
    blobUrl: string,
    output: {
      readonly filename: string;
      readonly format: MediaJob["output"]["format"];
      readonly size?: number | undefined;
    },
  ) {
    if (this.#active?.jobId !== jobId) {
      throw new Error("El trabajo offscreen ya no está activo.");
    }
    const parsedUrl = new URL(blobUrl);
    const extensionOrigin = new URL(browser.runtime.getURL("/")).origin;
    if (
      parsedUrl.protocol !== "blob:" ||
      parsedUrl.origin !== extensionOrigin
    ) {
      throw new Error("El documento offscreen envió un blob no autorizado.");
    }
    const downloadId = await browser.downloads.download({
      url: parsedUrl.href,
      filename: output.filename,
      saveAs: false,
    });
    return {
      ...output,
      downloadId,
    };
  }

  async #ensureOffscreenDocument(): Promise<void> {
    if (await browser.offscreen.hasDocument()) return;
    this.#offscreenCreation ??= browser.offscreen
      .createDocument({
        url: browser.runtime.getURL(OFFSCREEN_PATH),
        reasons: ["BLOBS", "WORKERS"],
        justification:
          "Ejecutar FFmpeg WASM en workers, procesar un trabajo multimedia local y guardar su blob.",
      })
      .finally(() => {
        this.#offscreenCreation = undefined;
      });
    await this.#offscreenCreation;
  }

  async #sendOffscreenCancel(jobId: string): Promise<void> {
    if (!(await browser.offscreen.hasDocument().catch(() => false))) return;
    await browser.runtime.sendMessage(
      outgoingEnvelope("offscreen", {
        kind: "offscreen.cancel",
        payload: { jobId },
      }),
    );
  }

  async #snapshot() {
    const [jobs, history] = await Promise.all([
      (await this.#queuePromise).list(),
      (await this.#historyPromise).list(),
    ]);
    return { jobs: [...jobs], history: [...history] };
  }

  async #broadcastSnapshot(): Promise<void> {
    await this.#broadcast({
      kind: "queue.snapshot",
      payload: await this.#snapshot(),
    });
  }

  async #broadcast(message: ExtensionMessage): Promise<void> {
    await Promise.all(
      (["dashboard", "popup"] as const).map((target) =>
        browser.runtime
          .sendMessage(outgoingEnvelope(target, message))
          .catch(() => undefined),
      ),
    );
  }

  async #scheduleRetryAlarm(): Promise<void> {
    const queued = await (await this.#queuePromise).list({ status: "queued" });
    const nextAttemptAt = queued
      .map((job) =>
        job.state.status === "queued" ? job.state.nextAttemptAt : undefined,
      )
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => left - right)[0];
    if (nextAttemptAt === undefined) {
      await browser.alarms.clear(RETRY_ALARM);
      return;
    }
    browser.alarms.create(RETRY_ALARM, {
      when: Math.max(Date.now() + 100, nextAttemptAt),
    });
  }

  async #pruneHistory(settings: AppSettings): Promise<void> {
    const cutoff =
      Date.now() - settings.historyRetentionDays * 24 * 60 * 60 * 1_000;
    await (await this.#historyPromise).deleteArchivedBefore(cutoff);
  }
}

const coordinator = new BackgroundCoordinator();
let operationChain: Promise<void> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationChain.then(operation, operation);
  operationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((value: unknown, sender) => {
    if (sender.id !== browser.runtime.id) return undefined;
    const parsed = MessageEnvelopeSchema.safeParse(value);
    if (!parsed.success || parsed.data.target !== "background")
      return undefined;
    const envelope = parsed.data;
    if (!senderMatchesSource(envelope, sender)) return undefined;

    return serialize(() => coordinator.handle(envelope)).catch((error) =>
      coordinator.errorResponse(envelope, error),
    );
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) coordinator.schedulePump();
  });
  browser.runtime.onStartup.addListener(() => {
    void serialize(() => coordinator.initialize());
  });
  browser.runtime.onInstalled.addListener(() => {
    void serialize(() => coordinator.initialize());
  });

  void serialize(() => coordinator.initialize());
});
