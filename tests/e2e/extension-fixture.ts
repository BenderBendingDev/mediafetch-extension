import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chromium,
  expect,
  test as base,
  type BrowserContext,
  type Page,
} from "@playwright/test";

interface ExtensionFixtures {
  extensionContext: BrowserContext;
  extensionId: string;
  dashboard: Page;
}

export const test = base.extend<ExtensionFixtures>({
  extensionContext: async ({ browserName: _browserName }, use) => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "mediafetch-playwright-"),
    );
    const extensionPath = path.join(temporaryRoot, "extension");
    const userDataDir = path.join(temporaryRoot, "profile");
    await cp(path.resolve(".output/chrome-mv3"), extensionPath, {
      recursive: true,
    });
    await preauthorizeLocalFixtures(extensionPath);

    const context = await chromium.launchPersistentContext(userDataDir, {
      acceptDownloads: true,
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    try {
      await use(context);
    } finally {
      await context.close();
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  },

  extensionId: async ({ extensionContext }, use) => {
    let [worker] = extensionContext.serviceWorkers();
    worker ??= await extensionContext.waitForEvent("serviceworker", {
      timeout: 30_000,
    });
    await use(new URL(worker.url()).hostname);
  },

  dashboard: async ({ extensionContext, extensionId }, use) => {
    const page = await extensionContext.newPage();
    await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
    await expect(page.locator(".dashboard-shell")).toBeVisible();
    await use(page);
  },
});

export { expect };

async function preauthorizeLocalFixtures(extensionPath: string): Promise<void> {
  const manifestPath = path.join(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  const current = Array.isArray(manifest["host_permissions"])
    ? manifest["host_permissions"]
    : [];
  manifest["host_permissions"] = [
    ...new Set([...current, "http://127.0.0.1/*"]),
  ];
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
}
