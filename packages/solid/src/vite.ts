// The Vite plugin: `prerender()` from `@solidjs/prerender/vite`.
//
// Three responsibilities, all build-only:
//
// 1. Posture: swap `@solidjs/prerender/env` in the CLIENT environment for a
//    static-posture module (staticArtifacts: true, plus the app's base), so
//    `prerendered` references fetch artifacts instead of dispatching.
//    The server build keeps the default env — its half reads the capture
//    handshake, not the posture.
// 2. Orchestration: a `buildApp` hook that builds the remaining
//    environments (declaring a non-`pre` buildApp claims the app build —
//    Vite's build-everything fallback and @solidjs/vite-plugin's completion
//    hook both stand down), imports the built server bundle's fetch-shaped
//    `handleRequest`, and drives the prerender-core crawl against it
//    in-process — no HTTP server, no subprocess. The static-function
//    capture integration rides the crawl: a sink installed for its
//    duration collects every static call the renders execute, and the
//    artifacts are emitted into the client output next to the pages.
// 3. The guard: a post-order companion plugin records every server
//    function id the compiled CLIENT code references. After the walk, ids
//    nothing captured are calls a static deployment cannot answer — static
//    mode fails the build naming them, instead of letting them 404 in
//    production.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import { runPrerender } from "prerender-core";
import type { PageEntry, PrerenderIntegration, PrerenderOptions } from "prerender-core";
import { fileRoutePages, hasFileSystemRouting } from "./file-routes.ts";
import type { FileRoutePagesOptions } from "./file-routes.ts";
import { collectServerReferences } from "./references.ts";
import { CAPTURE_SINK, canonicalJSON, staticArtifactPath } from "./shared.ts";
import type { CaptureSink } from "./shared.ts";

export type {
  EmittedFile,
  PageEntry,
  PagesSource,
  PrerenderContext,
  PrerenderIntegration,
  PrerenderOptions,
  PrerenderResult,
  RenderedPage,
  SkippedPage,
  Transport
} from "prerender-core";
export { fileRoutePages, staticRoutePaths } from "./file-routes.ts";
export type { FileRoutePagesOptions, RouteEntryLike } from "./file-routes.ts";
export { collectServerReferences } from "./references.ts";

export interface PrerenderPluginOptions extends PrerenderOptions {
  /**
   * The deployment the build targets. Two things follow from it:
   *
   * - `"hybrid"` (default): a live server is deployed. The walk is a
   *   data-baking pass — rendered pages are NOT written to disk by default
   *   (a written HTML file would shadow live SSR for that route on most
   *   hosts); opt pages into emission individually (`pages: [{ path:
   *   "/about", emit: true }]`) or wholesale (`emitPages`). At runtime,
   *   clients resolve `prerendered()` calls artifact-first and FALL BACK
   *   to live GET dispatch when the build never made the call — nothing
   *   breaks by declaring a function prerendered.
   * - `"static"`: no server is deployed (SSG). Every rendered page is
   *   written (the HTML is the product), a missing artifact at runtime is
   *   a hard error naming the call, and the build fails when the client
   *   references server functions nothing prerendered (see `uncaptured`).
   *   The server build is a build-time rendering tool, not a deliverable.
   */
  mode?: "hybrid" | "static";
  /**
   * Path (relative to the project root) of the built server module whose
   * `handleRequest` (or `fetch`) export renders the app. Defaults to
   * `server.js` inside the ssr environment's output directory — where
   * `@solidjs/vite-plugin`'s start mode puts it.
   */
  serverEntry?: string;
  /**
   * Codec options for encoding static-function artifacts that carry rich
   * (non-JSON-safe) results. Must match the CLIENT's configured codec
   * (`configureServerFunctionsClient({ codec })`) — the artifact is decoded
   * there. Plain JSON-safe results never touch the codec.
   */
  codec?: unknown;
  /**
   * Seed the crawl with the static pages of the project's
   * `filesystem-routing` route directory, merged with `pages`. Pages
   * nothing links to still get built, and the crawl starts wide instead
   * of unwinding from `/`. Dynamic routes are still discovered by links.
   *
   * `true` (default) applies when the package and `src/routes` exist and
   * is silently skipped otherwise; pass options to mirror a customized
   * `fileRoutes({ dir, extensions })` (then a missing package is an error);
   * `false` disables it.
   */
  fileRoutes?: boolean | FileRoutePagesOptions;
  /**
   * What to do when the compiled client references server functions the
   * walk never captured — calls a static deployment cannot answer (no
   * server), whether the function lacks `prerendered()` or no prerendered
   * page ever called it. `"error"` fails the build naming each one.
   * @default "error" in static mode, "ignore" in hybrid (a server exists)
   */
  uncaptured?: "error" | "warn" | "ignore";
}

