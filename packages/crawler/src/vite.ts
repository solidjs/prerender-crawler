// The Vite plugin: `prerender()` from `prerender-crawler/vite`.
//
// Framework-agnostic by construction. It knows three things about the app:
// that `vite build` produces a client output directory, that some
// environment's output includes a module exporting a fetch-shaped handler
// (`handleRequest` or `fetch`: Request in, Response out), and — optionally
// — that a `filesystem-routing` directory names the static pages. Anything
// framework-specific rides along as an integration (see
// `PrerenderIntegration`), the same seam the engine exposes to non-Vite
// drivers.
//
// Responsibilities, all build-only:
//
// 1. Orchestration: a `buildApp` hook (declaring one claims the app build;
//    Vite's build-everything fallback stands down) that builds the
//    remaining environments, imports the built server handler, and drives
//    the crawl against it in-process — no HTTP server, no subprocess.
//    Pages and integration-emitted files land in the client output.
// 2. Posture: `import.meta.env.PRERENDER_MODE` is defined in every build
//    environment so runtime code can ask "am I a prerendered build, and of
//    which kind" — the one bit of client-side knowledge integrations need.
//    Absent (dev, or a build without this plugin) means "live".
// 3. Seeding: the static pages of a `filesystem-routing` route directory
//    seed the crawl automatically, so a page nothing links to still builds.
import { existsSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { runPrerender } from "./crawl.ts";
import { fileRoutePages, hasFileSystemRouting } from "./file-routes.ts";
import type { FileRoutePagesOptions } from "./file-routes.ts";
import { moduleTransport } from "./transports.ts";
import type { PageEntry, PrerenderOptions } from "./types.ts";

export { fileRoutePages, staticRoutePaths } from "./file-routes.ts";
export type { FileRoutePagesOptions, RouteEntryLike } from "./file-routes.ts";
export { redirects } from "./redirects.ts";
export type { RedirectsIntegrationOptions } from "./redirects.ts";
export type * from "./types.ts";

/** The `import.meta.env` key the plugin defines with the build's `PrerenderMode`. */
export const PRERENDER_MODE_ENV = "PRERENDER_MODE";

export interface PrerenderPluginOptions extends PrerenderOptions {
  /**
   * Path (relative to the project root) of the built module exporting the
   * request handler — `handleRequest`, `fetch`, or `default.fetch`.
   * Defaults to `server.js` inside the `ssr` environment's output directory.
   */
  serverEntry?: string;
  /**
   * Seed the crawl with the static pages of the project's
   * `filesystem-routing` route directory, merged with `pages`. Dynamic
   * routes (`/posts/:slug`) are still discovered by links — only a render
   * knows their values.
   *
   * `true` (default) applies when the package and `src/routes` exist and
   * is silently skipped otherwise; pass options to mirror a customized
   * `fileRoutes({ dir, extensions })` (then a missing package is an error);
   * `false` disables it.
   */
  fileRoutes?: boolean | FileRoutePagesOptions;
}

/**
 * Prerenders the app at build time: crawls the built server handler from
 * `pages` (default `["/"]`, plus the file-routed static pages, plus every
 * same-origin link discovered along the way) and writes each page's HTML —
 * and whatever the integrations emit — into the client output.
 *
 * ```ts
 * import { prerender } from "prerender-crawler/vite";
 * export default defineConfig({
 *   plugins: [framework(), prerender({ mode: "static", integrations: [...] })]
 * });
 * ```
 */
export function prerender(options: PrerenderPluginOptions = {}): Plugin {
  const mode = options.mode ?? "static";

  return {
    name: "prerender",
    apply: "build",
    config() {
      // Vite merges `import.meta.env.*` defines into the whole-object form
      // too, so `import.meta.env.PRERENDER_MODE` and `import.meta.env`
      // destructuring both see it. Every environment gets it: the server
      // build may legitimately ask as well.
      return { define: { [`import.meta.env.${PRERENDER_MODE_ENV}`]: JSON.stringify(mode) } };
    },
    buildApp: {
      order: "post",
      async handler(builder) {
        // Build whatever is not yet built, in definition order. Frameworks
        // that build the client first at normal order have already done so
        // here; declaring this hook suppressed the fallbacks that would
        // otherwise have built the rest.
        for (const environment of Object.values(builder.environments)) {
          if (!environment.isBuilt) await builder.build(environment);
        }

        const root = builder.config.root;
        const logger = builder.config.logger;
        const clientOut = path.resolve(
          root,
          builder.environments.client?.config.build.outDir ?? "dist/client"
        );
        const ssrOut = path.resolve(
          root,
          builder.environments.ssr?.config.build.outDir ?? "dist/server"
        );
        const entry = options.serverEntry
          ? path.resolve(root, options.serverEntry)
          : path.join(ssrOut, "server.js");

        let transport;
        try {
          transport = await moduleTransport(entry);
        } catch (error) {
          throw new Error(
            `${describe(error)} Prerendering renders pages through the server build — make ` +
              `sure an SSR build runs (the server build is a build-time tool here; it need not ` +
              `be deployed) or point \`serverEntry\` at the module.`,
            { cause: error }
          );
        }
        const routeSeeds = await fileRouteSeeds(root, options.fileRoutes);
        const { serverEntry: _entry, fileRoutes: _fileRoutes, pages, ...crawl } = options;
        const result = await runPrerender({
          ...crawl,
          mode,
          pages: async () => [
            ...(typeof pages === "function" ? await pages() : (pages ?? ["/"])),
            ...routeSeeds
          ],
          transport,
          outDir: clientOut
        });

        const written = result.pages.filter(page => page.emitted).length;
        const seeded = routeSeeds.length ? `, ${routeSeeds.length} seeded from file routes` : "";
        const redirected = result.redirects.length
          ? `, ${result.redirects.length} redirect(s)`
          : "";
        logger.info(
          `[prerender] rendered ${result.pages.length} page(s) (${written} written${seeded})` +
            `${redirected}, ${result.files.length} file(s) emitted -> ${path.relative(root, clientOut)}`
        );
        for (const miss of result.skipped) {
          logger.warn(`[prerender] skipped ${miss.path}: ${describe(miss.error)}`);
        }
      }
    }
  };
}

async function fileRouteSeeds(
  root: string,
  option: PrerenderPluginOptions["fileRoutes"]
): Promise<Array<string | PageEntry>> {
  if (option === false) return [];
  const explicit = typeof option === "object" ? option : undefined;
  if (!explicit) {
    // auto mode: only when the project actually uses file routing
    const dir = path.resolve(root, "src/routes");
    if (!hasFileSystemRouting(root) || !existsSync(dir)) return [];
  }
  return fileRoutePages({ root, ...explicit })();
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
