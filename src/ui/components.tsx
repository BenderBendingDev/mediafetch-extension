import {
  AudioLines,
  CircleAlert,
  CircleCheck,
  Film,
  Inbox,
  LoaderCircle,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type { JobStatus, MediaCandidate } from "../domain/schemas";
import { useI18n, type MessageKey } from "../i18n";
import { formatBytes, formatDuration } from "./utils";

export function Brand({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <div className={compact ? "brand is-compact" : "brand"}>
      <span className="brand-mark" aria-hidden="true">
        <AudioLines size={compact ? 18 : 22} strokeWidth={2.4} />
      </span>
      <span className="brand-copy">
        <strong>{t("appName")}</strong>
        {!compact && <small>{t("tagline")}</small>}
      </span>
    </div>
  );
}

export function ServiceState({
  connected,
  compact = false,
}: {
  connected: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const Icon = connected ? Wifi : WifiOff;
  return (
    <span
      className={`service-state ${connected ? "is-connected" : "is-offline"} ${compact ? "is-compact" : ""}`}
      title={connected ? t("connected") : t("backgroundUnavailable")}
    >
      <Icon size={14} />
      {!compact && (
        <span>{connected ? t("connected") : t("disconnected")}</span>
      )}
    </span>
  );
}

export function Notice({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  tone?: "info" | "warning" | "success";
}) {
  const Icon = tone === "success" ? CircleCheck : CircleAlert;
  return (
    <div
      className={`notice is-${tone}`}
      role={tone === "warning" ? "alert" : "status"}
    >
      <Icon size={18} />
      <span>{children}</span>
    </div>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  detail,
}: {
  icon?: LucideIcon;
  title: string;
  detail?: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={24} />
      </span>
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return <LoaderCircle className="spin" size={18} aria-label={label} />;
}

export function CandidateIdentity({
  candidate,
  dense = false,
}: {
  candidate: MediaCandidate;
  dense?: boolean;
}) {
  const { t } = useI18n();
  const Icon = candidate.kind === "audio" ? AudioLines : Film;
  return (
    <div
      className={dense ? "candidate-identity is-dense" : "candidate-identity"}
    >
      <span className={`media-kind kind-${candidate.kind}`}>
        <Icon size={dense ? 16 : 20} />
      </span>
      <span className="candidate-copy">
        <strong title={candidate.title}>
          {candidate.title ?? t("unknownTitle")}
        </strong>
        <small>
          {t(candidate.kind)} · {formatDuration(candidate.durationMs)} ·{" "}
          {formatBytes(candidate.contentLength)}
        </small>
      </span>
    </div>
  );
}

const statusTranslation: Record<JobStatus, MessageKey> = {
  queued: "waiting",
  paused: "paused",
  resolving: "resolving",
  downloading: "downloading",
  processing: "processing",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const { t } = useI18n();
  return (
    <span className={`status-badge status-${status}`}>
      {t(statusTranslation[status])}
    </span>
  );
}
