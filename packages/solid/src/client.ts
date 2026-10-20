// Client half of `prerendered`. What a prerendered reference does in the
// browser depends on the build's posture, read from `import.meta.env`:
//
// - live (no `PRERENDER_MODE`: the dev server, or a build without the
//   prerender plugin): the reference is an ordinary GET-declared server
//   function — calls dispatch over HTTP to a live server. The app degrades
//   to a live-server deployment; nothing breaks, nothing is static.
// - `"static"` / `"hybrid"` (built with `prerender()` from
//   `prerender-crawler/vite`, which defines the constant): the reference is
//   STILL the runtime's own GET reference — the call path, hydration
//   adoption, server-component interception and response decoding are all
//   the runtime's. Only the send changes: the reference declares its own
//   (`withMeta(fn, { fetch })`), which answers the call's GET address with
//   its artifact from `_static/` (the live answer the build captured,
//   headers and all) and leaves the app's transport `fetch` alone. On a
//   miss, hybrid sends the original request through the app's send (a
//   server is deployed); static has nobody to fall back to and throws.
import {
  GET,
  getServerFunctionMetadata,
  isServerFunction,
  withMeta
} from "@solidjs/web/server-functions/client";
import {
  PRERENDERED_META_KEY,
  decodeArtifact,
  parseDataAddress,
  staticArtifactPathSync
} from "./shared.ts";
import type { AnnounceRoutesOptions, PrerenderedFunction } from "./shared.ts";

export { staticArtifactPath, staticCallKey } from "./shared.ts";
export type { AnnounceRoutesOptions, PrerenderedFunction } from "./shared.ts";

export { solidRouterPages, tanstackRouterPages } from "./routers.ts";
export type {
  SolidRouteLike,
  SolidRouterLike,
  SolidRouterPagesOptions,
  TanStackRouteLike,
  TanStackRouterLike
} from "./routers.ts";

/** A router `announceRoutes` can read — see the server half. */
export type AnnounceableRouter = unknown;

/** The client half of `announceRoutes`: there is no request here. Always false. */
export function announceRoutes(
  _router: AnnounceableRouter,
  _options?: AnnounceRoutesOptions
): boolean {
  return false;
}

/** The build posture, as `prerender-crawler/vite` defined it — or live when it did not. */
interface Posture {
  mode: "static" | "hybrid" | undefined;
  base: string;
  build: string | undefined;
}

// Read at call time, not module scope: a build replaces both expressions
// with constants, and a test may stub the env between calls. The direct
// `import.meta.env` spelling matters — it is what Vite's define and
// vitest's env stubbing both target; an indirection hides it from them.
function posture(): Posture {
  const env = import.meta.env;
  const mode = env?.PRERENDER_MODE;
  return {
    mode: mode === "static" || mode === "hybrid" ? mode : undefined,
    base: typeof env?.BASE_URL === "string" ? env.BASE_URL : "/",
    build: typeof env?.PRERENDER_BUILD === "string" ? env.PRERENDER_BUILD : undefined
  };
}

// Ids declared prerendered in this realm: the only calls answered from
// artifacts.
const prerenderedIds = new Set<string>();

type Send = (input: string, init: RequestInit) => Response | Promise<Response>;

// The send `prerendered()` declares on its reference: the runtime calls it
// for that function's requests, with the app's configured send as `next`.
// The artifact lookup reaches the global `fetch` in the same tick as the
// send: hydration adopts a server-rendered read only if its request is made
// synchronously, so keys are derived without an await.
const referenceSend = (address: string, init: RequestInit, next: Send) =>
  serveArtifact(address, (init.method ?? "GET").toUpperCase(), init, next) ?? next(address, init);

/** Answers a prerendered call's GET address from its artifact; undefined for any other request. */
function serveArtifact(
  url: string,
  method: string,
  init: RequestInit,
  send: Send
): Promise<Response> | undefined {
  const { mode, base, build } = posture();
  const call = mode && method === "GET" ? parseDataAddress(url) : undefined;
  if (!call || !prerenderedIds.has(call.id)) return;
  let path: string;
  try {
    path = staticArtifactPathSync(call.id, call.args, build);
  } catch {
    return; // arguments that cannot address an artifact
  }
  const artifactUrl = base.endsWith("/") ? base + path : `${base}/${path}`;
  const signal = init.signal ?? undefined;
  return globalThis.fetch(artifactUrl, signal ? { signal } : undefined).then(async response => {
    const answer = response.ok
      ? decodeArtifact(new Uint8Array(await response.arrayBuffer()))
      : undefined;
    if (answer) return answer;
    // hybrid deployed a live server: a call the build never made is an
    // ordinary GET dispatch, not a failure. Static has nobody to ask.
    if (mode === "hybrid") return send(url, init);
    throw new Error(
      `No static artifact for this call of "${call.id}" (${artifactUrl} answered ` +
        `${response.status}${response.ok ? " without an artifact" : ""}): only calls made ` +
        `during prerendering are captured. Prerender a page that performs this call (same ` +
        `arguments), or make the function a live server function.`
    );
  });
}

/**
 * Declares a server function PRERENDERED: it runs at build time, during
 * prerendering, and each call's answer is captured as a static artifact
 * addressed by the call's identity (function id + arguments). Clients of
 * the built site fetch the artifact instead of invoking a server — a static
 * deploy serves typed, codec-faithful data, and server components, with no
 * runtime server at all.
 *
 * The declaration implies `GET`: a prerendered call is by definition a
 * safe read (its result is baked into the build), and outside a
 * prerendered build — the dev server, or a build without the prerender
 * plugin — the reference behaves exactly like `GET(fn)`, so the app still
 * works against a live server.
 *
 * Arguments must be JSON-safe: they are the call's ADDRESS (both the
 * build and the client derive the artifact key from them), so they must
 * spell identically in both realms. Results are unrestricted — anything a
 * live call can answer (rich values through the codec, a server component's
 * markup) is what the artifact holds.
 *
 * Only calls that actually happen during prerendering have artifacts. In a
 * static build, a client calling with arguments no prerendered page used
 * gets a rejected call (there is no server to fall back to); in a hybrid
 * build the call falls back to the live server.
 *
 * ```ts
 * export const getPosts = prerendered(async (tag: string) => {
 *   "use server";
 *   return db.posts.byTag(tag); // runs at build time in a prerendered build
 * });
 * ```
 */
export function prerendered<A extends readonly unknown[], R>(
  fn: (...args: A) => R
): PrerenderedFunction<A, Awaited<R>> {
  if (!isServerFunction(fn)) {
    throw new Error("prerendered expects a server function reference");
  }
  // GET is the live fallback and the wire posture outside prerendered
  // builds; an already-GET-declared reference is adopted as-is.
  const source: any =
    getServerFunctionMetadata(fn)?.method === "GET" ? fn : GET(fn as (...args: any[]) => any);
  const meta: Record<string, unknown> = { [PRERENDERED_META_KEY]: true };
  if (posture().mode !== undefined) {
    prerenderedIds.add(source.id);
    // the reference's own send: the app's transport `fetch` stays the app's
    meta.fetch = referenceSend;
  }
  // the reference IS the runtime's GET reference, branded so integrations
  // can detect the declaration
  return withMeta(source, meta) as PrerenderedFunction<A, Awaited<R>>;
}
