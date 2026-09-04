import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // src/client.ts imports the env posture module by its public
      // self-referencing name (the seam the /vite plugin swaps). In tests
      // that must resolve to the SOURCE module — the same instance the
      // tests mutate to simulate postures — not the built dist copy the
      // package exports point at.
      "@solidjs/prerender/env": fileURLToPath(new URL("./src/env.ts", import.meta.url))
    }
  }
});
