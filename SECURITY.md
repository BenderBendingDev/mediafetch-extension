# Política de seguridad / Security Policy

## Versiones compatibles / Supported versions

Mientras el proyecto sea anterior a 1.0, solo la última versión publicada recibe
correcciones de seguridad. Las versiones antiguas y compilaciones modificadas no
tienen soporte.

While the project is pre-1.0, only the latest published version receives
security fixes. Older versions and modified builds are unsupported.

## Informar de una vulnerabilidad / Reporting a vulnerability

No publiques secretos ni detalles explotables en una incidencia. Usa **Security
→ Report a vulnerability** en GitHub para crear un aviso privado. Si el
repositorio no ofrece esa opción, contacta en privado a sus responsables y
comparte inicialmente:

- versión, navegador y sistema operativo;
- impacto y condiciones necesarias;
- pasos mínimos de reproducción o prueba de concepto;
- si se expusieron URLs, credenciales o datos reales.

Do not post secrets or exploitable details in a public issue. Use GitHub's
**Security → Report a vulnerability** private advisory flow. If unavailable,
contact the maintainers privately and initially provide the version, browser,
OS, impact, prerequisites, minimal reproduction, and whether real data or
credentials were exposed.

Se intentará confirmar la recepción en 7 días y coordinar corrección y
publicación responsable. No se promete recompensa. Evita acceder a contenido
ajeno, interrumpir servicios, realizar ingeniería social o conservar datos más
tiempo del imprescindible.

We aim to acknowledge reports within 7 days and coordinate a fix and responsible
disclosure. No bounty is promised. Do not access others' content, disrupt
services, perform social engineering, or retain data longer than necessary.

## Alcance / Scope

Son relevantes, entre otros, la ejecución de código en el contexto de la
extensión, escaladas de permisos, exfiltración no solicitada, inyección en
páginas, persistencia insegura o aceptación incorrecta de contenido cifrado/DRM.
Que una plataforma cambie, una URL expire, CORS bloquee una descarga o un medio
no sea detectable suele ser un error funcional, no una vulnerabilidad.

Relevant issues include extension-context code execution, permission escalation,
unsolicited exfiltration, page injection, unsafe persistence, or incorrect
acceptance of encrypted/DRM content. Platform changes, expired URLs, CORS
failures, and undetected media are generally functional bugs rather than
security vulnerabilities.

Dependencias / Dependencies: report upstream flaws to their maintainers too when
appropriate. MediaFetch includes a GPL-licensed FFmpeg WASM component; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
