// Server half of `prerendered`. On the server a prerendered reference is
// the GET-declared reference with one extra behavior: while a capture sink
// is installed (the prerender integration installs one for the duration of
// the crawl — see ./integration.ts), every executed call is delivered to it as
// (id, args, settled value), and the delivery is AWAITED so a page's
// render does not finish before its artifacts are safely captured.
// Without a sink — dev SSR, a live production server — the wrapper is
// call-through: the function runs in-process like any direct SSR call.
import {
  GET,
  SERVER_FUNCTION_INVOKE,
  getServerFunctionMetadata,
  isServerFunction
} from "@solidjs/web/server-functions/server";
import { getRequestEvent } from "@solidjs/web";
import type { RequestEvent, ResponseStub } from "@solidjs/web";
import { announcePages, solidRouterPages } from "prerender-crawler/routers";
import type { SolidRouteLike, SolidRouterLike } from "prerender-crawler/routers";
import { CAPTURE_SINK, PRERENDERED_META_KEY } from "./shared.ts";
import type { AnnounceRoutesOptions, CaptureSink, PrerenderedFunction } from "./shared.ts";

export { staticArtifactPath, staticCallKey } from "./shared.ts";
export type { CaptureSink, PrerenderedFunction } from "./shared.ts";
export type { AnnounceRoutesOptions } from "./shared.ts";

/**
 * Tells a prerender crawl which pages this app's router has — the server
 * half. Called during a server render (the app root is the natural place),
 * it reads the ambient request: when the request is the crawler's, the
 * router's static pages go on the response's hint header and the crawl
 * seeds every one of them, linked or not. A visitor's request is untouched;
 * on the client this is a no-op. Returns whether it announced.
 *
 * ```tsx
 * import { announceRoutes } from "@solidjs/prerender";
 * import { Router } from "./router";
 *
 * export default function App() {
 *   announceRoutes(Router);
 *   return <Router>{props => props.children}</Router>;
 * }
 * ```
 *
 * Dynamic routes (`/posts/:id`) are not announced — only a render knows
 * their values; the crawl finds them by their links.
 */
export function announceRoutes(
  router: SolidRouterLike | SolidRouteLike | readonly SolidRouteLike[],
  options: AnnounceRoutesOptions = {}
): boolean {
  const event = getRequestEvent() as (RequestEvent & { response?: ResponseStub }) | undefined;
  if (!event?.response || event.response.committed) return false;
  if (!event.request.headers.has(options.header ?? "x-prerender")) return false;
  const pages = solidRouterPages(router, { base: options.base });
  return announcePages(event.request, event.response.headers, pages, { header: options.header });
}

const SERVER_FUNCTION_METADATA = Symbol.for("solid.ServerFunctionMetadata");

/**
 * Declares a server function PRERENDERED — the server half. Calling the
 * reference during SSR runs the function in-process exactly like a direct
 * server-function call; during prerendering (when the prerender
 * integration has installed its capture sink) each call's settled result
 * is additionally captured as a static artifact keyed by the call's
 * identity. The declaration implies `GET` — it registers the id's GET
 * grant so the client's live fallback (dev, plugin-less builds) can
 * dispatch over HTTP GET.
 *
 * See the client half (the browser build of this module) for the full
 * declaration contract.
 */
export function prerendered<A extends readonly unknown[], R>(
  fn: (...args: A) => R
): PrerenderedFunction<A, Awaited<R>> {
  if (!isServerFunction(fn)) {
    throw new Error("prerendered expects a server function reference");
  }
  // the GET declaration registers the id's method grant server-side, so
  // the client's live-posture GET calls dispatch instead of answering 405
  const source: any =
    getServerFunctionMetadata(fn)?.method === "GET" ? fn : GET(fn as (...args: any[]) => any);
  const id: string = source.id;

  const run = async (args: A, options?: unknown) => {
    const value = await source[SERVER_FUNCTION_INVOKE](args, options);
    const sink = (globalThis as { [CAPTURE_SINK]?: CaptureSink })[CAPTURE_SINK];
    // awaited so the render that triggered the call cannot outrun the
    // capture — the prerender run's teardown sees every artifact settled
    if (sink) await sink.capture(id, args, value);
    return value as Awaited<R>;
  };

  const wrapped = ((...args: A) => run(args)) as any;
  wrapped[SERVER_FUNCTION_METADATA] = {
    ...getServerFunctionMetadata(source),
    [PRERENDERED_META_KEY]: true
  };
  wrapped[SERVER_FUNCTION_INVOKE] = run;
  wrapped.id = id;
  Object.defineProperty(wrapped, "url", { get: () => source.url, configurable: true });
  return wrapped as PrerenderedFunction<A, Awaited<R>>;
}
