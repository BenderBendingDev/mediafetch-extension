import { describe, expect, it } from "vitest";
import {
  ExtensionServiceError,
  hostPermissionPatterns,
} from "./extension-client";

describe("scan host permissions", () => {
  it("deduplicates URL origins into one permission request payload", () => {
    expect(
      hostPermissionPatterns([
        "https://example.test/one",
        "https://example.test/two?value=1",
        "http://media.example.test/file",
        "http://media.example.test:8080/other",
      ]),
    ).toEqual(["https://example.test/*", "http://media.example.test/*"]);
  });

  it("rejects non-HTTP scan targets", () => {
    expect(() => hostPermissionPatterns(["file:///tmp/media.html"])).toThrow(
      ExtensionServiceError,
    );
  });
});
