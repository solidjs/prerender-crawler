import { defineConfig } from "tsup";

export default defineConfig({
  // Three entries, one per exports subpath: the runtime halves (`.`, picked
  // by the `browser` condition) and the build-time integration.
  // `prerender-crawler` is a peer — its types appear in the integration's
  // signature; nothing from it is bundled.
  entry: {
    client: "src/client.ts",
    server: "src/server.ts",
    integration: "src/integration.ts"
  },
  format: ["esm"],
  dts: true,
  splitting: true,
  clean: false,
  external: [/^prerender-crawler(\/|$)/]
});
