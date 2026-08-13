import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Locale = "es" | "en";

const messages = {
  es: {
    appName: "MediaFetch",
    tagline: "Tus medios, bajo tu control",
    popupIntro: "Detecta medios disponibles en la pestaña actual.",
    currentTab: "Pestaña actual",
    unsupportedTab: "Esta página no se puede analizar.",
    scan: "Escanear página",
    scanning: "Analizando…",
    candidates: "Candidatos",
    noCandidates: "Todavía no hay candidatos",
    noCandidatesHint: "Escanea una página con audio o vídeo para empezar.",
    openDashboard: "Abrir panel",
    backgroundUnavailable:
      "El servicio de la extensión no está disponible. La interfaz seguirá operativa y podrás volver a intentarlo.",
    scanUnavailable:
      "No se pudo contactar con el detector de esta página. Comprueba que la extensión tiene acceso y recarga la pestaña.",
    addToQueue: "Añadir a la cola",
    queued: "Añadido",
    audio: "Audio",
    video: "Vídeo",
    unknownTitle: "Medio sin título",
    dashboard: "Panel",
    capture: "Capturar",
    queue: "Cola",
    history: "Historial",
    settings: "Ajustes",
    sourceUrl: "URL del medio o de la página",
    sourceUrlHint: "Pega una URL http(s) autorizada",
    inspectUrl: "Buscar medios",
    importFile: "Importar TXT o CSV",
    importHelp:
      "Una URL por línea o en la primera columna. Máximo según tu límite de lote.",
    importedUrls: "{count} URL importadas",
    invalidUrl: "Introduce una URL http(s) válida.",
    batchLimitReached: "Se aplicó el límite de {count} elementos por lote.",
    collectionConfirmTitle: "Confirmar colección",
    collectionConfirmDescription:
      "Se encontraron {count} elementos visibles. ¿Quieres analizarlos ahora?",
    collectionConfirmAction: "Analizar {count}",
    collectionEmpty:
      "No se encontraron enlaces visibles compatibles en esta colección.",
    collectionUnavailable:
      "No se pudo cargar o expandir la colección dentro del tiempo permitido.",
    collectionTruncated:
      "Resultado truncado: se usarán los primeros {count} elementos según tu límite de lote.",
    selectAll: "Seleccionar todo",
    clearSelection: "Limpiar selección",
    selectedCount: "{count} seleccionados",
    enqueueSelected: "Añadir selección",
    format: "Formato",
    quality: "Calidad",
    qualityBest: "Mejor disponible",
    qualityBalanced: "Equilibrada",
    qualitySmall: "Archivo pequeño",
    tracks: "Pistas",
    noTracks: "Selección automática",
    duration: "Duración",
    size: "Tamaño",
    status: "Estado",
    progress: "Progreso",
    pause: "Pausar",
    resume: "Reanudar",
    cancel: "Cancelar",
    retry: "Reintentar",
    pauseNote:
      "Los trabajos pausados permanecen en la cola y pueden reanudarse cuando quieras.",
    emptyQueue: "La cola está vacía",
    emptyQueueHint: "Los elementos que añadas aparecerán aquí con su progreso.",
    emptyHistory: "Aún no hay actividad terminada.",
    attempts: "Intentos",
    defaultFormat: "Formato predeterminado",
    filenameTemplate: "Plantilla de nombre",
    concurrency: "Descargas simultáneas",
    batchLimit: "Límite de lote",
    batchLimitLocal:
      "Se guarda solo en esta interfaz hasta que exista un contrato de lote.",
    saveSettings: "Guardar ajustes",
    settingsSaved: "Ajustes guardados",
    experimentalTitle: "Adaptadores experimentales",
    experimentalDescription:
      "Pueden acceder a fuentes menos estables y fallar sin previo aviso. Actívalos solo para medios que estés autorizado a descargar.",
    consentLabel:
      "Acepto explícitamente usar adaptadores experimentales bajo mi responsabilidad.",
    consentRequired: "Debes marcar el consentimiento explícito.",
    legalTitle: "Uso responsable",
    legalNotice:
      "Descarga únicamente contenido propio, de dominio público o para el que tengas permiso. MediaFetch no elimina protecciones ni concede derechos sobre el contenido.",
    language: "Idioma",
    browserLanguage: "Según el navegador",
    spanish: "Español",
    english: "English",
    connected: "Servicio conectado",
    disconnected: "Modo sin servicio",
    refresh: "Actualizar",
    loading: "Cargando…",
    genericError: "No se pudo completar la acción.",
    ackRejected: "El servicio rechazó la solicitud.",
    completed: "Completado",
    failed: "Falló",
    cancelled: "Cancelado",
    paused: "Pausado",
    processing: "Procesando",
    downloading: "Descargando",
    resolving: "Preparando",
    finalizing: "Finalizando",
    waiting: "En espera",
    filenameExample: "Ejemplo: {title}-{date}",
  },
  en: {
    appName: "MediaFetch",
    tagline: "Your media, under your control",
    popupIntro: "Detect available media in the current tab.",
    currentTab: "Current tab",
    unsupportedTab: "This page cannot be scanned.",
    scan: "Scan page",
    scanning: "Scanning…",
    candidates: "Candidates",
    noCandidates: "No candidates yet",
    noCandidatesHint: "Scan a page containing audio or video to get started.",
    openDashboard: "Open dashboard",
    backgroundUnavailable:
      "The extension service is unavailable. The interface will remain usable and you can try again.",
    scanUnavailable:
      "The detector for this page could not be reached. Check extension access and reload the tab.",
    addToQueue: "Add to queue",
    queued: "Added",
    audio: "Audio",
    video: "Video",
    unknownTitle: "Untitled media",
    dashboard: "Dashboard",
    capture: "Capture",
    queue: "Queue",
    history: "History",
    settings: "Settings",
    sourceUrl: "Media or page URL",
    sourceUrlHint: "Paste an authorized http(s) URL",
    inspectUrl: "Find media",
    importFile: "Import TXT or CSV",
    importHelp:
      "One URL per line or in the first column. Capped by your batch limit.",
    importedUrls: "{count} URLs imported",
    invalidUrl: "Enter a valid http(s) URL.",
    batchLimitReached: "The {count}-item batch limit was applied.",
    collectionConfirmTitle: "Confirm collection",
    collectionConfirmDescription:
      "{count} visible items were found. Do you want to scan them now?",
    collectionConfirmAction: "Scan {count}",
    collectionEmpty:
      "No compatible visible links were found in this collection.",
    collectionUnavailable:
      "The collection could not be loaded or expanded within the allowed time.",
    collectionTruncated:
      "Truncated result: the first {count} items will be used according to your batch limit.",
    selectAll: "Select all",
    clearSelection: "Clear selection",
    selectedCount: "{count} selected",
    enqueueSelected: "Add selection",
    format: "Format",
    quality: "Quality",
    qualityBest: "Best available",
    qualityBalanced: "Balanced",
    qualitySmall: "Small file",
    tracks: "Tracks",
    noTracks: "Automatic selection",
    duration: "Duration",
    size: "Size",
    status: "Status",
    progress: "Progress",
    pause: "Pause",
    resume: "Resume",
    cancel: "Cancel",
    retry: "Retry",
    pauseNote: "Paused jobs stay in the queue until you resume them.",
    emptyQueue: "The queue is empty",
    emptyQueueHint: "Items you add will appear here with live progress.",
    emptyHistory: "There is no completed activity yet.",
    attempts: "Attempts",
    defaultFormat: "Default format",
    filenameTemplate: "Filename template",
    concurrency: "Concurrent downloads",
    batchLimit: "Batch limit",
    batchLimitLocal:
      "Stored only in this interface until a batch contract exists.",
    saveSettings: "Save settings",
    settingsSaved: "Settings saved",
    experimentalTitle: "Experimental adapters",
    experimentalDescription:
      "They may access less stable sources and fail without notice. Enable them only for media you are authorized to download.",
    consentLabel:
      "I explicitly agree to use experimental adapters at my own risk.",
    consentRequired: "Explicit consent must be checked.",
    legalTitle: "Responsible use",
    legalNotice:
      "Only download your own content, public-domain content, or content you have permission to use. MediaFetch does not bypass protections or grant rights to content.",
    language: "Language",
    browserLanguage: "Browser default",
    spanish: "Español",
    english: "English",
    connected: "Service connected",
    disconnected: "Offline service mode",
    refresh: "Refresh",
    loading: "Loading…",
    genericError: "The action could not be completed.",
    ackRejected: "The service rejected the request.",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    paused: "Paused",
    processing: "Processing",
    downloading: "Downloading",
    resolving: "Preparing",
    finalizing: "Finalizing",
    waiting: "Waiting",
    filenameExample: "Example: {title}-{date}",
  },
} as const;

