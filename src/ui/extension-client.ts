import type {
  AppSettings,
  ExperimentalConsent,
  HistoryEntry,
  MediaCandidate,
  MediaJob,
  OutputRequest,
} from "../domain/schemas";
import { normalizeSnapshotCandidates, type PageSnapshot } from "../adapters";
import {
  MessageEnvelopeSchema,
  type ExtensionContext,
  type ExtensionMessage,
  type MessageEnvelope,
} from "../messaging/contracts";
import { classifyMediaUrl, normalizeCollectionItemLinks } from "./utils";

export interface ActiveTab {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

export interface QueueSnapshot {
  jobs: readonly MediaJob[];
  history: readonly HistoryEntry[];
}

export interface CollectionExpansionOptions {
  maxItems: number;
  timeoutMs?: number;
  maxScrolls?: number;
}

export interface CollectionExpansionResult {
  urls: readonly string[];
  truncated: boolean;
}

export type SettingsPatch = Partial<
  Omit<AppSettings, "updatedAt" | "experimentalConsent">
>;

let temporaryTabTail: Promise<void> = Promise.resolve();

export class ExtensionServiceError extends Error {
  public constructor(
    message: string,
    public readonly code = "service_unavailable",
    public readonly retryable = true,
  ) {
    super(message);
    this.name = "ExtensionServiceError";
  }
}

function id(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function envelope(
  source: "popup" | "dashboard",
  target: ExtensionContext,
  message: ExtensionMessage,
): MessageEnvelope {
  return MessageEnvelopeSchema.parse({
    protocolVersion: 1,
    requestId: id(),
    sentAt: Date.now(),
    source,
    target,
    message,
  });
}

function parseResponse(value: unknown): MessageEnvelope | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = MessageEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ExtensionServiceError(
      "Invalid extension service response",
      "invalid_response",
      false,
    );
  }
  if (parsed.data.message.kind === "error") {
    const error = parsed.data.message.payload;
    throw new ExtensionServiceError(error.message, error.code, error.retryable);
  }
  return parsed.data;
}

async function sendRuntime(
  source: "popup" | "dashboard",
  message: ExtensionMessage,
): Promise<MessageEnvelope | undefined> {
  try {
    return parseResponse(
      await browser.runtime.sendMessage(
        envelope(source, "background", message),
      ),
    );
  } catch (error) {
    if (error instanceof ExtensionServiceError) throw error;
    throw new ExtensionServiceError(
      error instanceof Error ? error.message : "Extension service unavailable",
    );
  }
}

function expectAck(response: MessageEnvelope | undefined): void {
  if (response === undefined) {
    throw new ExtensionServiceError("Extension service did not respond");
  }
  if (response.message.kind !== "ack") {
    throw new ExtensionServiceError(
      "Unexpected extension service response",
      "unexpected_response",
      false,
    );
  }
  if (!response.message.payload.accepted) {
    throw new ExtensionServiceError(
      "The request was rejected",
      "request_rejected",
      false,
    );
  }
}

export async function getActiveTab(): Promise<ActiveTab | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || tab.url === undefined) return null;
  const result: ActiveTab = {
    id: tab.id,
    title: tab.title?.trim() || new URL(tab.url).hostname,
    url: tab.url,
  };
  if (tab.favIconUrl !== undefined) result.favIconUrl = tab.favIconUrl;
  return result;
}

export function isScannableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function hostPermissionPatterns(
  pageUrls: readonly string[],
): readonly string[] {
  return [
    ...new Set(
      pageUrls.map((pageUrl) => {
        const url = new URL(pageUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new ExtensionServiceError(
            "Only HTTP(S) pages can be scanned",
            "invalid_url",
            false,
          );
        }
        // Match patterns do not carry URL ports; the permission remains scoped
        // to this scheme and hostname.
        return `${url.protocol}//${url.hostname}/*`;
      }),
    ),
  ];
}

export async function scanTab(
  source: "popup" | "dashboard",
  tabId: number,
  pageUrl: string,
): Promise<readonly MediaCandidate[]> {
  if (!isScannableUrl(pageUrl)) {
    throw new ExtensionServiceError(
      "Only HTTP(S) pages can be scanned",
      "invalid_url",
      false,
    );
  }
  await requestHostPermissions([pageUrl]);
  return scanLoadedTab(source, tabId, pageUrl);
}

