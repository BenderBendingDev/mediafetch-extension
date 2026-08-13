import type { Page } from "@playwright/test";
import { expect, test } from "./extension-fixture";

const fixtureOrigin = "http://127.0.0.1:4173";

test("abre el dashboard de forma persistente en español e inglés", async ({
  dashboard,
}) => {
  const language = dashboard.locator(".language-select select");

  await language.selectOption("es");
  await dashboard.reload();
  await expect(dashboard.locator("html")).toHaveAttribute("lang", "es");
  await expect(dashboard.locator(".topbar h1")).toHaveText("Capturar");

  await language.selectOption("en");
  await dashboard.reload();
  await expect(dashboard.locator("html")).toHaveAttribute("lang", "en");
  await expect(dashboard.locator(".topbar h1")).toHaveText("Capture");
});

test("detecta audio y vídeo en una página sintética local", async ({
  dashboard,
}) => {
  const audio = await scanFixture(
    dashboard,
    "/av-fixture",
    "Detected synthetic audio",
  );
  const video = dashboard
    .locator(".candidate-card")
    .filter({ hasText: "Detected synthetic video" });

  await expect(audio).toContainText(/Audio/);
  await expect(video).toBeVisible();
  await expect(video).toContainText(/Video|Vídeo/);
});

test("analiza una página local y conserva la descarga en el historial", async ({
  dashboard,
}) => {
  const candidate = await scanFixture(
    dashboard,
    "/slow-fixture",
    "Slow synthetic tone",
  );
  await enqueueCandidate(dashboard, candidate);

  const queued = dashboard
    .locator(".job-card")
    .filter({ hasText: "Slow synthetic tone" });
  await expect(queued).toBeVisible();
  const persisted = (await queueJobs(dashboard)).find(
    (item) => item.title === "Slow synthetic tone",
  );
  expect(persisted?.status).toMatch(/queued|resolving|downloading/);

  const history = await openHistory(dashboard);
  const row = history
    .locator(".history-row")
    .filter({ hasText: "Slow synthetic tone" });
  await expect(row).toContainText("ORIGINAL", { timeout: 30_000 });
  await expect(row).toContainText(/Completed|Completado/);
});

test("rechaza un fixture HLS cifrado sin descargar su clave", async ({
  dashboard,
}) => {
  const candidate = await scanFixture(
    dashboard,
    "/encrypted-fixture",
    "Encrypted synthetic stream",
  );
  await enqueueCandidate(dashboard, candidate);

  const history = await openHistory(dashboard);
  const row = history
    .locator(".history-row")
    .filter({ hasText: "Encrypted synthetic stream" });
  await expect(row).toContainText(/Failed|Falló/, { timeout: 30_000 });

  const archived = (await historyJobs(dashboard)).find(
    (item) => item.title === "Encrypted synthetic stream",
  );
  expect(archived?.state).toMatchObject({
    status: "failed",
    error: {
      code: "drm_protected",
      message: expect.stringMatching(/cifrada|DRM/),
      retryable: false,
    },
  });
});

test("pausa y reanuda una descarga directa persistente", async ({
  dashboard,
}) => {
  const candidate = await scanFixture(
    dashboard,
    "/slow-fixture",
    "Slow synthetic tone",
  );
  await enqueueCandidate(dashboard, candidate);

  const job = dashboard
    .locator(".job-card")
    .filter({ hasText: "Slow synthetic tone" });
  await expect(job).toBeVisible();
  await job.getByRole("button", { name: /^(Pause|Pausar)$/ }).click();
  await expect(job).toContainText(/Paused|Pausado/);
  await job.getByRole("button", { name: /^(Resume|Reanudar)$/ }).click();

  const history = await openHistory(dashboard);
  const row = history
    .locator(".history-row")
    .filter({ hasText: "Slow synthetic tone" });
  await expect(row).toContainText("ORIGINAL", { timeout: 30_000 });
  await expect(row).toContainText(/Completed|Completado/);
});

test("convierte un WAV sintético a MP3 con FFmpeg WASM", async ({
  dashboard,
}) => {
  const candidate = await scanFixture(dashboard, "/fixture", "Synthetic tone");
  await candidate.locator("select").nth(1).selectOption("mp3");
  await enqueueCandidate(dashboard, candidate);

  const history = await openHistory(dashboard);
  const row = history
    .locator(".history-row")
    .filter({ hasText: "Synthetic tone" });
  await expect(row).toContainText("MP3", { timeout: 60_000 });

  const archived = (await historyJobs(dashboard)).find(
    (item) => item.title === "Synthetic tone",
  );
  expect(archived).toMatchObject({
    state: {
      status: "completed",
      output: {
        format: "mp3",
        downloadId: expect.any(Number),
      },
    },
  });
  expect(archived!.state.output!.size).toBeGreaterThan(100);
  await expect(row).toContainText(/Completed|Completado/);
});

test("remuxa pistas WebM MediaRecorder mediante DASH SegmentList", async ({
  dashboard,
  extensionContext,
}) => {
  const producer = await extensionContext.newPage();
  await producer.goto(`${fixtureOrigin}/fixture`);
  const recording = await produceMediaRecorderFixtures(producer);
  await producer.close();
  test.skip(!recording.supported, recording.reason);

  const candidate = await scanFixture(
    dashboard,
    "/dash-fixture",
    "Synthetic DASH recording",
  );
  await candidate.locator("select").nth(1).selectOption("webm");
  await enqueueCandidate(dashboard, candidate);

  const history = await openHistory(dashboard);
  const row = history
    .locator(".history-row")
    .filter({ hasText: "Synthetic DASH recording" });
  await expect(row).toContainText("WEBM", { timeout: 60_000 });
  await expect(row).toContainText(/Completed|Completado/);
});

