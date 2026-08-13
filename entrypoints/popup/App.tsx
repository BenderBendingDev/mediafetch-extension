import { useEffect, useState } from "react";
import { ArrowRight, ExternalLink, Globe2, Plus, Radar } from "lucide-react";
import type { MediaCandidate } from "../../src/domain/schemas";
import { LanguageSelect, useI18n } from "../../src/i18n";
import {
  Brand,
  CandidateIdentity,
  EmptyState,
  Notice,
  ServiceState,
  Spinner,
} from "../../src/ui/components";
import {
  enqueueCandidate,
  getActiveTab,
  getQueueSnapshot,
  isScannableUrl,
  openDashboard,
  scanTab,
  type ActiveTab,
} from "../../src/ui/extension-client";
import "./App.css";

export default function App() {
  const { t } = useI18n();
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [candidates, setCandidates] = useState<readonly MediaCandidate[]>([]);
  const [queued, setQueued] = useState<Set<string>>(() => new Set());
  const [scanning, setScanning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getActiveTab()
      .then(setTab)
      .catch(() => setTab(null));
    void getQueueSnapshot("popup")
      .then(() => setConnected(true))
      .catch(() => setConnected(false));
  }, []);

  const canScan = tab !== null && isScannableUrl(tab.url);

  async function handleScan() {
    if (!canScan || tab === null) return;
    setScanning(true);
    setError(null);
    try {
      setCandidates(await scanTab("popup", tab.id, tab.url));
    } catch {
      setCandidates([]);
      setError(t("scanUnavailable"));
    } finally {
      setScanning(false);
    }
  }

  async function handleEnqueue(candidate: MediaCandidate) {
    setError(null);
    try {
      await enqueueCandidate("popup", candidate, {
        format: "original",
        filenameTemplate: "{title}",
        selectedTrackIds: [],
      });
      setConnected(true);
      setQueued((current) => new Set(current).add(candidate.id));
    } catch {
      setConnected(false);
      setError(t("backgroundUnavailable"));
    }
  }

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <Brand compact />
        <div className="popup-header-actions">
          <ServiceState connected={connected} compact />
          <LanguageSelect compact />
        </div>
      </header>

      <section className="popup-hero">
        <div>
          <span className="eyebrow">{t("currentTab")}</span>
          <h1>{t("popupIntro")}</h1>
        </div>
        <div className="tab-card">
          <span className="tab-icon">
            <Globe2 size={19} />
          </span>
          <span className="tab-copy">
            <strong>{tab?.title ?? t("loading")}</strong>
            <small>
              {tab && isScannableUrl(tab.url)
                ? new URL(tab.url).hostname
                : t("unsupportedTab")}
            </small>
          </span>
        </div>
        <button
          className="btn popup-scan"
          type="button"
          disabled={!canScan || scanning}
          onClick={() => void handleScan()}
        >
          {scanning ? <Spinner label={t("scanning")} /> : <Radar size={17} />}
          {scanning ? t("scanning") : t("scan")}
        </button>
      </section>

      {error && <Notice tone="warning">{error}</Notice>}

      <section className="popup-results" aria-live="polite">
        <div className="section-heading">
          <h2>{t("candidates")}</h2>
          {candidates.length > 0 && <span>{candidates.length}</span>}
        </div>
        {candidates.length === 0 ? (
          <EmptyState
            icon={Radar}
            title={t("noCandidates")}
            detail={t("noCandidatesHint")}
          />
        ) : (
          <div className="popup-candidate-list">
            {candidates.map((candidate) => {
              const isQueued = queued.has(candidate.id);
              return (
                <article className="popup-candidate" key={candidate.id}>
                  <CandidateIdentity candidate={candidate} dense />
                  <button
                    className="icon-button"
                    type="button"
                    disabled={isQueued}
                    aria-label={isQueued ? t("queued") : t("addToQueue")}
                    title={isQueued ? t("queued") : t("addToQueue")}
                    onClick={() => void handleEnqueue(candidate)}
                  >
                    {isQueued ? <ArrowRight size={17} /> : <Plus size={17} />}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <footer className="popup-footer">
        <button
          className="dashboard-link"
          type="button"
          onClick={() => void openDashboard()}
        >
          <span>
            <strong>{t("openDashboard")}</strong>
            <small>
              {t("queue")} · {t("history")} · {t("settings")}
            </small>
          </span>
          <ExternalLink size={17} />
        </button>
      </footer>
    </main>
  );
}
