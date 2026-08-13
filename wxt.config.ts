import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "MediaFetch",
    description:
      "Detecta, organiza y descarga medios autorizados con procesamiento local.",
    version: "0.1.0",
    minimum_chrome_version: "116",
    permissions: [
      "activeTab",
      "alarms",
      "downloads",
      "offscreen",
      "scripting",
      "storage",
    ],
    optional_host_permissions: ["http://*/*", "https://*/*"],
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'",
    },
  },
});
