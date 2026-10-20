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
//   the runtime's. Only the send changes: `staticFetch`, installed as the
//   transport's `fetch`, answers a prerendered call's GET address with its
//   artifact from `_static/` (the live answer the build captured, headers
//   and all). On a miss, hybrid sends the original request (a server is
//   deployed); static has nobody to fall back to and throws.
import {
  GET,
  configureServerFunctionsClient,
  getServerFunctionMetadata,
  isServerFunction,
  withMeta
} from "@solidjs/web/server-functions/client";
import * as transport from "@solidjs/web/server-functions/client";
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

// Ids declared prerendered in this realm: the only calls `staticFetch`
// answers from artifacts.
const prerenderedIds = new Set<string>();
let installed = false;
// whether the artifacts are served by a send layer (`wrapServerFunctionsFetch`,
// a runtime with `wrapServerFunctionsFetch`, solidjs/solid#4170), which no app `fetch` can displace
let layered = false;

type Fetch = typeof globalThis.fetch;

// read off the namespace: older runtimes lack it, and a named import of a
// missing export fails the app's build
const wrapSend = (
  transport as typeof transport & {
    wrapServerFunctionsFetch?: (wrap: (next: Fetch) => Fetch) => void;
  }
).wrapServerFunctionsFetch;

/**
 * The transport `fetch` that serves prerendered calls from their static
 * artifacts. `prerendered()` installs the same behavior on its own in a
 * prerendered build: on a runtime that exports `wrapServerFunctionsFetch`
 * (solidjs/solid#4170), as a send layer, which composes with any `fetch` the app
 * configures in either order. On older runtimes it is the transport
 * `fetch` itself, and an app that configures its own must pass it through,
 * or the artifacts are bypassed:
 *
 * ```ts
 * configureServerFunctionsClient({ fetch: staticFetch(myFetch) });
 * ```
 *
 * With the layer in place this hands back `myFetch`'s behavior unchanged,
 * so the line is safe to keep either way.
 *
 * Requests that are not a prerendered call's GET address — and every
 * request outside a prerendered build — go to `next` untouched. The
 * artifact lookup reaches the global `fetch` in the same tick as the send:
 * hydration adopts a server-rendered read only if its request is made
 * synchronously, so keys are derived without an await.
 */
export function staticFetch(next?: Fetch): Fetch {
  installed = true;
  return serveArtifacts(next, false);
}

function serveArtifacts(next: Fetch | undefined, layer: boolean): Fetch {
  // read at call time: hydration swaps the global for the length of a
  // synchronous trace, and a test may stub it
  const send: Fetch = (input, init) => (next ?? globalThis.fetch)(input, init);
  return (input, init) => {
    // once the layer serves the artifacts (ahead of whatever `fetch` the app
    // configures, read at call time), an app-installed copy only passes on
    if (layered && !layer) return send(input, init);
    const { mode, base, build } = posture();
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const call = mode && method === "GET" ? parseDataAddress(url) : undefined;
    if (!call || !prerenderedIds.has(call.id)) return send(input, init);
    let path: string;
    try {
      path = staticArtifactPathSync(call.id, call.args, build);
    } catch {
      return send(input, init); // arguments that cannot address an artifact
    }
    const artifactUrl = base.endsWith("/") ? base + path : `${base}/${path}`;
    const signal = init?.signal ?? undefined;
    return globalThis.fetch(artifactUrl, signal ? { signal } : undefined).then(async response => {
      const answer = response.ok
        ? decodeArtifact(new Uint8Array(await response.arrayBuffer()))
        : undefined;
      if (answer) return answer;
      // hybrid deployed a live server: a call the build never made is an
      // ordinary GET dispatch, not a failure. Static has nobody to ask.
      if (mode === "hybrid") return send(input, init);
      throw new Error(
        `No static artifact for this call of "${call.id}" (${artifactUrl} answered ` +
          `${response.status}${response.ok ? " without an artifact" : ""}): only calls made ` +
          `during prerendering are captured. Prerender a page that performs this call (same ` +
          `arguments), or make the function a live server function.`
      );
    });
  };
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
  if (posture().mode !== undefined) {
    prerenderedIds.add(source.id);
    if (wrapSend) {
      if (!layered) {
        layered = true;
        wrapSend(next => serveArtifacts(next, true));
      }
    } else if (!installed) configureServerFunctionsClient({ fetch: staticFetch() });
  }
  // the reference IS the runtime's GET reference, branded so integrations
  // can detect the declaration
  return withMeta(source, { [PRERENDERED_META_KEY]: true }) as PrerenderedFunction<A, Awaited<R>>;
}
