import {
  PAGE_BRIDGE_CHANNEL,
  PAGE_BRIDGE_VERSION,
  PageBridgeRequestSchema,
  collectPageSnapshot,
} from "../src/adapters";

export default defineContentScript({
  matches: ["<all_urls>"],
  world: "MAIN",
  main() {
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (event.source !== window || event.origin !== window.location.origin) {
        return;
      }
      const request = PageBridgeRequestSchema.safeParse(event.data);
      if (!request.success) {
        return;
      }

      const snapshot = collectPageSnapshot(
        document,
        performance.getEntriesByType("resource").map((entry) => ({
          name: entry.name,
          ...("initiatorType" in entry &&
          typeof entry.initiatorType === "string"
            ? { initiatorType: entry.initiatorType }
            : {}),
        })),
      );
      window.postMessage(
        {
          channel: PAGE_BRIDGE_CHANNEL,
          version: PAGE_BRIDGE_VERSION,
          direction: "page-to-content",
          requestId: request.data.requestId,
          kind: "snapshot.result",
          payload: snapshot,
        },
        window.location.origin,
      );
    });
  },
});