export async function scanUrls(
  source: "popup" | "dashboard",
  pageUrls: readonly string[],
  activeTab?: ActiveTab | null,
): Promise<readonly MediaCandidate[]> {
  const urls = [...new Set(pageUrls.map((value) => new URL(value).href))];
  await requestHostPermissions(urls);
  const candidates: MediaCandidate[] = [];

  for (const requestedUrl of urls) {
    if (activeTab !== null && activeTab?.url === requestedUrl) {
      candidates.push(
        ...(await scanLoadedTab(source, activeTab.id, activeTab.url)),
      );
      continue;
    }

    candidates.push(
      ...(await withTemporaryLoadedTab(requestedUrl, async (tabId, loadedUrl) =>
        scanLoadedTab(source, tabId, loadedUrl),
      )),
    );
  }

  return [
    ...new Map(
      candidates.map((candidate) => [candidate.id, candidate]),
    ).values(),
  ];
}

export async function expandCollectionUrl(
  collectionUrl: string,
  options: CollectionExpansionOptions,
): Promise<CollectionExpansionResult> {
  if (classifyMediaUrl(collectionUrl) !== "collection") {
    throw new ExtensionServiceError(
      "The requested URL is not a supported collection",
      "invalid_collection_url",
      false,
    );
  }

  const maxItems = Math.min(500, Math.max(1, Math.floor(options.maxItems)));
  const timeoutMs = Math.min(
    15_000,
    Math.max(1_000, Math.floor(options.timeoutMs ?? 10_000)),
  );
  const maxScrolls = Math.min(
    20,
    Math.max(0, Math.floor(options.maxScrolls ?? 12)),
  );
  const rawLimit = Math.min(10_000, maxItems * 20 + 100);

  await requestHostPermissions([collectionUrl]);
  return withTemporaryLoadedTab(collectionUrl, async (tabId, loadedUrl) => {
    const [injection] = await browser.scripting.executeScript({
      target: { tabId },
      func: collectVisibleCollectionLinks,
      args: [{ timeoutMs, maxScrolls, rawLimit }],
    });
    if (injection?.result === undefined) {
      throw new ExtensionServiceError(
        "The collection page returned no visible links",
      );
    }

    const normalized = normalizeCollectionItemLinks(
      injection.result.links,
      loadedUrl,
      maxItems,
    );
    return {
      urls: normalized.urls,
      truncated: injection.result.truncated || normalized.truncated,
    };
  });
}

async function requestHostPermissions(
  pageUrls: readonly string[],
): Promise<void> {
  const origins = hostPermissionPatterns(pageUrls);
  const granted = await browser.permissions.request({ origins: [...origins] });
  if (!granted) {
    throw new ExtensionServiceError(
      "Host permission is required to scan the requested pages",
      "host_permission_denied",
      false,
    );
  }
}

async function withTemporaryTabSlot<T>(task: () => Promise<T>): Promise<T> {
  const predecessor = temporaryTabTail;
  let release = (): void => undefined;
  temporaryTabTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    return await task();
  } finally {
    release();
  }
}

async function withTemporaryLoadedTab<T>(
  requestedUrl: string,
  task: (tabId: number, loadedUrl: string) => Promise<T>,
): Promise<T> {
  return withTemporaryTabSlot(async () => {
    const temporaryTab = await browser.tabs.create({
      url: requestedUrl,
      active: false,
    });
    if (temporaryTab.id === undefined) {
      throw new ExtensionServiceError(
        "The temporary scan tab could not be created",
      );
    }
    try {
      await waitForTabLoad(temporaryTab.id, temporaryTab.status);
      const loadedTab = await browser.tabs.get(temporaryTab.id);
      if (loadedTab.url === undefined || !isScannableUrl(loadedTab.url)) {
        throw new ExtensionServiceError(
          "The scanned page did not load an HTTP(S) URL",
          "invalid_url",
          false,
        );
      }
      return await task(temporaryTab.id, loadedTab.url);
    } finally {
      await browser.tabs.remove(temporaryTab.id).catch(() => undefined);
    }
  });
}

