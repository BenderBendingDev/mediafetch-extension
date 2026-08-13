import { useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Check,
  ChevronRight,
  Clock3,
  Download,
  FileUp,
  History,
  ListChecks,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import type { LayoutDashboard } from "lucide-react";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ContainerFormat,
  type MediaCandidate,
  type MediaJob,
} from "../../src/domain/schemas";
import { LanguageSelect, useI18n } from "../../src/i18n";
import {
  Brand,
  CandidateIdentity,
  EmptyState,
  Notice,
  ServiceState,
  Spinner,
  StatusBadge,
} from "../../src/ui/components";
import {
  cancelJob,
  enqueueCandidate,
  expandCollectionUrl,
  getActiveTab,
  getQueueSnapshot,
  getSettings,
  pauseJob,
  retryJob,
  scanUrls as scanPageUrls,
  setExperimentalConsent,
  subscribeToMessages,
  updateSettings,
  type ActiveTab,
  type QueueSnapshot,
} from "../../src/ui/extension-client";
import {
  availableFormats,
  classifyMediaUrl,
  formatDuration,
  isHttpUrl,
  parseUrlImport,
  tracksForQuality,
  type QualityPreference,
} from "../../src/ui/utils";
import "./style.css";

type View = "capture" | "queue" | "history" | "settings";

interface CandidateOptions {
  selected: boolean;
  format: ContainerFormat;
  quality: QualityPreference;
  selectedTrackIds: string[];
}

interface PendingCollection {
  url: string;
  urls: readonly string[];
  truncated: boolean;
}

const EMPTY_SNAPSHOT: QueueSnapshot = { jobs: [], history: [] };
const BATCH_LIMIT_KEY = "mediafetch.ui.batchLimit";

function initialBatchLimit(): number {
  const stored = Number(localStorage.getItem(BATCH_LIMIT_KEY));
  return Number.isInteger(stored) && stored >= 1 && stored <= 500 ? stored : 25;
}

function initialOptions(
  candidate: MediaCandidate,
  format: ContainerFormat,
): CandidateOptions {
  const formats = availableFormats(candidate);
  return {
    selected: true,
    format: formats.includes(format) ? format : formats[0]!,
    quality: "best",
    selectedTrackIds: tracksForQuality(candidate, "best"),
  };
}

function mergeCandidates(
  current: readonly MediaCandidate[],
  incoming: readonly MediaCandidate[],
): MediaCandidate[] {
  const byId = new Map(current.map((candidate) => [candidate.id, candidate]));
  for (const candidate of incoming) byId.set(candidate.id, candidate);
  return [...byId.values()];
}

