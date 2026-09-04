import { fileRoutes } from "filesystem-routing/vite";
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import { prerender } from "@solidjs/prerender/vite";

export default defineConfig({
  // Static site generation: streaming SSR at BUILD time only. `vite build`
  // builds client + server, then the prerender plugin crawls the built
  // server handler starting at "/", writes every discovered page's HTML
  // into dist/client, and bakes each `prerendered()` server-function call
  // into a static JSON artifact under dist/client/_static. Deploy
  // dist/client to any static host — dist/server was just the build's
  // rendering tool. In dev everything stays live (real SSR, real server
  // functions) — prerendering has no dev-time footprint.
  plugins: [
    solid({
      start: true,
      ssr: true,
      // Compiles 'use server' functions. In this template they are all
      // wrapped in `prerendered()`, so production clients never dispatch
      // to a server — they fetch build-time artifacts.
      serverFunctions: true,
      extensions: [".jsx", ".tsx"]
    }),
    fileRoutes(),
    // `mode: "static"` = no server is deployed: every rendered page is
    // written, and a prerendered() call the build never made is a hard
    // error in the client instead of a fallback dispatch.
    prerender({ mode: "static" })
  ],
  server: {
    port: 3000
  },
  build: {
    target: "esnext"
  }
});
