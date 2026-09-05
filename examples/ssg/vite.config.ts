import { fileRoutes } from "filesystem-routing/vite";
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import { prerender } from "prerender-crawler/vite";
import { serverFunctions } from "@solidjs/prerender/integration";

export default defineConfig({
  plugins: [
    solid({
      start: true,
      ssr: true,
      serverFunctions: true,
      extensions: [".jsx", ".tsx"]
    }),
    fileRoutes(),
    // The generic prerenderer crawls the built app; Solid's integration
    // captures prerendered() calls as static artifacts and guards the
    // static build against server functions nothing prerendered.
    prerender({ mode: "static", integrations: [serverFunctions()] })
  ],
  server: { port: 3000 },
  build: { target: "esnext" }
});
