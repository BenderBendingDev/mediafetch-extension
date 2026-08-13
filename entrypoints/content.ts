import {
  PAGE_BRIDGE_CHANNEL,
  PAGE_BRIDGE_VERSION,
  collectPageSnapshot,
  mergeSnapshots,
  normalizeSnapshotCandidates,
  parsePageBridgeResponse,
  type PageSnapshot,
} from "../src/adapters";
import {
  MESSAGE_PROTOCOL_VERSION,
  MessageEnvelopeSchema,
  type MessageEnvelope,
} from "../src/messaging";

const SNAPSHOT_TIMEOUT_MS = 300;

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    let pageWorldSnapshot: PageSnapshot | undefined;
    const pendingRequests = new Map<
      string,
      (snapshot: PageSnapshot | undefined) => void
    >();

    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.source !== window || event.origin !== window.location.origin) {
        return;
      }
      const parsed = parseUntrustedPageMessage(event.data);
      if (parsed === undefined) {
        return;
      }
      const resolve = pendingRequests.get(parsed.requestId);
      if (resolve === undefined) {
        return;
      }
      pageWorldSnapshot = parsed.payload;
      pendingRequests.delete(parsed.requestId);
      resolve(parsed.payload);
    });

    browser.runtime.onMessage.addListener((value: unknown) => {
      const envelope = MessageEnvelopeSchema.safeParse(value);
      if (
        !envelope.success ||
        envelope.data.target !== "content" ||
        envelope.data.message.kind !== "candidate.scan.request" ||
        envelope.data.message.payload.pageUrl !== window.location.href
      ) {
        return undefined;
      }
      return scanPage(envelope.data);
    });

    async function scanPage(
      request: MessageEnvelope,
    ): Promise<MessageEnvelope> {
      const requestId = createRequestId();
      const mainWorldSnapshot = await requestPageWorldSnapshot(requestId);
      const isolatedSnapshot = collectPageSnapshot(
        document,
        performance.getEntriesByType("resource").map((entry) => ({
          name: entry.name,
          ...("initiatorType" in entry &&
          typeof entry.initiatorType === "string"
            ? { initiatorType: entry.initiatorType }
            : {}),
        })),
      );
      const snapshot =
        mainWorldSnapshot === undefined
          ? pageWorldSnapshot === undefined
            ? isolatedSnapshot
            : mergeSnapshots(isolatedSnapshot, pageWorldSnapshot)
          : mergeSnapshots(isolatedSnapshot, mainWorldSnapshot);
      const message = request.message;
      if (message.kind !== "candidate.scan.request") {
        throw new Error("Unexpected scan message");
      }
      return MessageEnvelopeSchema.parse({
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        requestId: createRequestId(),
        correlationId: request.requestId,
        sentAt: Date.now(),
        source: "content",
        target: "background",
        message: {
          kind: "candidate.scan.result",
          payload: {
            tabId: message.payload.tabId,
            candidates: normalizeSnapshotCandidates(snapshot),
          },
        },
      });
    }

    function requestPageWorldSnapshot(
      requestId: string,
    ): Promise<PageSnapshot | undefined> {
      return new Promise((resolve) => {
        const timeout = window.setTimeout(() => {
          pendingRequests.delete(requestId);
          resolve(undefined);
        }, SNAPSHOT_TIMEOUT_MS);
        pendingRequests.set(requestId, (snapshot) => {
          window.clearTimeout(timeout);
          resolve(snapshot);
        });
        window.postMessage(
          {
            channel: PAGE_BRIDGE_CHANNEL,
            version: PAGE_BRIDGE_VERSION,
            direction: "content-to-page",
            requestId,
            kind: "snapshot.request",
          },
          window.location.origin,
        );
      });
    }
  },
});

function parseUntrustedPageMessage(value: unknown) {
  const parsed = (() => {
    try {
      return parsePageBridgeResponse(value);
    } catch {
      return undefined;
    }
  })();
  return parsed;
}

function createRequestId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
