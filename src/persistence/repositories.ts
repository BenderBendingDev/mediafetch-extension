import {
  beginJobAttempt,
  pauseJob,
  requestJobCancellation,
  retryFailedJob,
  updateJobProgress,
} from "../domain/job-lifecycle";
import {
  AppSettingsSchema,
  DEFAULT_SETTINGS,
  ExperimentalConsentSchema,
  HistoryEntrySchema,
  MediaJobSchema,
  type AppSettings,
  type ExperimentalConsent,
  type HistoryEntry,
  type JobProgress,
  type JobStatus,
  type MediaJob,
} from "../domain/schemas";
import {
  SETTINGS_KEY,
  type MediaFetchDatabase,
  type SettingsRecord,
} from "./database";

export interface EnqueueResult {
  readonly job: MediaJob;
  readonly inserted: boolean;
}

export interface QueueFilter {
  readonly status?: JobStatus;
  readonly batchId?: string;
}

export interface QueueRepositoryContract {
  enqueue(job: MediaJob): Promise<EnqueueResult>;
  get(id: string): Promise<MediaJob | undefined>;
  list(filter?: QueueFilter): Promise<readonly MediaJob[]>;
  save(job: MediaJob): Promise<void>;
  claimNext(now: number): Promise<MediaJob | undefined>;
  updateProgress(id: string, progress: JobProgress): Promise<MediaJob>;
  pause(id: string, now: number): Promise<MediaJob>;
  cancel(id: string, now: number, reason?: string): Promise<MediaJob>;
  retry(id: string, now: number): Promise<MediaJob>;
  archive(id: string, archivedAt: number): Promise<HistoryEntry>;
}

export class QueueRepository implements QueueRepositoryContract {
  public constructor(private readonly database: MediaFetchDatabase) {}

  public async enqueue(job: MediaJob): Promise<EnqueueResult> {
    const parsedJob = MediaJobSchema.parse(job);
    const transaction = this.database.transaction("queue", "readwrite");
    const existing = await transaction.store
      .index("by-dedupe-key")
      .get(parsedJob.dedupeKey);
    if (existing !== undefined) {
      await transaction.done;
      return {
        job: MediaJobSchema.parse(existing),
        inserted: false,
      };
    }
    await transaction.store.add(parsedJob);
    await transaction.done;
    return { job: parsedJob, inserted: true };
  }

  public async get(id: string): Promise<MediaJob | undefined> {
    const value = await this.database.get("queue", id);
    return value === undefined ? undefined : MediaJobSchema.parse(value);
  }

  public async list(filter: QueueFilter = {}): Promise<readonly MediaJob[]> {
    let values: MediaJob[];
    if (filter.status !== undefined) {
      values = await this.database.getAllFromIndex(
        "queue",
        "by-status",
        filter.status,
      );
    } else if (filter.batchId !== undefined) {
      values = await this.database.getAllFromIndex(
        "queue",
        "by-batch-id",
        filter.batchId,
      );
    } else {
      values = await this.database.getAll("queue");
    }
    return values
      .map((value) => MediaJobSchema.parse(value))
      .filter(
        (job) => filter.batchId === undefined || job.batchId === filter.batchId,
      )
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  public async save(job: MediaJob): Promise<void> {
    await this.database.put("queue", MediaJobSchema.parse(job));
  }

  public async claimNext(now: number): Promise<MediaJob | undefined> {
    const transaction = this.database.transaction("queue", "readwrite");
    const values = await transaction.store.index("by-status").getAll("queued");
    const eligible = values
      .map((value) => MediaJobSchema.parse(value))
      .filter(
        (job) =>
          job.attempts < job.maxAttempts &&
          (job.state.status !== "queued" ||
            job.state.nextAttemptAt === undefined ||
            job.state.nextAttemptAt <= now),
      )
      .sort((left, right) => left.createdAt - right.createdAt)[0];

    if (eligible === undefined) {
      await transaction.done;
      return undefined;
    }
    const claimed = beginJobAttempt(eligible, now);
    await transaction.store.put(claimed);
    await transaction.done;
    return claimed;
  }

  public async updateProgress(
    id: string,
    progress: JobProgress,
  ): Promise<MediaJob> {
    return this.updateExisting(id, (job) => updateJobProgress(job, progress));
  }

  public async cancel(
    id: string,
    now: number,
    reason?: string,
  ): Promise<MediaJob> {
    return this.updateExisting(id, (job) =>
      requestJobCancellation(job, now, reason),
    );
  }

  public async pause(id: string, now: number): Promise<MediaJob> {
    return this.updateExisting(id, (job) => pauseJob(job, now));
  }

  public async retry(id: string, now: number): Promise<MediaJob> {
    const transaction = this.database.transaction(
      ["queue", "history"],
      "readwrite",
    );
    const queue = transaction.objectStore("queue");
    const history = transaction.objectStore("history");
    const queuedValue = await queue.get(id);

    if (queuedValue !== undefined) {
      const retried = retryFailedJob(MediaJobSchema.parse(queuedValue), now);
      await queue.put(retried);
      await transaction.done;
      return retried;
    }

    const historyValue = await history.get(id);
    if (historyValue === undefined) {
      transaction.abort();
      throw new Error(`Queue or history job not found: ${id}`);
    }
    const archived = HistoryEntrySchema.parse(historyValue);
    const retried = retryFailedJob(archived.job, now);
    const duplicate = await queue.index("by-dedupe-key").get(retried.dedupeKey);
    await history.delete(id);
    if (duplicate !== undefined) {
      await transaction.done;
      return MediaJobSchema.parse(duplicate);
    }
    await queue.put(retried);
    await transaction.done;
    return retried;
  }

  public async archive(id: string, archivedAt: number): Promise<HistoryEntry> {
    const transaction = this.database.transaction(
      ["queue", "history"],
      "readwrite",
    );
    const queue = transaction.objectStore("queue");
    const jobValue = await queue.get(id);
    if (jobValue === undefined) {
      transaction.abort();
      throw new Error(`Queue job not found: ${id}`);
    }
    const entry = HistoryEntrySchema.parse({
      id,
      job: MediaJobSchema.parse(jobValue),
      archivedAt,
    });
    await transaction.objectStore("history").put(entry);
    await queue.delete(id);
    await transaction.done;
    return entry;
  }

  private async updateExisting(
    id: string,
    update: (job: MediaJob) => MediaJob,
  ): Promise<MediaJob> {
    const transaction = this.database.transaction("queue", "readwrite");
    const value = await transaction.store.get(id);
    if (value === undefined) {
      transaction.abort();
      throw new Error(`Queue job not found: ${id}`);
    }
    const updated = MediaJobSchema.parse(update(MediaJobSchema.parse(value)));
    await transaction.store.put(updated);
    await transaction.done;
    return updated;
  }
}

export interface HistoryFilter {
  readonly batchId?: string;
  readonly status?: JobStatus;
  readonly limit?: number;
}

export interface HistoryRepositoryContract {
  get(id: string): Promise<HistoryEntry | undefined>;
  list(filter?: HistoryFilter): Promise<readonly HistoryEntry[]>;
  delete(id: string): Promise<void>;
  deleteArchivedBefore(timestamp: number): Promise<number>;
  clear(): Promise<void>;
}

export class HistoryRepository implements HistoryRepositoryContract {
  public constructor(private readonly database: MediaFetchDatabase) {}