const ENV_ID = "@solidjs/prerender/env";
const RESOLVED_ENV_ID = "\0solid-prerender:env";

/**
 * Prerenders the app at build time: crawls the built server handler
 * starting from `pages` (default `["/"]` plus the file-routed static
 * pages, plus every same-origin link discovered along the way), writes
 * each page's HTML into the client output, and captures `prerendered`
 * results as static artifacts.
 */
export function prerender(options: PrerenderPluginOptions = {}): Plugin[] {
  const mode = options.mode ?? "hybrid";
  const fallback = mode !== "static";
  let base = "/";
  // server-function id -> the client modules referencing it
  const references = new Map<string, Set<string>>();

  const main: Plugin = {
    name: "solid-prerender",
    apply: "build",
    // One instance across environments: Vite otherwise re-instantiates
    // plugins per environment build, and the reference map the scanner
    // fills during the CLIENT build must be the one `buildApp` reads.
    sharedDuringBuild: true,
    // `pre` is load-bearing: `@solidjs/prerender/env` is a REAL module
    // (the package's live-posture default), so the bundler's native
    // resolution handles it without ever consulting normal-order JS
    // resolveId hooks. Only a pre-enforced hook runs early enough to
    // claim the specifier and swap in the static posture.
    enforce: "pre",
    configResolved(config) {
      base = config.base || "/";
    },
    resolveId(id) {
      if (id === ENV_ID && this.environment?.name === "client") return RESOLVED_ENV_ID;
    },
    load(id) {
      if (id === RESOLVED_ENV_ID) {
        return (
          `export const env = { staticArtifacts: true, base: ${JSON.stringify(base)}, ` +
          `fallback: ${fallback} };`
        );
      }
    },
    buildApp: {
      order: "post",
      async handler(builder) {
        // Build whatever is not yet built, in definition order. The client
        // environment is normally already built here (@solidjs/vite-plugin's
        // client-first hook runs at normal order); declaring this hook
        // suppressed the fallbacks that would otherwise have built the rest.
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

        let serverModule: Record<string, unknown>;
        try {
          serverModule = await import(pathToFileURL(entry).href);
        } catch (cause) {
          throw new Error(
            `solid-prerender could not import the built server entry at ${entry}. ` +
              `Prerendering renders pages through the server build — enable ssr in ` +
              `@solidjs/vite-plugin (the server build is a build-time tool here; it is not ` +
              `deployed) or point \`serverEntry\` at a module exporting handleRequest/fetch.`,
            { cause }
          );
        }
        const handleRequest = (serverModule.handleRequest ??
          serverModule.fetch ??
          (serverModule.default as { fetch?: unknown } | undefined)?.fetch) as
          | ((request: Request) => Promise<Response>)
          | undefined;
        if (typeof handleRequest !== "function") {
          throw new Error(
            `The server entry at ${entry} exports none of handleRequest, fetch, or ` +
              `default.fetch — solid-prerender needs a Request -> Response handler to render ` +
              `pages through.`
          );
        }

        const routeSeeds = await fileRouteSeeds(root, options.fileRoutes);
        const {
          serverEntry: _entry,
          mode: _mode,
          codec,
          fileRoutes: _fileRoutes,
          uncaptured: _uncaptured,
          pages,
          integrations = [],
          ...crawl
        } = options;
        const capture = createCaptureIntegration(codec);
        const result = await runPrerender({
          ...crawl,
          pages: async () => [
            ...(typeof pages === "function" ? await pages() : (pages ?? ["/"])),
            ...routeSeeds
          ],
          // hybrid's walk bakes data; writing its HTML would shadow live SSR
          emitPages: options.emitPages ?? mode === "static",
          transport: { fetch: request => handleRequest(request) },
          outDir: clientOut,
          integrations: [capture, ...integrations]
        });

        const written = result.pages.filter(page => page.emitted).length;
        const seeded = routeSeeds.length ? `, ${routeSeeds.length} seeded from file routes` : "";
        logger.info(
          `[solid-prerender] rendered ${result.pages.length} page(s) (${written} written${seeded}), ` +
            `${result.files.length} static artifact(s) -> ${path.relative(root, clientOut)}`
        );
        for (const miss of result.skipped) {
          logger.warn(`[solid-prerender] skipped ${miss.path}: ${describe(miss.error)}`);
        }

        // The guard: every id the client can dispatch, minus every id the
        // walk captured, is a call the static site has no answer for.
        const policy = options.uncaptured ?? (mode === "static" ? "error" : "ignore");
        const uncaptured = [...references].filter(([id]) => !capture.captured.has(id));
        if (policy !== "ignore" && uncaptured.length) {
          const lines = uncaptured.map(
            ([id, modules]) =>
              `  - ${id} (${[...modules].map(module => path.relative(root, module)).join(", ")})`
          );
          const message =
            `[solid-prerender] ${uncaptured.length} server function(s) the client can call ` +
            `were never captured during prerendering:\n${lines.join("\n")}\n` +
            `A static deployment has no server to answer them, so these calls fail at runtime. ` +
            `Wrap each in prerendered() and make sure a prerendered page performs the call ` +
            `(same arguments); calls that must stay live — mutations, per-request data — need ` +
            `a deployed server (mode: "hybrid"). Set uncaptured: "warn" to build anyway.`;
          if (policy === "error") throw new Error(message);
          logger.warn(message);
        }
      }
    }
  };

  // The reference scanner. Post-order so it sees the compiled output of
  // the "use server" transform; client-only because that is the set of
  // functions a deployed browser can actually dispatch.
  const scanner: Plugin = {
    name: "solid-prerender:references",
    apply: "build",
    enforce: "post",
    sharedDuringBuild: true,
    buildStart() {
      if (this.environment?.name === "client") references.clear();
    },
    transform(code, id) {
      if (this.environment?.name !== "client") return;
      const ids = collectServerReferences(code);
      if (ids.length === 0) return;
      // route modules reach the client as `?pick=` variants of one file
      const module = id.split("?")[0];
      for (const ref of ids) {
        let modules = references.get(ref);
        if (!modules) references.set(ref, (modules = new Set()));
        modules.add(module);
      }
    }
  };

  return [main, scanner];
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

/** The capture integration, with the ids it saw — what the static-mode guard checks against. */
export interface CaptureIntegration extends PrerenderIntegration {
  /** Every server-function id captured at least once during the walk. */
  readonly captured: ReadonlySet<string>;
}

/**
 * The static-function capture integration: installs the sink the server
 * half of `prerendered` delivers to (a registered-symbol global — the
 * crawl is in-process, so the built server bundle and this module share a
 * realm), encodes each first-seen call once, and emits the artifacts after
 * the crawl. Encoding mirrors the wire's format negotiation: JSON-safe
 * results as plain JSON, everything else through the codec's framed
 * encoding (`;0x` prefix), which is exactly what the client half sniffs.
 *
 * The `prerender()` plugin wires this up itself; exported for setups
 * driving `runPrerender` by hand.
 */
export function createCaptureIntegration(codec?: unknown): CaptureIntegration {
  const artifacts = new Map<string, Promise<string>>();
  const captured = new Set<string>();
  const globals = globalThis as { [CAPTURE_SINK]?: CaptureSink };
  return {
    name: "solid-prerender:static-artifacts",
    captured,
    setup() {
      globals[CAPTURE_SINK] = {
        async capture(id, args, value) {
          captured.add(id);
          const filename = await staticArtifactPath(id, args);
          // one call identity, one artifact: the same call captured on many
          // pages encodes once, and every capture awaits the same settle
          let payload = artifacts.get(filename);
          if (!payload) {
            payload = encodeArtifact(value, codec);
            artifacts.set(filename, payload);
          }
          await payload;
        }
      };
    },
    async teardown(context) {
      delete globals[CAPTURE_SINK];
      for (const [filename, payload] of artifacts) {
        context.emitFile({ filename, contents: await payload });
      }
    }
  };
}

async function encodeArtifact(value: unknown, codec: unknown): Promise<string> {
  if (value === undefined) return "";
  try {
    // canonical form doubles as the JSON-safety guard: it throws on
    // anything a JSON round trip would reshape
    return canonicalJSON(value);
  } catch {
    // rich results ride the codec's framed encoding — the same bytes the
    // wire would carry, so whatever survives a live call survives the
    // artifact. Imported lazily: plain-data builds never load the codec.
    const { serializeResponseStream } = await import("@solidjs/web/server-functions/server");
    return await new Response(
      (serializeResponseStream as (v: unknown, c?: unknown) => ReadableStream<Uint8Array>)(
        value,
        codec
      )
    ).text();
  }
}
