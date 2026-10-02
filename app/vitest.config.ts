import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// @tabline/sdk resolves as a normal npm-workspace package (symlinked node_modules entry) -- no alias needed.
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["viem", "@metamask/smart-accounts-kit"],
  },
  test: { environment: "jsdom", globals: true, setupFiles: ["./test/setup.ts"] },
});