  public async get(id: string): Promise<HistoryEntry | undefined> {
    const value = await this.database.get("history", id);
    return value === undefined ? undefined : HistoryEntrySchema.parse(value);
  }

  public async list(
    filter: HistoryFilter = {},
  ): Promise<readonly HistoryEntry[]> {
    let values: HistoryEntry[];
    if (filter.status !== undefined) {
      values = await this.database.getAllFromIndex(
        "history",
        "by-status",
        filter.status,
      );
    } else if (filter.batchId !== undefined) {
      values = await this.database.getAllFromIndex(
        "history",
        "by-batch-id",
        filter.batchId,
      );
    } else {
      values = await this.database.getAll("history");
    }
    const entries = values
      .map((value) => HistoryEntrySchema.parse(value))
      .filter(
        (entry) =>
          filter.batchId === undefined || entry.job.batchId === filter.batchId,
      )
      .sort((left, right) => right.archivedAt - left.archivedAt);
    return filter.limit === undefined
      ? entries
      : entries.slice(0, Math.max(0, filter.limit));
  }

  public async delete(id: string): Promise<void> {
    await this.database.delete("history", id);
  }

  public async deleteArchivedBefore(timestamp: number): Promise<number> {
    const transaction = this.database.transaction("history", "readwrite");
    const index = transaction.store.index("by-archived-at");
    let cursor = await index.openCursor(
      IDBKeyRange.upperBound(timestamp, true),
    );
    let deleted = 0;
    while (cursor !== null) {
      await cursor.delete();
      deleted += 1;
      cursor = await cursor.continue();
    }
    await transaction.done;
    return deleted;
  }

  public async clear(): Promise<void> {
    await this.database.clear("history");
  }
}

export type SettingsPatch = Partial<
  Omit<AppSettings, "updatedAt" | "experimentalConsent">
> & {
  readonly experimentalConsent?: ExperimentalConsent;
};

export interface SettingsRepositoryContract {
  get(): Promise<AppSettings>;
  update(patch: SettingsPatch, now: number): Promise<AppSettings>;
  setExperimentalConsent(
    consent: ExperimentalConsent,
    now: number,
  ): Promise<AppSettings>;
}

export class SettingsRepository implements SettingsRepositoryContract {
  public constructor(private readonly database: MediaFetchDatabase) {}

  public async get(): Promise<AppSettings> {
    const record = await this.database.get("settings", SETTINGS_KEY);
    if (record !== undefined) {
      return AppSettingsSchema.parse(record.value);
    }
    return this.createDefaults(0);
  }

  public async update(patch: SettingsPatch, now: number): Promise<AppSettings> {
    const transaction = this.database.transaction("settings", "readwrite");
    const currentRecord = await transaction.store.get(SETTINGS_KEY);
    const current =
      currentRecord === undefined
        ? AppSettingsSchema.parse({ ...DEFAULT_SETTINGS, updatedAt: now })
        : AppSettingsSchema.parse(currentRecord.value);
    const value = AppSettingsSchema.parse({
      ...current,
      ...patch,
      updatedAt: now,
    });
    const record: SettingsRecord = { key: SETTINGS_KEY, value };
    await transaction.store.put(record);
    await transaction.done;
    return value;
  }

  public async setExperimentalConsent(
    consent: ExperimentalConsent,
    now: number,
  ): Promise<AppSettings> {
    return this.update(
      {
        experimentalConsent: ExperimentalConsentSchema.parse(consent),
      },
      now,
    );
  }

  private async createDefaults(now: number): Promise<AppSettings> {
    const value = AppSettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      experimentalConsent: {
        ...DEFAULT_SETTINGS.experimentalConsent,
        updatedAt: now,
      },
      updatedAt: now,
    });
    const record: SettingsRecord = { key: SETTINGS_KEY, value };
    await this.database.put("settings", record);
    return value;
  }
}
