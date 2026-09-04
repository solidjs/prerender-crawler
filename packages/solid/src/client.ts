// Client half of `prerendered`. What a prerendered reference does in the
// browser depends on the build posture (see ./env.ts):
//
// - live posture (dev server, or a build without the prerender plugin):
//   the reference is an ordinary GET-declared server function — calls
//   dispatch over HTTP to a live server. The app degrades to a
//   live-server deployment; nothing breaks, nothing is static.
// - static posture (built with the prerender plugin): calls never reach a
//   server. The call's artifact key is derived from (id, arguments) —
//   the same derivation the build performed — and the payload is fetched
//   from `_static/` as an ordinary cacheable file.
import {
  GET,
  SERVER_FUNCTION_INVOKE,
  deserializeStream,
  getServerFunctionMetadata,
  getServerFunctionsCodec,
  isServerFunction,
  withMeta
} from "@solidjs/web/server-functions/client";
// Imported by its PUBLIC name, on purpose: this self-referencing specifier
// (resolved through package.json `exports` — dist/env.js, the live-posture
// default) is the exact id the prerender plugin intercepts in the client
// environment to swap in the static posture. A relative import would be
// bundled into this package's chunk graph and the swap would never fire.
import { env } from "@solidjs/prerender/env";
import { PRERENDERED_META_KEY, staticArtifactPath } from "./shared.ts";
import type { PrerenderedFunction } from "./shared.ts";

export { staticArtifactPath, staticCallKey } from "./shared.ts";
export type { PrerenderedFunction } from "./shared.ts";

// the metadata brand rides the same registered symbol the runtime uses, so
// `isServerFunction` / `getServerFunctionMetadata` recognize prerendered
// references like any other declaration wrapper's
const SERVER_FUNCTION_METADATA = Symbol.for("solid.ServerFunctionMetadata");

/**
 * Declares a server function PRERENDERED: it runs at build time, during
 * prerendering, and each call's result is captured as a static JSON
 * artifact addressed by the call's identity (function id + arguments).
 * Clients of the built site fetch the artifact instead of invoking a
 * server — a static deploy serves typed, codec-faithful data with no
 * runtime server at all.
 *
 * The declaration implies `GET`: a prerendered call is by definition a
 * safe read (its result is baked into the build), and outside the static
 * posture — the dev server, or a build without the prerender plugin — the
 * reference behaves exactly like `GET(fn)`, so the app still works
 * against a live server.
 *
 * Arguments must be JSON-safe: they are the call's ADDRESS (both the
 * build and the client derive the artifact key from them), so they must
 * spell identically in both realms. Results are unrestricted — rich values
 * (Dates, Maps, typed errors) ride the codec into the artifact.
 *
 * Only calls that actually happen during prerendering have artifacts: a
 * production client calling with arguments no prerendered page used gets
 * a rejected call (there is no server to fall back to).
 *
 * ```ts
 * export const getPosts = prerendered(async (tag: string) => {
 *   "use server";
 *   return db.posts.byTag(tag); // runs at build time in the static posture
 * });
 * ```
 */
export function prerendered<A extends readonly unknown[], R>(
  fn: (...args: A) => R
): PrerenderedFunction<A, Awaited<R>> {
  if (!isServerFunction(fn)) {
    throw new Error("prerendered expects a server function reference");
  }
  // GET is the live fallback and the wire posture outside static builds;
  // an already-GET-declared reference is adopted as-is.
  const source: any =
    getServerFunctionMetadata(fn)?.method === "GET" ? fn : GET(fn as (...args: any[]) => any);

  if (!env.staticArtifacts) {
    // live posture: the reference IS the GET reference, branded so
    // integrations can still detect the declaration
    return withMeta(source, { [PRERENDERED_META_KEY]: true }) as PrerenderedFunction<
      A,
      Awaited<R>
    >;
  }

  const id: string = source.id;
  const run = async (args: A, options?: { signal?: AbortSignal }) => {
    const path = await staticArtifactPath(id, args);
    const url = env.base.endsWith("/") ? env.base + path : `${env.base}/${path}`;
    const response = await fetch(url, options?.signal ? { signal: options.signal } : undefined);
    if (!response.ok) {
      // hybrid mode deployed a live server: a call the build never made is
      // an ordinary GET dispatch, not a failure — artifact-first, live
      // fallback. Static mode has nobody to fall back to.
      if (env.fallback) return source[SERVER_FUNCTION_INVOKE](args, options) as Promise<Awaited<R>>;
      throw new Error(
        `No static artifact for this call of "${id}" (${response.status} at ${url}): only calls ` +
          `made during prerendering are captured. Prerender a page that performs this call ` +
          `(same arguments), or make the function a live server function.`
      );
    }
    const text = await response.text();
    if (text === "") return undefined as Awaited<R>;
    // the payload mirrors the wire's format negotiation: plain JSON for
    // JSON-safe results, the codec's framed encoding (`;0x` prefix, which
    // valid JSON can never open with) for everything else
    return text.startsWith(";0x")
      ? ((await deserializeStream(new Response(text), getServerFunctionsCodec())) as Awaited<R>)
      : (JSON.parse(text) as Awaited<R>);
  };

  const wrapped = ((...args: A) => run(args)) as any;
  wrapped[SERVER_FUNCTION_METADATA] = {
    ...getServerFunctionMetadata(source),
    [PRERENDERED_META_KEY]: true
  };
  wrapped[SERVER_FUNCTION_INVOKE] = run;
  wrapped.id = id;
  // lazy, like the runtime's own references: the endpoint may be configured
  // after module scope runs — and in the static posture it names the live
  // address the artifact stands in for
  Object.defineProperty(wrapped, "url", { get: () => source.url, configurable: true });
  return wrapped as PrerenderedFunction<A, Awaited<R>>;
}
