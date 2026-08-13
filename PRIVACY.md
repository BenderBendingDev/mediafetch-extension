# Privacidad / Privacy

Última actualización / Last updated: 2026-08-13

## Español

MediaFetch no tiene cuentas, analítica, publicidad, telemetría ni un servidor
propio. El procesamiento se ejecuta dentro de la extensión. Al usarla, el
navegador sí se comunica directamente con las páginas y URLs de medios que el
usuario elige; esos sitios y el proveedor del navegador aplican sus propias
políticas.

### Datos que trata

- URLs de páginas, manifiestos, segmentos y medios; títulos, miniaturas,
  duración, tipo MIME y metadatos de pistas expuestos por la página.
- Configuración, consentimiento experimental, cola, estado de trabajos, errores
  e historial.
- El contenido descargado, temporalmente en memoria durante la descarga, remux o
  conversión.

MediaFetch no solicita ni guarda nombres de usuario, contraseñas, números de
tarjeta ni cookies. Las solicitudes de medios usan el contexto de sesión del
navegador (`credentials: include`), por lo que el navegador puede adjuntar
cookies aplicables sin revelarlas al almacenamiento de MediaFetch.

### Almacenamiento y retención

La cola, los ajustes y el historial se guardan localmente en IndexedDB; idioma y
límite de lote pueden guardarse en el almacenamiento de la extensión o
`localStorage`. El historial se conserva 90 días por defecto, con un valor
interno validado entre 1 y 3.650 días; la interfaz actual no expone ese ajuste.
Los artefactos finales se guardan mediante el gestor de descargas del navegador.
Los blobs y datos de FFmpeg son temporales y se liberan al terminar o reiniciar
el contexto.

Para borrar los datos, elimina la extensión o usa la función del navegador para
borrar sus datos. Los archivos ya descargados deben borrarse por separado.
Revoca accesos a sitios desde los detalles/permisos de la extensión.

### Acceso a sitios

Los patrones `http://*/*` y `https://*/*` son permisos opcionales. MediaFetch
los solicita por origen cuando el usuario pide analizar una página. La extensión
lee únicamente información necesaria para descubrir candidatos: elementos de
medios y fuentes, enlaces de descarga/colección, JSON-LD y entradas de
rendimiento. Puede abrir pestañas temporales inactivas para URLs y colecciones;
se cierran tras el análisis.

### Transferencias y terceros

No se transmiten datos a un backend de MediaFetch. Las solicitudes van a los
hosts de las URLs elegidas, que observan los datos normales de una petición web
(por ejemplo, IP, cabeceras y cookies que aplique el navegador). FFmpeg
WebAssembly se incluye en el paquete y no se descarga desde una CDN.

### Contacto

Para preguntas de privacidad, abre una incidencia en el repositorio público. No
incluyas URLs privadas, cookies, tokens ni contenido personal en informes
públicos.

## English

MediaFetch has no accounts, analytics, advertising, telemetry, or proprietary
backend. Processing runs inside the extension. The browser still connects
directly to pages and media URLs selected by the user; those sites and the
browser provider have their own policies.

MediaFetch processes page/media/manifest/segment URLs and exposed titles,
thumbnails, duration, MIME and track metadata, plus settings, experimental
consent, queue state, errors, and history. Media bytes reside temporarily in
memory for download and processing. It does not request or store usernames,
passwords, payment data, or cookies. Requests use the browser session context,
so the browser may attach applicable cookies without storing them in
MediaFetch's database.

Queue, settings, and history are stored locally in IndexedDB. Locale and batch
limit may use extension storage or `localStorage`. History defaults to 90 days
with an internally validated 1–3,650 day range; the current UI does not expose
that setting. Finished files use the browser download manager; FFmpeg blobs are
temporary. Remove the extension or clear its site data to erase local records,
revoke site access in extension permissions, and delete downloaded files
separately.

HTTP(S) host permissions are optional and requested per origin when the user
asks to scan. The extension reads only media/source elements, relevant links,
JSON-LD, and performance entries needed for discovery. It may open inactive
temporary tabs and closes them after scanning.

No data is sent to a MediaFetch backend. Selected hosts receive ordinary web
request data such as IP address, headers, and browser-managed cookies. FFmpeg
WebAssembly is bundled rather than fetched from a CDN.

For privacy questions, open an issue in the public repository. Never post
private URLs, cookies, tokens, or personal content in a public report.