export default function App() {
  const { locale, t } = useI18n();
  const [view, setView] = useState<View>("capture");
  const [activeTab, setActiveTab] = useState<ActiveTab | null>(null);
  const [url, setUrl] = useState("");
  const [candidates, setCandidates] = useState<readonly MediaCandidate[]>([]);
  const [candidateOptions, setCandidateOptions] = useState<
    Record<string, CandidateOptions>
  >({});
  const [snapshot, setSnapshot] = useState<QueueSnapshot>(EMPTY_SNAPSHOT);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [batchLimit, setBatchLimit] = useState(initialBatchLimit);
  const [pausedJobs, setPausedJobs] = useState<Set<string>>(() => new Set());
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingCollection, setPendingCollection] =
    useState<PendingCollection | null>(null);
  const [collectionResult, setCollectionResult] = useState<{
    count: number;
    truncated: boolean;
  } | null>(null);
  const [notice, setNotice] = useState<{
    tone: "warning" | "success";
    text: string;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void getActiveTab()
      .then((tab) => {
        setActiveTab(tab);
        if (tab && isHttpUrl(tab.url)) setUrl(tab.url);
      })
      .catch(() => setActiveTab(null));

    void refreshSnapshot();
    void getSettings()
      .then((value) => {
        setSettings(value);
        setConnected(true);
      })
      .catch(() => setConnected(false));

    return subscribeToMessages((envelope) => {
      if (envelope.message.kind === "queue.snapshot") {
        setSnapshot(envelope.message.payload);
        setConnected(true);
      } else if (envelope.message.kind === "job.progress") {
        const { jobId, progress } = envelope.message.payload;
        setSnapshot((current) => ({
          ...current,
          jobs: current.jobs.map((job) =>
            job.id === jobId
              ? { ...job, progress, updatedAt: progress.updatedAt }
              : job,
          ),
        }));
      } else if (
        envelope.message.kind === "job.completed" ||
        envelope.message.kind === "job.failed"
      ) {
        void refreshSnapshot();
      }
    });
  }, []);

  const selectedCount = useMemo(
    () =>
      candidates.filter((candidate) => candidateOptions[candidate.id]?.selected)
        .length,
    [candidateOptions, candidates],
  );

  async function refreshSnapshot() {
    try {
      setSnapshot(await getQueueSnapshot("dashboard"));
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }

  function ingestCandidates(incoming: readonly MediaCandidate[]) {
    setCandidates((current) => mergeCandidates(current, incoming));
    setCandidateOptions((current) => {
      const next = { ...current };
      for (const candidate of incoming) {
        next[candidate.id] ??= initialOptions(
          candidate,
          settings.defaultFormat,
        );
      }
      return next;
    });
  }

  async function scanUrls(urls: readonly string[]) {
    setBusy(true);
    setNotice(null);
    try {
      const discovered = [
        ...(await scanPageUrls("dashboard", urls, activeTab)),
      ];
      ingestCandidates(discovered);
      if (discovered.length === 0) {
        setNotice({ tone: "warning", text: t("noCandidatesHint") });
      }
    } catch {
      setNotice({ tone: "warning", text: t("scanUnavailable") });
    } finally {
      setBusy(false);
    }
  }

  async function handleUrlScan() {
    if (!isHttpUrl(url)) {
      setNotice({ tone: "warning", text: t("invalidUrl") });
      return;
    }
    setCollectionResult(null);
    if (classifyMediaUrl(url) === "collection") {
      setBusy(true);
      setNotice(null);
      try {
        const expansion = await expandCollectionUrl(url, {
          maxItems: batchLimit,
        });
        if (expansion.urls.length === 0) {
          setNotice({ tone: "warning", text: t("collectionEmpty") });
          return;
        }
        setPendingCollection({
          url,
          urls: expansion.urls,
          truncated: expansion.truncated,
        });
      } catch {
        setNotice({ tone: "warning", text: t("collectionUnavailable") });
      } finally {
        setBusy(false);
      }
      return;
    }
    await scanUrls([url]);
  }

  async function confirmCollectionScan() {
    if (pendingCollection === null) return;
    const collection = pendingCollection;
    setPendingCollection(null);
    setCollectionResult({
      count: collection.urls.length,
      truncated: collection.truncated,
    });
    await scanUrls(collection.urls);
  }

  async function handleFile(file: File | undefined) {
    if (file === undefined) return;
    setCollectionResult(null);
    const imported = parseUrlImport(await file.text(), batchLimit);
    if (imported.urls.length === 0) {
      setNotice({ tone: "warning", text: t("invalidUrl") });
      return;
    }
    setNotice({
      tone: "success",
      text: imported.truncated
        ? t("batchLimitReached", { count: batchLimit })
        : t("importedUrls", { count: imported.urls.length }),
    });
    await scanUrls(imported.urls);
  }

  function patchCandidate(id: string, patch: Partial<CandidateOptions>) {
    setCandidateOptions((current) => ({
      ...current,
      [id]: { ...current[id]!, ...patch },
    }));
  }

  function setAllCandidates(selected: boolean) {
    setCandidateOptions((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, options]) => [
          id,
          { ...options, selected },
        ]),
      ),
    );
  }

  async function enqueueSelected() {
    const selected = candidates.filter(
      (candidate) => candidateOptions[candidate.id]?.selected,
    );
    if (selected.length === 0) return;
    setBusy(true);
    setNotice(null);
    const batchId = `batch-${Date.now()}`;
    try {
      for (const candidate of selected.slice(0, batchLimit)) {
        const options = candidateOptions[candidate.id]!;
        await enqueueCandidate(
          "dashboard",
          candidate,
          {
            format: options.format,
            filenameTemplate: settings.filenameTemplate,
            selectedTrackIds: options.selectedTrackIds,
          },
          batchId,
        );
      }
      setConnected(true);
      setView("queue");
      await refreshSnapshot();
    } catch {
      setConnected(false);
      setNotice({ tone: "warning", text: t("backgroundUnavailable") });
    } finally {
      setBusy(false);
    }
  }

  async function handlePause(job: MediaJob) {
    try {
      await pauseJob(job.id);
      setPausedJobs((current) => new Set(current).add(job.id));
      await refreshSnapshot();
    } catch {
      setNotice({ tone: "warning", text: t("backgroundUnavailable") });
    }
  }

  async function handleResume(job: MediaJob) {
    try {
      await retryJob(job.id);
      setPausedJobs((current) => {
        const next = new Set(current);
        next.delete(job.id);
        return next;
      });
      await refreshSnapshot();
    } catch {
      setNotice({ tone: "warning", text: t("genericError") });
    }
  }

  async function handleCancel(job: MediaJob) {
    try {
      await cancelJob(job.id);
      await refreshSnapshot();
    } catch {
      setNotice({ tone: "warning", text: t("genericError") });
    }
  }

  async function handleRetry(job: MediaJob) {
    try {
      await retryJob(job.id);
      await refreshSnapshot();
    } catch {
      setNotice({ tone: "warning", text: t("genericError") });
    }
  }

  async function saveSettings() {
    localStorage.setItem(BATCH_LIMIT_KEY, String(batchLimit));
    setBusy(true);
    try {
      await updateSettings({
        defaultFormat: settings.defaultFormat,
        filenameTemplate: settings.filenameTemplate,
        concurrentJobs: settings.concurrentJobs,
        historyRetentionDays: settings.historyRetentionDays,
        retryPolicy: settings.retryPolicy,
      });
      await setExperimentalConsent({
        ...settings.experimentalConsent,
        policyVersion: "1",
        updatedAt: Date.now(),
      });
      setConnected(true);
      setNotice({ tone: "success", text: t("settingsSaved") });
    } catch {
      setConnected(false);
      setNotice({ tone: "warning", text: t("backgroundUnavailable") });
    } finally {
      setBusy(false);
    }
  }

  const navItems: {
    id: View;
    icon: typeof LayoutDashboard;
    label: string;
    count?: number;
  }[] = [
    {
      id: "capture",
      icon: Radar,
      label: t("capture"),
      count: candidates.length,
    },
    {
      id: "queue",
      icon: ListChecks,
      label: t("queue"),
      count: snapshot.jobs.length,
    },
    {
      id: "history",
      icon: History,
      label: t("history"),
      count: snapshot.history.length,
    },
    { id: "settings", icon: Settings, label: t("settings") },
  ];

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label={t("dashboard")}>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={view === item.id ? "nav-item is-active" : "nav-item"}
                type="button"
                key={item.id}
                onClick={() => setView(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {item.count !== undefined && item.count > 0 && (
                  <em>{item.count}</em>
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-legal">
          <ShieldCheck size={18} />
          <span>
            <strong>{t("legalTitle")}</strong>
            <small>{t("legalNotice")}</small>
          </span>
        </div>
      </aside>

      <main className="dashboard-main">
        <header className="topbar">
          <div>
            <span className="topbar-kicker">{t("appName")}</span>
            <h1>{navItems.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <ServiceState connected={connected} />
            <LanguageSelect />
          </div>
        </header>

        <nav className="mobile-nav" aria-label={t("dashboard")}>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={view === item.id ? "is-active" : ""}
                type="button"
                key={item.id}
                aria-label={item.label}
                onClick={() => setView(item.id)}
              >
                <Icon size={19} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
        {collectionResult?.truncated && (
          <Notice tone="warning">
            {t("collectionTruncated", { count: collectionResult.count })}
          </Notice>
        )}

        {view === "capture" && (
          <section className="view-grid capture-view">
            <article className="panel source-panel">
              <div className="panel-heading">
                <span className="panel-icon">
                  <Plus size={18} />
                </span>
                <div>
                  <h2>{t("sourceUrl")}</h2>
                  <p>{t("sourceUrlHint")}</p>
                </div>
              </div>
              <div className="url-row">
                <input
                  className="input"
                  type="url"
                  value={url}
                  placeholder="https://…"
                  aria-label={t("sourceUrl")}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleUrlScan();
                  }}
                />
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={() => void handleUrlScan()}
                >
                  {busy ? (
                    <Spinner label={t("loading")} />
                  ) : (
                    <Radar size={17} />
                  )}
                  {t("inspectUrl")}
                </button>
              </div>
              {activeTab && (
                <button
                  className="current-page"
                  type="button"
                  onClick={() => setUrl(activeTab.url)}
                >
                  <span>
                    {t("currentTab")}: <strong>{activeTab.title}</strong>
                  </span>
                  <ChevronRight size={16} />
                </button>
              )}
              <div className="import-zone">
                <FileUp size={23} />
                <div>
                  <strong>{t("importFile")}</strong>
                  <small>{t("importHelp")}</small>
                </div>
                <button
                  className="btn is-secondary is-small"
                  type="button"
                  onClick={() => fileInput.current?.click()}
                >
                  {t("importFile")}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  accept=".txt,.csv,text/plain,text/csv"
                  onChange={(event) => {
                    void handleFile(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
            </article>

            <article className="panel candidates-panel">
              <div className="panel-heading row-heading">
                <div>
                  <h2>{t("candidates")}</h2>
                  <p>{t("selectedCount", { count: selectedCount })}</p>
                </div>
                {candidates.length > 0 && (
                  <div className="heading-actions">
                    <button
                      className="btn is-ghost is-small"
                      type="button"
                      onClick={() => setAllCandidates(true)}
                    >
                      {t("selectAll")}
                    </button>
                    <button
                      className="btn is-ghost is-small"
                      type="button"
                      onClick={() => setAllCandidates(false)}
                    >
                      {t("clearSelection")}
                    </button>
                  </div>
                )}
              </div>
              {candidates.length === 0 ? (
                <EmptyState
                  icon={Radar}
                  title={t("noCandidates")}
                  detail={t("noCandidatesHint")}
                />
              ) : (
                <div className="candidate-list">
                  {candidates.map((candidate) => {
                    const options = candidateOptions[candidate.id]!;
                    return (
                      <article
                        className={
                          options.selected
                            ? "candidate-card is-selected"
                            : "candidate-card"
                        }
                        key={candidate.id}
                      >
                        <label className="candidate-select">
                          <input
                            type="checkbox"
                            checked={options.selected}
                            onChange={(event) =>
                              patchCandidate(candidate.id, {
                                selected: event.target.checked,
                              })
                            }
                          />
                          <CandidateIdentity candidate={candidate} />
                        </label>
                        <div className="candidate-controls">
                          <label className="field">
                            <span>{t("quality")}</span>
                            <select
                              className="select"
                              value={options.quality}
                              onChange={(event) => {
                                const quality = event.target
                                  .value as QualityPreference;
                                patchCandidate(candidate.id, {
                                  quality,
                                  selectedTrackIds: tracksForQuality(
                                    candidate,
                                    quality,
                                  ),
                                });
                              }}
                            >
                              <option value="best">{t("qualityBest")}</option>
                              <option value="balanced">
                                {t("qualityBalanced")}
                              </option>
                              <option value="small">{t("qualitySmall")}</option>
                            </select>
                          </label>
                          <label className="field">
                            <span>{t("format")}</span>
                            <select
                              className="select"
                              value={options.format}
                              onChange={(event) =>
                                patchCandidate(candidate.id, {
                                  format: event.target.value as ContainerFormat,
                                })
                              }
                            >
                              {availableFormats(candidate).map((format) => (
                                <option value={format} key={format}>
                                  {format.toUpperCase()}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <details className="track-picker">
                          <summary>
                            {t("tracks")} ·{" "}
                            {candidate.tracks.length || t("noTracks")}
                          </summary>
                          {candidate.tracks.map((track) => (
                            <label className="checkbox" key={track.id}>
                              <input
                                type="checkbox"
                                checked={options.selectedTrackIds.includes(
                                  track.id,
                                )}
                                onChange={(event) => {
                                  const selectedTrackIds = event.target.checked
                                    ? [...options.selectedTrackIds, track.id]
                                    : options.selectedTrackIds.filter(
                                        (id) => id !== track.id,
                                      );
                                  patchCandidate(candidate.id, {
                                    selectedTrackIds,
                                  });
                                }}
                              />
                              <span>
                                {track.label ?? track.kind} ·{" "}
                                {track.codec ?? track.container ?? "—"}
                                {track.height ? ` · ${track.height}p` : ""}
                                {track.language ? ` · ${track.language}` : ""}
                              </span>
                            </label>
                          ))}
                        </details>
                      </article>
                    );
                  })}
                </div>
              )}
              {candidates.length > 0 && (
                <div className="panel-footer">
                  <span>{t("selectedCount", { count: selectedCount })}</span>
                  <button
                    className="btn"
                    type="button"
                    disabled={selectedCount === 0 || busy}
                    onClick={() => void enqueueSelected()}
                  >
                    <Download size={17} />
                    {t("enqueueSelected")}
                  </button>
                </div>
              )}
            </article>
          </section>
        )}

        {view === "queue" && (
          <section className="panel queue-panel">
            <div className="panel-heading row-heading">
              <div>
                <h2>{t("queue")}</h2>
                <p>
                  {snapshot.jobs.length} · {t("status")}
                </p>
              </div>
              <button
                className="btn is-secondary is-small"
                type="button"
                onClick={() => void refreshSnapshot()}
              >
                <RefreshCw size={15} />
                {t("refresh")}
              </button>
            </div>
            <Notice>{t("pauseNote")}</Notice>
            {snapshot.jobs.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title={t("emptyQueue")}
                detail={t("emptyQueueHint")}
              />
            ) : (
              <div className="job-list">
                {snapshot.jobs.map((job) => {
                  const paused =
                    job.state.status === "paused" || pausedJobs.has(job.id);
                  const terminal = [
                    "completed",
                    "failed",
                    "cancelled",
                  ].includes(job.state.status);
                  const percent = job.progress.percent ?? 0;
                  return (
                    <article className="job-card" key={job.id}>
                      <div className="job-main">
                        <CandidateIdentity candidate={job.candidate} dense />
                        <StatusBadge status={job.state.status} />
                      </div>
                      <div className="progress-row">
                        <div
                          className="progress-track"
                          aria-label={`${t("progress")} ${percent}%`}
                        >
                          <span style={{ width: `${percent}%` }} />
                        </div>
                        <strong>{Math.round(percent)}%</strong>
                      </div>
                      <div className="job-meta">
                        <span>
                          <Clock3 size={13} /> {t("attempts")}: {job.attempts}/
                          {job.maxAttempts}
                        </span>
                        <span>{job.output.format.toUpperCase()}</span>
                        <span>{formatDuration(job.candidate.durationMs)}</span>
                      </div>
                      <div className="job-actions">
                        {!terminal && !paused && (
                          <button
                            className="btn is-secondary is-small"
                            type="button"
                            onClick={() => void handlePause(job)}
                          >
                            <Pause size={14} /> {t("pause")}
                          </button>
                        )}
                        {paused && (
                          <button
                            className="btn is-secondary is-small"
                            type="button"
                            onClick={() => void handleResume(job)}
                          >
                            <Play size={14} /> {t("resume")}
                          </button>
                        )}
                        {!terminal && (
                          <button
                            className="btn is-danger is-small"
                            type="button"
                            onClick={() => void handleCancel(job)}
                          >
                            <Ban size={14} /> {t("cancel")}
                          </button>
                        )}
                        {(job.state.status === "failed" ||
                          job.state.status === "cancelled") && (
                          <button
                            className="btn is-secondary is-small"
                            type="button"
                            onClick={() => void handleRetry(job)}
                          >
                            <RotateCcw size={14} /> {t("retry")}
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {view === "history" && (
          <section className="panel history-panel">
            <div className="panel-heading row-heading">
              <div>
                <h2>{t("history")}</h2>
                <p>{snapshot.history.length}</p>
              </div>
              <button
                className="btn is-secondary is-small"
                type="button"
                onClick={() => void refreshSnapshot()}
              >
                <RefreshCw size={15} /> {t("refresh")}
              </button>
            </div>
            {snapshot.history.length === 0 ? (
              <EmptyState icon={History} title={t("emptyHistory")} />
            ) : (
              <div className="history-list">
                {snapshot.history.map((entry) => (
                  <article className="history-row" key={entry.id}>
                    <CandidateIdentity candidate={entry.job.candidate} dense />
                    <StatusBadge status={entry.job.state.status} />
                    <span className="history-date">
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(entry.archivedAt)}
                    </span>
                    <span>{entry.job.output.format.toUpperCase()}</span>
                    {(entry.job.state.status === "failed" ||
                      entry.job.state.status === "cancelled") && (
                      <button
                        className="btn is-secondary is-small"
                        type="button"
                        onClick={() => void handleRetry(entry.job)}
                      >
                        <RotateCcw size={14} /> {t("retry")}
                      </button>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {view === "settings" && (
          <section className="settings-grid">
            <article className="panel settings-panel">
              <div className="panel-heading">
                <span className="panel-icon">
                  <SlidersHorizontal size={18} />
                </span>
                <div>
                  <h2>{t("settings")}</h2>
                  <p>{t("filenameExample")}</p>
                </div>
              </div>
              <div className="settings-fields">
                <label className="field">
                  <span>{t("defaultFormat")}</span>
                  <select
                    className="select"
                    value={settings.defaultFormat}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        defaultFormat: event.target.value as ContainerFormat,
                      })
                    }
                  >
                    {["original", "mp3", "m4a", "mp4", "webm", "wav"].map(
                      (format) => (
                        <option value={format} key={format}>
                          {format.toUpperCase()}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="field field-wide">
                  <span>{t("filenameTemplate")}</span>
                  <input
                    className="input"
                    value={settings.filenameTemplate}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        filenameTemplate: event.target.value,
                      })
                    }
                  />
                  <small>{t("filenameExample")}</small>
                </label>
                <label className="field">
                  <span>{t("concurrency")}</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={8}
                    value={settings.concurrentJobs}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        concurrentJobs: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>{t("batchLimit")}</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={500}
                    value={batchLimit}
                    onChange={(event) =>
                      setBatchLimit(
                        Math.min(500, Math.max(1, Number(event.target.value))),
                      )
                    }
                  />
                  <small>{t("batchLimitLocal")}</small>
                </label>
              </div>
            </article>

            <article className="panel consent-panel">
              <div className="panel-heading">
                <span className="panel-icon is-warning">
                  <ShieldCheck size={18} />
                </span>
                <div>
                  <h2>{t("experimentalTitle")}</h2>
                  <p>{t("experimentalDescription")}</p>
                </div>
              </div>
              <label className="consent-check">
                <input
                  type="checkbox"
                  checked={settings.experimentalConsent.granted}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      experimentalConsent: {
                        ...settings.experimentalConsent,
                        granted: event.target.checked,
                        policyVersion: "1",
                        updatedAt: Date.now(),
                      },
                    })
                  }
                />
                <span>
                  <strong>{t("consentLabel")}</strong>
                  <small>{t("legalNotice")}</small>
                </span>
              </label>
            </article>

            <div className="settings-actions">
              <button
                className="btn"
                type="button"
                disabled={busy || settings.filenameTemplate.trim().length === 0}
                onClick={() => void saveSettings()}
              >
                {busy ? <Spinner label={t("loading")} /> : <Check size={17} />}
                {t("saveSettings")}
              </button>
            </div>
          </section>
        )}
      </main>
      {pendingCollection && (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setPendingCollection(null);
          }}
        >
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="collection-confirm-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") setPendingCollection(null);
            }}
          >
            <div className="panel-heading">
              <span className="panel-icon">
                <ListChecks size={18} />
              </span>
              <div>
                <h2 id="collection-confirm-title">
                  {t("collectionConfirmTitle")}
                </h2>
                <p>
                  {t("collectionConfirmDescription", {
                    count: pendingCollection.urls.length,
                  })}
                </p>
              </div>
            </div>
            <div className="confirm-dialog-body">
              <span className="collection-url">{pendingCollection.url}</span>
              {pendingCollection.truncated && (
                <Notice tone="warning">
                  {t("collectionTruncated", {
                    count: pendingCollection.urls.length,
                  })}
                </Notice>
              )}
            </div>
            <div className="confirm-dialog-actions">
              <button
                className="btn is-secondary"
                type="button"
                onClick={() => setPendingCollection(null)}
              >
                {t("cancel")}
              </button>
              <button
                className="btn"
                type="button"
                onClick={() => void confirmCollectionScan()}
              >
                <Radar size={17} />
                {t("collectionConfirmAction", {
                  count: pendingCollection.urls.length,
                })}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