async function scanLoadedTab(
  source: "popup" | "dashboard",
  tabId: number,
  pageUrl: string,
): Promise<readonly MediaCandidate[]> {
  try {
    const response = parseResponse(
      await browser.tabs.sendMessage(
        tabId,
        envelope(source, "content", {
          kind: "candidate.scan.request",
          payload: { tabId, pageUrl },
        }),
      ),
    );
    if (response?.message.kind === "candidate.scan.result") {
      return response.message.payload.candidates;
    }
  } catch {
    // A permitted page may predate content-script registration. Fall back to
    // an explicit isolated-world snapshot instead of failing the scan.
  }

  try {
    const [injection] = await browser.scripting.executeScript({
      target: { tabId },
      func: collectFallbackSnapshot,
    });
    if (injection?.result === undefined) {
      throw new Error("The injected detector returned no snapshot");
    }
    return normalizeSnapshotCandidates(injection.result);
  } catch (error) {
    throw new ExtensionServiceError(
      error instanceof Error ? error.message : "Page detector unavailable",
    );
  }
}

function waitForTabLoad(tabId: number, initialStatus?: string): Promise<void> {
  if (initialStatus === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(new ExtensionServiceError("Timed out while loading scan URL"));
    }, 30_000);
    const onUpdated = (
      updatedTabId: number,
      changeInfo: { status?: string },
    ): void => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    };
    const onRemoved = (removedTabId: number): void => {
      if (removedTabId === tabId) {
        cleanup();
        reject(new ExtensionServiceError("The scan tab was closed"));
      }
    };
    const cleanup = (): void => {
      globalThis.clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
  });
}

async function collectVisibleCollectionLinks(options: {
  timeoutMs: number;
  maxScrolls: number;
  rawLimit: number;
}): Promise<{ links: string[]; truncated: boolean }> {
  const links: string[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + options.timeoutMs;
  let truncated = false;
  let stablePasses = 0;
  let previousSize = 0;

  const collect = (): void => {
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
      "a[href]",
    )) {
      const rect = anchor.getBoundingClientRect();
      const style = getComputedStyle(anchor);
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.right >= 0 &&
        rect.top <= innerHeight &&
        rect.left <= innerWidth &&
        style.display !== "none" &&
        style.visibility !== "hidden";
      if (!visible || seen.has(anchor.href)) continue;
      seen.add(anchor.href);
      links.push(anchor.href);
      if (links.length >= options.rawLimit) {
        truncated = true;
        return;
      }
    }
  };

  for (let scroll = 0; scroll <= options.maxScrolls; scroll += 1) {
    collect();
    stablePasses = links.length === previousSize ? stablePasses + 1 : 0;
    previousSize = links.length;
    const atDocumentEnd =
      scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
    if (truncated) break;
    if (Date.now() >= deadline) {
      truncated = true;
      break;
    }
    if (atDocumentEnd && stablePasses >= 1) break;
    if (scroll === options.maxScrolls) {
      truncated = true;
      break;
    }

    const beforeY = scrollY;
    const beforeHeight = document.documentElement.scrollHeight;
    scrollBy({ top: Math.max(400, innerHeight * 0.85), behavior: "auto" });
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(400, Math.max(0, deadline - Date.now()))),
    );
    const reachedEnd =
      scrollY === beforeY &&
      document.documentElement.scrollHeight === beforeHeight;
    if (reachedEnd && stablePasses >= 1) break;
  }

  collect();
  return { links, truncated };
}

