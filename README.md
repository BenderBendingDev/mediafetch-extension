# MediaFetch

[Español](#español) · [English](#english)

Extensión Manifest V3 para Chromium que detecta medios expuestos por una página,
organiza trabajos persistentes y descarga, reempaqueta o convierte localmente
con FFmpeg WebAssembly. Úsala únicamente con contenido propio, de dominio
público o para el que tengas permiso.

## Español

### Funciones reales

- Detecta URLs HTTP(S) en elementos `<audio>`/`<video>`/`<source>`, enlaces de
  descarga, JSON-LD y recursos visibles en la API de rendimiento de la página.
- Analiza la pestaña actual, una URL introducida, lotes TXT/CSV y colecciones
  visibles de Vimeo, YouTube y TikTok.
- Permite elegir pistas/calidad, formato, plantilla de nombre y reintentos;
  ofrece cola, pausa, reanudación, cancelación e historial.
- Descarga fuentes directas y un subconjunto explícito de HLS/DASH sin cifrar.
- Mantiene el procesamiento en el navegador. No incluye un servicio remoto ni
  elude DRM, cifrado, autenticación, controles de acceso o paywalls.

La detección depende de que la página exponga una URL utilizable. Ver un medio
reproducirse no garantiza que pueda descargarse.

### Instalación por sideload (Chrome y Brave)

Requisito: Chrome/Brave basado en Chromium 116 o posterior.

**Desde un ZIP de release**

1. Descarga `mediafetch-<versión>-chromium.zip` y verifica su SHA-256 con el
   archivo `SHA256SUMS`.
2. Extrae el ZIP en una carpeta permanente.
3. Abre `chrome://extensions` en Chrome o `brave://extensions` en Brave.
4. Activa **Modo de desarrollador**, pulsa **Cargar descomprimida** y selecciona
   la carpeta que contiene `manifest.json`.

**Desde el código fuente**

```sh
corepack enable
corepack prepare pnpm@11.21.0 --activate
pnpm install --frozen-lockfile
pnpm build
```

Carga `.output/chrome-mv3` como extensión descomprimida. Node.js 24 y pnpm
11.21.0 son las versiones soportadas para desarrollo.

### Uso

1. Abre MediaFetch y el dashboard.
2. Para la pestaña activa, usa la URL sugerida y pulsa **Inspeccionar**. Para
   otra página, pega su URL; la extensión abre una pestaña temporal en segundo
   plano, la analiza y la cierra.
3. Para TXT/CSV, usa una URL HTTP(S) por línea. En CSV se lee la primera columna
   (se aceptan coma, punto y coma o tabulador); cabecera `url`, líneas vacías,
   duplicados y entradas inválidas se omiten. El límite configurable es 1–500.
4. Las colecciones reconocidas son playlists/canales/perfiles visibles de Vimeo,
   YouTube y TikTok. MediaFetch desplaza la página de forma acotada, muestra
   cuántas URLs encontró y pide confirmación antes de analizarlas.
5. Selecciona candidatos, calidad/pistas y salida; encola el lote. La descarga
   terminada aparece en el gestor de descargas del navegador.

Las sesiones existentes del navegador se usan al cargar páginas y las descargas
envían credenciales del mismo contexto (`credentials: include`). No se piden ni
almacenan contraseñas. URLs firmadas pueden caducar; reanaliza la página y
reintenta. Cerrar/reiniciar el navegador conserva cola, ajustes e historial en
IndexedDB, pero un trabajo activo se recupera o reencola y puede tener que
volver a descargar desde cero.

### Formatos

- Audio detectado: original, MP3, M4A y WAV.
- Vídeo detectado: original, MP4, WebM o extracción de audio a MP3.
- `original` conserva bytes sin conversión en fuentes directas cuando se usan
  todas las pistas. En fuentes adaptativas puede requerir remux.
- M4A/MP4/WebM se remuxean si los códecs encajan; si no, se transcodifican. MP3
  y WAV se transcodifican. La conversión puede ser lenta y con pérdida.

### Permisos y privacidad

Permisos permanentes:

- `activeTab`: identificar la pestaña activa tras una acción del usuario.
- `scripting`: recopilar únicamente metadatos y URLs expuestos por la página.
- `downloads`: guardar el resultado mediante el navegador.
- `offscreen`: ejecutar descargas y FFmpeg fuera de la interfaz.
- `storage`: conservar idioma y preferencias ligeras.
- `alarms`: programar reintentos.

Los accesos `http://*/*` y `https://*/*` son **opcionales**: se solicitan por
origen al analizar una URL. Consulta [PRIVACY.md](PRIVACY.md). No hay cuenta,
telemetría ni servidor de MediaFetch; el navegador sí contacta las URLs que
eliges. Cola, ajustes, consentimientos, URLs y metadatos del historial se
guardan localmente hasta que se borren los datos de la extensión o venza la
retención (90 días por defecto; la interfaz actual no expone ese ajuste).

### Límites conocidos

- Cada fuente o descarga adaptativa acumulada debe ser estrictamente menor que
  2.000.000.000 bytes. Los bytes se reúnen en memoria y FFmpeg WASM mantiene
  copias adicionales: el consumo de RAM puede superar varias veces el tamaño de
  entrada. Archivos grandes pueden agotar memoria mucho antes de 2 GB.
- Manifiesto: máximo 2 MB, 20.000 líneas, 64 pistas y 4.096 segmentos
  seleccionados en total. HLS admite playlist media o una maestra de un nivel.
- No admite HLS cifrado, `BYTERANGE`, discontinuidades, LL-HLS/delta; DASH solo
  estático, un `Period`, `SegmentList` o `SegmentTemplate` acotado, sin
  `SegmentBase`, rangos, `SegmentTimeline` ni `ContentProtection`.
- CORS, URLs efímeras, cabeceras/cookies requeridas por el servidor, cambios de
  DOM, service workers y bloqueadores pueden impedir detección o descarga.
- Aunque Ajustes muestra un valor de concurrencia, el coordinador actual ejecuta
  un solo trabajo cada vez; ese valor aún no aumenta el paralelismo.

### Matriz honesta de plataformas

| Plataforma/fuente   | Estado                   | Alcance real                                                                      |
| ------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| URL directa HTTP(S) | Compatible               | Si la URL es accesible y no está cifrada                                          |
| Página web genérica | Mejor esfuerzo           | Solo medios expuestos en DOM, JSON-LD o rendimiento                               |
| HLS/DASH sin cifrar | Parcial                  | Únicamente el subconjunto indicado arriba                                         |
| Vimeo               | Mejor esfuerzo           | Vídeos/colecciones con URLs visibles; sin API privada                             |
| YouTube             | **Experimental, opt-in** | Solo URLs ya expuestas por la página; puede fallar sin aviso por cambios de sitio |
| TikTok              | **Experimental, opt-in** | Solo URLs ya expuestas por la página; puede fallar sin aviso por cambios de sitio |
| DRM/cifrado/paywall | No compatible            | Se rechaza deliberadamente                                                        |
| Firefox/Safari      | No compatible            | El artefacto actual está probado para Chromium MV3                                |

**Advertencia específica:** YouTube y TikTok están desactivados hasta aceptar el
consentimiento experimental en Ajustes. No usan APIs de descarga, no descifran
firmas, no eluden controles y no se garantiza que detecten o descarguen nada.
Respeta sus términos y los derechos aplicables.

### Licencias

El código propio de MediaFetch se distribuye bajo MIT; consulta
[LICENSE](LICENSE). El ZIP combinado **no es enteramente MIT**: incorpora
`@ffmpeg/core` 0.12.10, que declara `GPL-2.0-or-later`. El wrapper
`@ffmpeg/ffmpeg` es MIT. Los releases adjuntan el código fuente correspondiente
de ffmpeg.wasm v0.12.10. Detalles y enlace exacto en
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## English

### What it actually does

- Detects HTTP(S) media URLs exposed by `<audio>`, `<video>`, `<source>`,
  download links, JSON-LD, and the page Performance API.
- Scans the active tab, a supplied URL, TXT/CSV batches, and visible Vimeo,
  YouTube, or TikTok collections.
- Offers track/quality and format selection, filename templates, retries, a
  persistent queue, pause/resume/cancel, and history.
- Downloads direct sources and an explicit unencrypted HLS/DASH subset.
- Processes media in-browser. It has no remote service and does not bypass DRM,
  encryption, authentication, access controls, or paywalls.

Detection requires the page to expose a usable URL. Successful playback does not
guarantee that MediaFetch can download it.

### Sideload on Chrome or Brave

Chrome/Brave based on Chromium 116 or newer is required.

1. Download `mediafetch-<version>-chromium.zip` and verify it against
   `SHA256SUMS`.
2. Extract it to a permanent folder.
3. Open `chrome://extensions` or `brave://extensions`.
4. Enable **Developer mode**, choose **Load unpacked**, and select the folder
   containing `manifest.json`.

To build from source, install Node.js 24 and pnpm 11.21.0, run
`pnpm install --frozen-lockfile` and `pnpm build`, then load
`.output/chrome-mv3`.

### Use

Open the dashboard, inspect the suggested active-tab URL or paste another URL.
Other URLs are loaded serially in temporary background tabs. TXT/CSV imports
accept one HTTP(S) URL per line and read the first CSV column (comma, semicolon,
or tab); `url` headers, blanks, duplicates, and invalid entries are ignored. The
configurable batch limit is 1–500.

Recognized collections include visible Vimeo showcases/channels/profiles,
YouTube playlists/channels, and TikTok profiles. Expansion is bounded and
requires confirmation. Select candidates, quality/tracks, and output, then
enqueue them. Finished files appear in the browser download manager.

Existing browser sessions are used to load pages and source fetches include
same-context credentials. Passwords are neither requested nor stored. Signed
URLs can expire; rescan and retry. Queue, settings, and history survive browser
restarts in IndexedDB, but interrupted work may restart its download.

### Formats, permissions, privacy, and limits

Detected audio offers original, MP3, M4A, and WAV. Detected video offers
original, MP4, WebM, or MP3 audio extraction. Direct `original` downloads can
pass through unchanged; adaptive media may be remuxed. Compatible codecs are
remuxed and incompatible ones are transcoded, which can be slow and lossy.

Permanent permissions are `activeTab`, `scripting`, `downloads`, `offscreen`,
`storage`, and `alarms`, for the purposes listed in the Spanish section. HTTP(S)
host access is optional and requested per origin. There is no MediaFetch
account, telemetry, or backend. See [PRIVACY.md](PRIVACY.md).

Inputs must be strictly below 2,000,000,000 bytes. Input and FFmpeg copies live
in RAM, so practical failures can occur far below 2 GB. Manifests are limited to
2 MB, 20,000 lines, 64 tracks, and 4,096 selected segments. Encrypted HLS, byte
ranges, discontinuities, LL/delta HLS, protected/dynamic/multi-period DASH,
`SegmentBase`, ranges, and `SegmentTimeline` are unsupported. CORS, expiring
URLs, required headers/cookies, site changes, service workers, and blockers can
also prevent detection or download.

Settings currently displays a concurrency value, but the coordinator processes
one job at a time; changing that value does not yet increase parallelism.

### Honest platform matrix

| Platform/source        | Status                   | Actual scope                                              |
| ---------------------- | ------------------------ | --------------------------------------------------------- |
| Direct HTTP(S) URL     | Supported                | If accessible and unencrypted                             |
| Generic web page       | Best effort              | Only URLs exposed in DOM, JSON-LD, or performance entries |
| Unencrypted HLS/DASH   | Partial                  | Only the documented subset                                |
| Vimeo                  | Best effort              | Visible video/collection URLs; no private API             |
| YouTube                | **Experimental, opt-in** | Only page-exposed URLs; site changes can break it         |
| TikTok                 | **Experimental, opt-in** | Only page-exposed URLs; site changes can break it         |
| DRM/encryption/paywall | Unsupported              | Deliberately rejected                                     |
| Firefox/Safari         | Unsupported              | Current artifact targets Chromium MV3                     |

**Specific warning:** YouTube and TikTok remain disabled until experimental
consent is enabled in Settings. MediaFetch does not use download APIs, decipher
signatures, or bypass controls, and successful detection is not guaranteed.
Follow platform terms and applicable rights.

### Licensing

MediaFetch's original code is MIT-licensed; see [LICENSE](LICENSE). The combined
ZIP is **not wholly MIT**: it includes `@ffmpeg/core` 0.12.10, declared
`GPL-2.0-or-later`; the `@ffmpeg/ffmpeg` wrapper is MIT. Releases attach the
corresponding ffmpeg.wasm v0.12.10 source. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Desarrollo / Development

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm zip
pnpm audit
```

Contribuciones: [CONTRIBUTING.md](CONTRIBUTING.md). Seguridad:
[SECURITY.md](SECURITY.md).