async function scanFixture(dashboard: Page, pathname: string, title: string) {
  await dashboard.locator(".url-row input").fill(`${fixtureOrigin}${pathname}`);
  await dashboard.locator(".url-row button").click();
  const candidate = dashboard.locator(".candidate-card").filter({
    hasText: title,
  });
  await expect(candidate).toBeVisible();
  return candidate;
}

async function enqueueCandidate(
  dashboard: Page,
  candidate: ReturnType<Page["locator"]>,
) {
  await expect(candidate.locator('input[type="checkbox"]')).toBeChecked();
  await dashboard.locator(".panel-footer button").click();
  await expect(dashboard.locator(".queue-panel")).toBeVisible();
}

async function openHistory(dashboard: Page) {
  await dashboard
    .locator(".sidebar")
    .getByRole("button", { name: /^(History|Historial)$/ })
    .click();
  const history = dashboard.locator(".history-panel");
  await expect(history).toBeVisible();
  return history;
}

interface OutputArtifact {
  filename: string;
  format: string;
  size: number;
  downloadId: number;
}

interface ArchivedJob {
  title?: string;
  state: {
    status: string;
    output?: OutputArtifact;
    error?: {
      code: string;
      message: string;
      retryable: boolean;
    };
  };
}

async function historyJobs(page: Page): Promise<ArchivedJob[]> {
  return page.evaluate(
    () =>
      new Promise<ArchivedJob[]>((resolve, reject) => {
        interface StoredHistory {
          job: {
            candidate: { title?: string };
            state: ArchivedJob["state"];
          };
        }
        const open = indexedDB.open("mediafetch");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result;
          const request = database
            .transaction("history", "readonly")
            .objectStore("history")
            .getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const records = request.result as StoredHistory[];
            resolve(
              records.map((record) => ({
                ...(record.job.candidate.title === undefined
                  ? {}
                  : { title: record.job.candidate.title }),
                state: record.job.state,
              })),
            );
            database.close();
          };
        };
      }),
  );
}

async function queueJobs(
  page: Page,
): Promise<Array<{ title?: string; status: string }>> {
  return page.evaluate(
    () =>
      new Promise<Array<{ title?: string; status: string }>>(
        (resolve, reject) => {
          interface StoredQueueJob {
            candidate: { title?: string };
            state: { status: string };
          }
          const open = indexedDB.open("mediafetch");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const database = open.result;
            const request = database
              .transaction("queue", "readonly")
              .objectStore("queue")
              .getAll();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const records = request.result as StoredQueueJob[];
              resolve(
                records.map((record) => ({
                  ...(record.candidate.title === undefined
                    ? {}
                    : { title: record.candidate.title }),
                  status: record.state.status,
                })),
              );
              database.close();
            };
          };
        },
      ),
  );
}

interface RecordingResult {
  supported: boolean;
  reason?: string;
}

async function produceMediaRecorderFixtures(
  page: Page,
): Promise<RecordingResult> {
  return page.evaluate(async () => {
    if (
      typeof MediaRecorder === "undefined" ||
      !MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ||
      !MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ) {
      return {
        supported: false,
        reason: "Chromium headless no admite MediaRecorder WebM VP8/Opus.",
      };
    }

    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const canvasContext = canvas.getContext("2d");
    if (canvasContext === null || typeof canvas.captureStream !== "function") {
      return {
        supported: false,
        reason: "Chromium headless no admite captureStream en canvas.",
      };
    }

    const audioContext = new AudioContext();
    await audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();

    const videoStream = canvas.captureStream(12);
    const videoRecorder = new MediaRecorder(videoStream, {
      mimeType: "video/webm;codecs=vp8",
    });
    const audioRecorder = new MediaRecorder(destination.stream, {
      mimeType: "audio/webm;codecs=opus",
    });
    const videoChunks: Blob[] = [];
    const audioChunks: Blob[] = [];
    videoRecorder.ondataavailable = (event) => videoChunks.push(event.data);
    audioRecorder.ondataavailable = (event) => audioChunks.push(event.data);

    let frame = 0;
    const painter = window.setInterval(() => {
      canvasContext.fillStyle = frame % 2 === 0 ? "#0a84ff" : "#ff9f0a";
      canvasContext.fillRect(0, 0, canvas.width, canvas.height);
      frame += 1;
    }, 50);
    videoRecorder.start(100);
    audioRecorder.start(100);
    await new Promise((resolve) => window.setTimeout(resolve, 1_200));

    const stopped = Promise.all([
      new Promise<void>((resolve) => {
        videoRecorder.onstop = () => resolve();
      }),
      new Promise<void>((resolve) => {
        audioRecorder.onstop = () => resolve();
      }),
    ]);
    videoRecorder.stop();
    audioRecorder.stop();
    await stopped;
    window.clearInterval(painter);
    oscillator.stop();
    for (const track of videoStream.getTracks()) track.stop();
    for (const track of destination.stream.getTracks()) track.stop();
    await audioContext.close();

    const video = new Blob(videoChunks, { type: "video/webm" });
    const audio = new Blob(audioChunks, { type: "audio/webm" });
    if (video.size < 100 || audio.size < 100) {
      return {
        supported: false,
        reason: "MediaRecorder no produjo pistas utilizables en headless.",
      };
    }
    const responses = await Promise.all([
      fetch("/recordings/video.webm", { method: "POST", body: video }),
      fetch("/recordings/audio.webm", { method: "POST", body: audio }),
    ]);
    if (responses.some((response) => !response.ok)) {
      throw new Error("No se pudieron publicar las pistas MediaRecorder.");
    }
    return { supported: true };
  });
}
