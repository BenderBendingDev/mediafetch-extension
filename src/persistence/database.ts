import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
} from "idb";
import type {
  AppSettings,
  HistoryEntry,
  JobStatus,
  MediaJob,
} from "../domain/schemas";

export const MEDIA_FETCH_DB_NAME = "mediafetch";
export const MEDIA_FETCH_DB_VERSION = 1;
export const SETTINGS_KEY = "app";

export interface SettingsRecord {
  readonly key: typeof SETTINGS_KEY;
  readonly value: AppSettings;
}

export interface MediaFetchDatabaseSchema extends DBSchema {
  queue: {
    key: string;
    value: MediaJob;
    indexes: {
      "by-status": JobStatus;
      "by-created-at": number;
      "by-batch-id": string;
      "by-dedupe-key": string;
    };
  };
  history: {
    key: string;
    value: HistoryEntry;
    indexes: {
      "by-archived-at": number;
      "by-status": JobStatus;
      "by-batch-id": string;
    };
  };
  settings: {
    key: typeof SETTINGS_KEY;
    value: SettingsRecord;
  };
}

export type MediaFetchDatabase = IDBPDatabase<MediaFetchDatabaseSchema>;
export type MediaFetchWriteTransaction = IDBPTransaction<
  MediaFetchDatabaseSchema,
  ("queue" | "history" | "settings")[],
  "readwrite"
>;

export function openMediaFetchDatabase(
  name = MEDIA_FETCH_DB_NAME,
): Promise<MediaFetchDatabase> {
  return openDB<MediaFetchDatabaseSchema>(name, MEDIA_FETCH_DB_VERSION, {
    upgrade(database, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        const queue = database.createObjectStore("queue", { keyPath: "id" });
        queue.createIndex("by-status", "state.status");
        queue.createIndex("by-created-at", "createdAt");
        queue.createIndex("by-batch-id", "batchId");
        queue.createIndex("by-dedupe-key", "dedupeKey", { unique: true });

        const history = database.createObjectStore("history", {
          keyPath: "id",
        });
        history.createIndex("by-archived-at", "archivedAt");
        history.createIndex("by-status", "job.state.status");
        history.createIndex("by-batch-id", "job.batchId");

        database.createObjectStore("settings", { keyPath: "key" });

        // This transaction is intentionally left empty. Defaults are created
        // lazily by SettingsRepository so their timestamp comes from its clock.
        void transaction;
      }
    },
    blocked() {
      console.warn("MediaFetch database upgrade is blocked by another context");
    },
    blocking(_currentVersion, _blockedVersion, event) {
      const database = event.target;
      if (database instanceof IDBDatabase) {
        database.close();
      }
    },
  });
}
