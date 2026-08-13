# Contribuir / Contributing

## Español

Se aceptan correcciones enfocadas y reproducibles. Antes de empezar un cambio
grande, abre una incidencia para acordar alcance. No envíes código que eluda
DRM, cifrado, autenticación, controles de acceso o restricciones de una
plataforma.

### Entorno

- Node.js 24.
- pnpm 11.21.0 mediante Corepack.
- Chrome o Chromium compatible con Manifest V3 (mínimo 116).

```sh
corepack enable
corepack prepare pnpm@11.21.0 --activate
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

### Flujo

1. Crea una rama y limita el cambio a un objetivo.
2. Añade o actualiza pruebas Vitest para lógica y Playwright para flujos reales
   de la extensión.
3. No uses servicios ni contenido de terceros en pruebas: amplía los fixtures
   locales y sintéticos.
4. Ejecuta antes de abrir la propuesta:

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

5. Explica comportamiento, riesgo, pruebas y cambios de permisos/licencias. No
   incluyas artefactos `.output`, reportes, cookies, tokens ni medios reales.

El formato lo gestiona Prettier. ESLint y TypeScript deben quedar sin errores.
Las nuevas dependencias requieren justificar necesidad, mantenimiento, tamaño,
licencia y efecto sobre el ZIP combinado. Una dependencia copyleft puede cambiar
las obligaciones de distribución aunque el código propio siga bajo MIT;
actualiza `THIRD_PARTY_NOTICES.md` y el proceso de release.

Los commits deben ser pequeños, descriptivos y no mezclar refactorizaciones no
relacionadas. Al corregir un fallo, añade una prueba que falle sin la
corrección.

## English

Focused, reproducible fixes are welcome. Open an issue before a large change so
scope can be agreed. Do not contribute code intended to bypass DRM, encryption,
authentication, access controls, or platform restrictions.

Use Node.js 24, pnpm 11.21.0 through Corepack, and Chromium 116 or newer.
Install with `pnpm install --frozen-lockfile` and install Playwright Chromium.
Keep each branch to one goal, add Vitest or Playwright coverage, and use only
local synthetic fixtures. Run every command listed above before submitting.

Describe behavior, risk, tests, and any permission or licensing impact. Do not
commit build output, reports, secrets, cookies, tokens, or real media. New
dependencies must be justified for maintenance, size, license, and combined
distribution obligations. Update third-party notices and release artifacts when
necessary. Keep commits small and include a regression test for bug fixes.
