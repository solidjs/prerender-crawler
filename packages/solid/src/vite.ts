// The Vite plugin: `prerender()` from `@solidjs/prerender/vite`.
//
// Two responsibilities, both build-only:
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
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import { runPrerender } from "prerender-core";
import type { PrerenderIntegration, PrerenderOptions } from "prerender-core";
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
  Transport
} from "prerender-core";

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
   *   written (the HTML is the product), and a missing artifact at runtime
   *   is a hard error naming the call, since there is nobody to fall back
   *   to. The server build is a build-time rendering tool, not a
   *   deliverable.
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
}

const ENV_ID = "@solidjs/prerender/env";
const RESOLVED_ENV_ID = "\0solid-prerender:env";

/**
 * Prerenders the app at build time: crawls the built server handler
 * starting from `pages` (default `["/"]`, plus every same-origin link
 * discovered along the way), writes each page's HTML into the client
 * output, and captures `prerendered` results as static artifacts.
 */
export function prerender(options: PrerenderPluginOptions = {}): Plugin {
  const fallback = (options.mode ?? "hybrid") !== "static";
  let base = "/";
  return {
    name: "solid-prerender",
    apply: "build",
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

        const { serverEntry: _entry, mode, codec, integrations = [], ...crawl } = options;
        const result = await runPrerender({
          ...crawl,
          // hybrid's walk bakes data; writing its HTML would shadow live SSR
          emitPages: options.emitPages ?? mode === "static",
          transport: { fetch: request => handleRequest(request) },
          outDir: clientOut,
          integrations: [createCaptureIntegration(codec), ...integrations]
        });

        const logger = builder.config.logger;
        const written = result.pages.filter(page => page.emitted).length;
        logger.info(
          `[solid-prerender] rendered ${result.pages.length} page(s) (${written} written), ` +
            `${result.files.length} static artifact(s) -> ${path.relative(root, clientOut)}`
        );
        for (const miss of result.skipped) {
          logger.warn(`[solid-prerender] skipped ${miss.path}: ${String(miss.error)}`);
        }
      }
    }
  };
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
export function createCaptureIntegration(codec?: unknown): PrerenderIntegration {
  const artifacts = new Map<string, Promise<string>>();
  const globals = globalThis as { [CAPTURE_SINK]?: CaptureSink };
  return {
    name: "solid-prerender:static-artifacts",
    setup() {
      globals[CAPTURE_SINK] = {
        async capture(id, args, value) {
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
