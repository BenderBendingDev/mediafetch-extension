import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    exclude: [
      "**/node_modules/**",
      "**/.output/**",
      "**/.wxt/**",
      "tests/e2e/**",
    ],
    restoreMocks: true,
  },
});