function collectFallbackSnapshot(): PageSnapshot {
  const resources: PageSnapshot["resources"][number][] = [];
  const seen = new Set<string>();
  const add = (
    value: string | null | undefined,
    source: PageSnapshot["resources"][number]["source"],
    details: Partial<PageSnapshot["resources"][number]> = {},
  ): void => {
    if (!value) return;
    try {
      const url = new URL(value, location.href);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        seen.has(url.href)
      ) {
        return;
      }
      seen.add(url.href);
      resources.push({ url: url.href, source, ...details });
    } catch {
      // Ignore malformed page-owned URLs.
    }
  };

  for (const element of document.querySelectorAll("video, audio")) {
    const media = element as HTMLMediaElement;
    const kind = media.tagName.toLowerCase() === "audio" ? "audio" : "video";
    const durationMs =
      Number.isFinite(media.duration) && media.duration >= 0
        ? Math.round(media.duration * 1_000)
        : undefined;
    add(media.currentSrc || media.getAttribute("src"), "media", {
      kind,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(media.getAttribute("type") === null
        ? {}
        : { mimeType: media.getAttribute("type") ?? undefined }),
    });
    for (const source of media.querySelectorAll("source[src]")) {
      add(source.getAttribute("src"), "source", {
        kind,
        ...(source.getAttribute("type") === null
          ? {}
          : { mimeType: source.getAttribute("type") ?? undefined }),
      });
    }
  }
  for (const entry of performance
    .getEntriesByType("resource")
    .slice(0, 2_000)) {
    if (
      /\.(?:mp3|m4a|aac|wav|flac|ogg|opus|mp4|m4v|webm|mov|m3u8|mpd)(?:$|[?#])/i.test(
        entry.name,
      )
    ) {
      add(entry.name, "performance");
    }
  }

  return {
    pageUrl: location.href,
    title: document.title.trim().slice(0, 500),
    resources: resources.slice(0, 500),
  };
}

export async function enqueueCandidate(
  source: "popup" | "dashboard",
  candidate: MediaCandidate,
  output: OutputRequest,
  batchId?: string,
): Promise<void> {
  const payload =
    batchId === undefined
      ? { candidate, output }
      : { candidate, output, batchId };
  expectAck(
    await sendRuntime(source, {
      kind: "queue.enqueue",
      payload,
    }),
  );
}

export async function getQueueSnapshot(
  source: "popup" | "dashboard",
): Promise<QueueSnapshot> {
  const response = await sendRuntime(source, {
    kind: "queue.snapshot.request",
    payload: {},
  });
  if (response?.message.kind !== "queue.snapshot") {
    throw new ExtensionServiceError("Queue service did not return a snapshot");
  }
  return response.message.payload;
}

export async function cancelJob(jobId: string, reason?: string): Promise<void> {
  const payload = reason === undefined ? { jobId } : { jobId, reason };
  expectAck(await sendRuntime("dashboard", { kind: "job.cancel", payload }));
}

export async function pauseJob(jobId: string): Promise<void> {
  expectAck(
    await sendRuntime("dashboard", {
      kind: "job.pause",
      payload: { jobId },
    }),
  );
}

export async function retryJob(jobId: string): Promise<void> {
  expectAck(
    await sendRuntime("dashboard", {
      kind: "job.retry",
      payload: { jobId },
    }),
  );
}

export async function getSettings(): Promise<AppSettings> {
  const response = await sendRuntime("dashboard", {
    kind: "settings.get",
    payload: {},
  });
  if (response?.message.kind !== "settings.value") {
    throw new ExtensionServiceError("Settings service did not return a value");
  }
  return response.message.payload;
}

export async function updateSettings(patch: SettingsPatch): Promise<void> {
  expectAck(
    await sendRuntime("dashboard", {
      kind: "settings.update",
      payload: patch,
    }),
  );
}

export async function setExperimentalConsent(
  consent: ExperimentalConsent,
): Promise<void> {
  expectAck(
    await sendRuntime("dashboard", {
      kind: "experimental-consent.set",
      payload: consent,
    }),
  );
}

export function subscribeToMessages(
  listener: (message: MessageEnvelope) => void,
): () => void {
  const handleMessage = (value: unknown) => {
    const parsed = MessageEnvelopeSchema.safeParse(value);
    if (parsed.success && parsed.data.target === "dashboard")
      listener(parsed.data);
    return undefined;
  };
  browser.runtime.onMessage.addListener(handleMessage);
  return () => browser.runtime.onMessage.removeListener(handleMessage);
}

export async function openDashboard(): Promise<void> {
  await browser.tabs.create({ url: browser.runtime.getURL("/dashboard.html") });
}
