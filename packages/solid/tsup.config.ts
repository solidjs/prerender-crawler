import { defineConfig } from "tsup";

export default defineConfig({
  // Four entries, one per exports subpath. `prerender-core` is a private
  // workspace package (the framework-agnostic crawl engine); it is inlined
  // into the vite entry here so the published package has no dependency on
  // an unpublished name.
  entry: {
    client: "src/client.ts",
    server: "src/server.ts",
    env: "src/env.ts",
    vite: "src/vite.ts"
  },
  format: ["esm"],
  dts: true,
  splitting: true,
  clean: false,
  noExternal: ["prerender-core"],
  // the env posture module must survive bundling as this bare specifier —
  // it is the seam the /vite plugin swaps (see src/client.ts)
  external: ["@solidjs/prerender/env"]
});