export type MessageKey = keyof (typeof messages)["es"];
type LocalePreference = Locale | "auto";

interface I18nValue {
  locale: Locale;
  preference: LocalePreference;
  setPreference: (value: LocalePreference) => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}

const STORAGE_KEY = "mediafetch.locale";
const I18nContext = createContext<I18nValue | null>(null);

export function detectBrowserLocale(language = navigator.language): Locale {
  return language.toLowerCase().startsWith("es") ? "es" : "en";
}

function readPreference(): LocalePreference {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "es" || value === "en" ? value : "auto";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] =
    useState<LocalePreference>(readPreference);
  const locale = preference === "auto" ? detectBrowserLocale() : preference;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setPreference = useCallback((value: LocalePreference) => {
    setPreferenceState(value);
    if (value === "auto") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  }, []);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      preference,
      setPreference,
      t: (key, values) => {
        let text: string = messages[locale][key];
        for (const [name, replacement] of Object.entries(values ?? {})) {
          text = text.replaceAll(`{${name}}`, String(replacement));
        }
        return text;
      },
    }),
    [locale, preference, setPreference],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null)
    throw new Error("useI18n must be used inside I18nProvider");
  return value;
}

export function LanguageSelect({ compact = false }: { compact?: boolean }) {
  const { preference, setPreference, t } = useI18n();
  return (
    <label
      className={compact ? "language-select is-compact" : "language-select"}
    >
      {!compact && <span>{t("language")}</span>}
      <select
        aria-label={t("language")}
        value={preference}
        onChange={(event) =>
          setPreference(event.target.value as LocalePreference)
        }
      >
        <option value="auto">{t("browserLanguage")}</option>
        <option value="es">{t("spanish")}</option>
        <option value="en">{t("english")}</option>
      </select>
    </label>
  );
}
