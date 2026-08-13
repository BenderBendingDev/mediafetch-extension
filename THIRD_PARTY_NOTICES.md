# Avisos de terceros / Third-Party Notices

Este archivo es informativo y no sustituye los textos de licencia incluidos por
cada proyecto. / This file is informational and does not replace each project's
license text.

## Alcance de la licencia de MediaFetch

`LICENSE` (MIT) cubre únicamente el código original de MediaFetch. Un ZIP de la
extensión combina ese código con bibliotecas de terceros y **no debe describirse
como “todo MIT”**.

MediaFetch's `LICENSE` (MIT) covers its original code only. A packaged extension
combines it with third-party libraries and **must not be described as wholly
MIT-licensed**.

## FFmpeg WebAssembly

Versiones resueltas por el lockfile:

| Paquete          | Versión | Licencia declarada por el paquete |
| ---------------- | ------: | --------------------------------- |
| `@ffmpeg/core`   | 0.12.10 | **GPL-2.0-or-later**              |
| `@ffmpeg/ffmpeg` | 0.12.15 | MIT                               |
| `@ffmpeg/util`   |  0.12.2 | MIT                               |

`@ffmpeg/ffmpeg` es el wrapper JavaScript; su licencia MIT no cambia la licencia
declarada por el núcleo WASM distribuido dentro del ZIP.

The JavaScript wrapper `@ffmpeg/ffmpeg` is MIT-licensed; that does not change
the license declared for the WASM core shipped in the ZIP.

Upstream: <https://github.com/ffmpegwasm/ffmpeg.wasm>

### Identificación exacta de versiones

El tag upstream
[`v0.12.10`](https://github.com/ffmpegwasm/ffmpeg.wasm/releases/tag/v0.12.10)
apunta exactamente al commit
[`c3a763857c5e615ae8674715ad5e4f63ff469e9d`](https://github.com/ffmpegwasm/ffmpeg.wasm/commit/c3a763857c5e615ae8674715ad5e4f63ff469e9d).
Ese release es `@ffmpeg/ffmpeg` 0.12.10 junto con `@ffmpeg/core` 0.12.6, por lo
que **no** es el código fuente correspondiente al `@ffmpeg/core` 0.12.10 que usa
MediaFetch.

The upstream
[`v0.12.10`](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/c3a763857c5e615ae8674715ad5e4f63ff469e9d)
tag resolves exactly to commit
[`c3a763857c5e615ae8674715ad5e4f63ff469e9d`](https://github.com/ffmpegwasm/ffmpeg.wasm/commit/c3a763857c5e615ae8674715ad5e4f63ff469e9d).
That release paired `@ffmpeg/ffmpeg` 0.12.10 with `@ffmpeg/core` 0.12.6, so it
is **not** the corresponding source for MediaFetch's `@ffmpeg/core` 0.12.10.

`@ffmpeg/core` 0.12.10, `@ffmpeg/ffmpeg` 0.12.15 y `@ffmpeg/util` 0.12.2 se
publicaron en el conjunto upstream `v12.15`, cuyo cambio de release de core es
el commit
[`71aa99d37c02a7b4c435275ca9ef50e612f6efa1`](https://github.com/ffmpegwasm/ffmpeg.wasm/commit/71aa99d37c02a7b4c435275ca9ef50e612f6efa1).
Los releases de MediaFetch adjuntan el tarball de fuente fijado a ese commit con
el nombre `ffmpeg.wasm-core-0.12.10-source.tar.gz`, además de incluirlo en
`SHA256SUMS`.

`@ffmpeg/core` 0.12.10, `@ffmpeg/ffmpeg` 0.12.15, and `@ffmpeg/util` 0.12.2 were
published in the upstream `v12.15` set. Its core release change is commit
[`71aa99d37c02a7b4c435275ca9ef50e612f6efa1`](https://github.com/ffmpegwasm/ffmpeg.wasm/tree/71aa99d37c02a7b4c435275ca9ef50e612f6efa1).
MediaFetch releases attach the source archive pinned to that commit as
`ffmpeg.wasm-core-0.12.10-source.tar.gz` and cover it in `SHA256SUMS`. They also
attach the exact `v0.12.10`/`c3a7638…` tag archive as
`ffmpeg.wasm-v0.12.10-source.tar.gz` so the two upstream version lines remain
explicit and independently verifiable.

The package's `GPL-2.0-or-later` license text and notices remain authoritative.
FFmpeg and codec libraries built into the core may carry additional notices; the
attached corresponding source and generated SBOM are the release-specific
records. Recipients retain all rights granted by those licenses.

## Otras dependencias de ejecución / Other runtime dependencies

| Proyecto | Paquete              | Licencia declarada |
| -------- | -------------------- | ------------------ |
| React    | `react`, `react-dom` | MIT                |
| idb      | `idb`                | ISC                |
| Lucide   | `lucide-react`       | ISC                |
| Zod      | `zod`                | MIT                |

Las dependencias transitivas y de desarrollo se registran en `pnpm-lock.yaml`.
Cada release incluye un SBOM SPDX del artefacto Chromium para facilitar la
revisión del conjunto efectivamente distribuido.

Transitive and development dependencies are recorded in `pnpm-lock.yaml`. Each
release includes an SPDX SBOM of the Chromium artifact for review of the
distributed set.
