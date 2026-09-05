// The prerender integration for Solid server functions: `serverFunctions()`
// from `@solidjs/prerender/integration`, handed to `prerender-crawler`'s
// `integrations` (the Vite plugin's or a hand-driven `runPrerender`'s).
//
// Two jobs, both riding the engine's integration seam — no bundler hooks:
//
// 1. Capture. A sink installed for the crawl's duration (a registered-symbol
//    global — the crawl is in-process, so the built server bundle and this
//    module share a realm) collects every `prerendered` call the renders
//    execute, encodes each first-seen call once, and emits the artifacts
//    after the crawl. Encoding mirrors the wire's format negotiation:
//    JSON-safe results as plain JSON, everything else through the codec's
//    framed encoding (`;0x` prefix), which is exactly what the client half
//    sniffs.
// 2. The guard. `@solidjs/vite-plugin` records every server function the
//    CLIENT build can dispatch (by wire id) in its persisted manifest. After
//    the crawl, ids nothing captured are calls a static deployment has no
//    answer for — the build fails naming them instead of letting them 404
//    in production.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PrerenderContext, PrerenderIntegration } from "prerender-crawler";
import { CAPTURE_SINK, canonicalJSON, staticArtifactPath } from "./shared.ts";
import type { CaptureSink } from "./shared.ts";

export interface ServerFunctionsIntegrationOptions {
  /**
   * Codec options for encoding artifacts that carry rich (non-JSON-safe)
   * results. Must match the CLIENT's configured codec
   * (`configureServerFunctionsClient({ codec })`) — the artifact is decoded
   * there. Plain JSON-safe results never touch the codec.
   */
  codec?: unknown;
  /**
   * What to do when the client build references server functions the crawl
   * never captured — calls a static deployment cannot answer (no server),
   * whether the function lacks `prerendered()` or no prerendered page ever
   * called it. `"error"` fails the build naming each one.
   * @default "error" in static mode, "ignore" in hybrid (a server exists)
   */
  uncaptured?: "error" | "warn" | "ignore";
}

/** The integration, with the ids it saw — what the guard checks against. */
export interface ServerFunctionsIntegration extends PrerenderIntegration {
  /** Every server-function id captured at least once during the crawl. */
  readonly captured: ReadonlySet<string>;
}

/** Where `@solidjs/vite-plugin` persists the client build's server-function manifest. */
const MANIFEST_PATH = ".vite/solid-server-functions.json";

/** The manifest's shape (see `PersistedServerFunctionManifest` in `@solidjs/vite-plugin`). */
interface PersistedManifest {
  modules: string[];
  functions?: Array<{ id: string; name: string; module: string }>;
}

/**
 * The Solid server-functions integration for a prerender run: captures
 * `prerendered()` results as static artifacts and, in static mode, fails
 * the build if the client can reach server functions nothing prerendered.
 *
 * ```ts
 * import { prerender } from "prerender-crawler/vite";
 * import { serverFunctions } from "@solidjs/prerender/integration";
 *
 * prerender({ mode: "static", integrations: [serverFunctions()] })
 * ```
 */
export function serverFunctions(
  options: ServerFunctionsIntegrationOptions = {}
): ServerFunctionsIntegration {
  const artifacts = new Map<string, Promise<string>>();
  const captured = new Set<string>();
  const globals = globalThis as { [CAPTURE_SINK]?: CaptureSink };
  return {
    name: "solid:server-functions",
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
            payload = encodeArtifact(value, options.codec);
            artifacts.set(filename, payload);
          }
          await payload;
        }
      };
    },
    async teardown(context) {
      delete globals[CAPTURE_SINK];
      guard(context, captured, options.uncaptured);
      for (const [filename, payload] of artifacts) {
        context.emitFile({ filename, contents: await payload });
      }
    }
  };
}

/**
 * Every id the client can dispatch, minus every id the crawl captured, is a
 * call the static site has no answer for.
 */
function guard(
  context: PrerenderContext,
  captured: ReadonlySet<string>,
  policy = context.mode === "static" ? "error" : "ignore"
): void {
  if (policy === "ignore") return;
  const file = path.join(context.outDir, MANIFEST_PATH);
  if (!existsSync(file)) return; // no server functions compiled, nothing to check
  const manifest = JSON.parse(readFileSync(file, "utf8")) as string[] | PersistedManifest;
  if (Array.isArray(manifest) || !manifest.functions) {
    console.warn(
      `[@solidjs/prerender] ${MANIFEST_PATH} carries no function ids, so the static-mode guard ` +
        `cannot verify that every client-reachable server function was prerendered. Upgrade ` +
        `@solidjs/vite-plugin to a version that records them.`
    );
    return;
  }
  const uncaptured = manifest.functions.filter(fn => !captured.has(fn.id));
  if (uncaptured.length === 0) return;

  const lines = uncaptured.map(fn => `  - ${fn.name} (${fn.id}, ${fn.module})`);
  const message =
    `[@solidjs/prerender] ${uncaptured.length} server function(s) the client can call were ` +
    `never captured during prerendering:\n${lines.join("\n")}\n` +
    `A static deployment has no server to answer them, so these calls fail at runtime. Wrap ` +
    `each in prerendered() and make sure a prerendered page performs the call (same ` +
    `arguments); calls that must stay live — mutations, per-request data — need a deployed ` +
    `server (mode: "hybrid"). Set uncaptured: "warn" on serverFunctions() to build anyway.`;
  if (policy === "error") throw new Error(message);
  console.warn(message);
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
