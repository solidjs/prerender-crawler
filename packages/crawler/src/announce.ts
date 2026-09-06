/**
 * The announce protocol: how a server tells a crawl which pages it has.
 *
 * The crawl finds pages by following links and by reading the hint header
 * (`x-prerender`, comma-separated paths) off responses. A route nothing
 * links to is invisible to the first; the second is how a server that
 * KNOWS its routes declares them — and the thing that knows the routes is
 * the router the app built for the request. Which routes count is the
 * router's business, so the enumeration lives with the framework
 * integration (`@solidjs/prerender` ships Solid Router's and TanStack
 * Router's); this module is only the wire: put the paths on the header
 * when the request is the crawler's. Every crawl — the Vite plugin, the
 * CLI against a built module, the CLI against a running server — sends
 * the hint request header and seeds from the answer.
 *
 * What to announce: paths that address a static page. No parameters or
 * splats (only a render knows their values; the crawl finds them by their
 * links), leaves and indexes (a layout with children but no index has no
 * page of its own). One spelling per page — the engine normalizes trailing
 * slashes, so either is fine.
 *
 * Imported by application SERVER code: no Node imports here.
 */

/** The hint header the engine reads, and the request header it sends. */
export const HINT_HEADER = "x-prerender";

export interface AnnounceOptions {
  /** The header name, if the crawl was configured with a custom `hintHeader`. @default "x-prerender" */
  header?: string;
}

/**
 * Puts `paths` on the response's hint header — when the request is the
 * crawler's (it carries the hint header). Returns whether it did. A
 * regular visitor's response is left untouched.
 *
 * ```ts
 * announcePages(event.request, event.response.headers, staticPaths);
 * ```
 */
export function announcePages(
  request: Request,
  headers: Headers,
  paths: readonly string[],
  options: AnnounceOptions = {}
): boolean {
  const { header = HINT_HEADER } = options;
  if (!request.headers.has(header) || paths.length === 0) return false;
  headers.set(header, paths.join(","));
  return true;
}
