/**
 * The engine's whole contract with the app is one function: something
 * fetch-shaped it can throw `Request`s at. In-process dispatch against a
 * built server entry and loopback HTTP against a preview server are both
 * just transports; the crawler never knows which one it is driving.
 */
export interface Transport {
  fetch(request: Request): Promise<Response>;
  /** Released when the run finishes, success or failure. */
  close?(): void | Promise<void>;
}

/** A page to prerender: a route path, optionally with an explicit output filename. */
export interface PageEntry {
  path: string;
  /**
   * Output file relative to the output directory. Defaults to the path's
   * natural mapping (`/` -> `index.html`, `/about` -> `about/index.html`
   * under `autoSubfolderIndex`, `/sitemap.xml` -> `sitemap.xml`). The
   * escape hatch for host conventions: `{ path: "/404", filename:
   * "404.html" }`.
   */
  filename?: string;
  /**
   * Whether this page's HTML is written to disk, overriding the run-level
   * `emitPages` policy for this entry. Rendering is unaffected either way:
   * an unemitted page still executes fully (its links are still crawled,
   * its captured data still baked) — emission only decides whether the
   * HTML becomes a static file, which on most hosts SHADOWS live SSR for
   * that route.
   */
  emit?: boolean;
}

/**
 * Seed pages: a list, or a function producing one — the seam route
 * sources (filesystem routing manifests, CMS queries) feed. Anything
 * shaped `{ path }` is accepted alongside plain strings.
 */
export type PagesSource =
  | Array<string | PageEntry>
  | (() => Array<string | PageEntry> | Promise<Array<string | PageEntry>>);

/**
 * One redirect the crawl observed: a request for `from` answered 3xx. `to`
 * is a normalized same-origin path, or an absolute URL when the redirect
 * leaves the origin. A chain (`/a` -> `/b` -> `/c`) is recorded hop by
 * hop, one record per path, exactly as a host's redirect rules would
 * express it.
 */
export interface RedirectRecord {
  from: string;
  to: string;
  status: number;
}

/** A page the engine rendered (and, when `emitted`, wrote). */
export interface RenderedPage {
  /** The normalized route path (`/about`), origin and query stripped. */
  path: string;
  /**
   * The pages whose links (or hint headers) led here, as known when this
   * page rendered; empty for seeds. Provenance for diagnostics — "why was
   * this route crawled" — and for sitemap tooling.
   */
  referrers: string[];
  /** The page's output file (written only when `emitted`), relative to the output directory. */
  filename: string;
  /** Whether the HTML was written to disk (see `emitPages` / `PageEntry.emit`). */
  emitted: boolean;
  /** The response the transport answered with (body consumed). */
  response: Response;
  /** Milliseconds from the request's start to its body fully read (the successful attempt). */
  duration: number;
  /**
   * The rendered HTML — or, for a redirected path, the meta-refresh stub
   * that stands in for it (see `redirect`).
   */
  html: string;
  /**
   * Set when the path answered a redirect instead of a page. The stub in
   * `html` points at the chain's FINAL destination; `redirect` records this
   * path's own hop. Sitemap tooling should skip these.
   */
  redirect?: RedirectRecord;
}

/** An extra artifact an integration ships alongside the rendered pages. */
export interface EmittedFile {
  /** Output path relative to the output directory. */
  filename: string;
  contents: string | Uint8Array;
}

/**
 * What the output is for. The distinction every policy downstream keys on:
 *
 * - `"static"`: the written files ARE the deployment (SSG). Every rendered
 *   page is written; anything the crawl did not produce does not exist at
 *   runtime, so integrations treat gaps as errors.
 * - `"hybrid"`: a live server is deployed alongside. The crawl is a
 *   build-time pass (data baking, selected pages); rendered pages are not
 *   written by default because a static HTML file shadows live SSR of the
 *   same route on most hosts, and gaps fall back to the server.
 */
export type PrerenderMode = "static" | "hybrid";

/**
 * The context integrations set up against. `emitFile` is the channel for
 * artifacts produced during the crawl (payload extraction, captured
 * server-function results): queued during the run, written with the pages.
 */
export interface PrerenderContext {
  mode: PrerenderMode;
  origin: string;
  outDir: string;
  /** Every page rendered so far — complete by `teardown`. Live view; do not mutate. */
  pages: readonly RenderedPage[];
  /** Every redirect observed so far — complete by `teardown`. Live view; do not mutate. */
  redirects: readonly RedirectRecord[];
  /** Pages that failed and were skipped (`failOnError: false`) — complete by `teardown`. */
  skipped: readonly SkippedPage[];
  /** Files emitted so far by integrations — those before this one, at `teardown`. */
  files: readonly EmittedFile[];
  /**
   * Queues a file to be written with the pages. `filename` is resolved
   * against the output directory; a `../` or absolute path lands outside
   * it (a build report that should not deploy, say).
   */
  emitFile(file: EmittedFile): void;
}

/** A hook bundle participating in the run without owning any of it. */
export interface PrerenderIntegration {
  name: string;
  /** Before the first page renders. */
  setup?(context: PrerenderContext): void | Promise<void>;
  /**
   * After the last page rendered, before any file is written. Throwing
   * here fails the run — the place for an integration to verify the crawl
   * produced everything its runtime half will need.
   */
  teardown?(context: PrerenderContext): void | Promise<void>;
  /**
   * Declares that this integration turns the run's redirects into the
   * host's own rules (a `_redirects` file, say). The engine then skips its
   * meta-refresh stubs at redirected paths: they would be redundant, and on
   * hosts where an existing file shadows a rule (Netlify) they would
   * defeat it. Equivalent to `redirectStubs: false` on the run.
   */
  handlesRedirects?: boolean;
  /**
   * A module specifier the bundler integration imports for side effects
   * into the CLIENT build when this integration is active — how an
   * integration ships runtime behavior (a transport interceptor, a
   * posture switch) without the app wiring it by hand. Not consumed by the
   * engine itself; reserved for bundler plugins built on it.
   */
  client?: string;
}

export interface PrerenderOptions {
  /** See `PrerenderMode`. Decides the `emitPages` default. @default "static" */
  mode?: PrerenderMode;
  /** Seed pages. @default ["/"] */
  pages?: PagesSource;
  /**
   * Extract same-origin links from rendered HTML and prerender them too.
   * The only way dynamic routes are discovered without explicit seeding.
   * @default true
   */
  crawlLinks?: boolean;
  /**
   * Response header a rendered page names additional paths on
   * (comma-separated) — the route the data lives on announces the routes
   * built from it. @default "x-prerender"
   */
  hintHeader?: string;
  /** Drops a discovered path before it is fetched. */
  filter?(path: string): boolean;
  /**
   * Treat `/posts?page=2` as a page distinct from `/posts`. Off, the query
   * is stripped everywhere and one render stands for every spelling. On,
   * each query spelling renders separately — its links are followed and
   * its data captured — but is written only when its entry names a
   * `filename`: a static host serves a path the same regardless of query,
   * so there is nothing correct to write by default. Meant for hybrid
   * builds baking per-query data, and for sites that map queries to
   * files themselves.
   * @default false
   */
  keepQuery?: boolean;
  /** Pages in flight at once. @default 8 */
  concurrency?: number;
  /**
   * Minimum milliseconds between the starts of consecutive requests, across
   * all workers — a throttle for renders that call rate-limited external
   * APIs. `concurrency` bounds how many are in flight; `interval` bounds how
   * fast new ones begin. @default 0
   */
  interval?: number;
  /** Re-fetch attempts for a failed page. @default 2 */
  retries?: number;
  /** Milliseconds between attempts. @default 500 */
  retryDelay?: number;
  /**
   * Whether a page that still fails after retries fails the run. Pages
   * skipped by `failOnError: false` are reported in the result.
   * @default true
   */
  failOnError?: boolean;
  /**
   * Whether a redirected path gets a meta-refresh stub file pointing at the
   * chain's final destination, so the old URL keeps working on hosts with
   * no redirect support of their own. Turn it off when redirects are
   * expressed as host rules instead (an integration declaring
   * `handlesRedirects` does so implicitly): a stub file next to a rule is
   * redundant at best and, on hosts where files shadow rules, defeats it.
   * @default true unless an integration declares `handlesRedirects`
   */
  redirectStubs?: boolean;
  /**
   * Whether rendered pages are written to disk: a blanket policy, or a
   * per-path predicate; per-entry `emit` flags override it either way. A
   * page excluded from emission still renders fully — link discovery and
   * integration capture (build-time data baking) happen regardless — it
   * just produces no HTML file. Turn this off (or scope it) when a live
   * server keeps serving the crawled routes: a written HTML file is served
   * ahead of SSR by most hosts, freezing the route.
   * @default true in `static` mode, false in `hybrid`
   */
  emitPages?: boolean | ((path: string) => boolean);
  /** `/about` -> `about/index.html` (true) or `about.html` (false). @default true */
  autoSubfolderIndex?: boolean;
  /** Origin requests are minted under. @default "http://localhost" */
  origin?: string;
  /** Observes every written page — the seam for sitemaps and post-processing. */
  onRendered?(page: RenderedPage): void | Promise<void>;
  integrations?: PrerenderIntegration[];
}

/** A page that failed after retries and was left out of the output. */
export interface SkippedPage {
  path: string;
  error: unknown;
  /** The pages that linked here — where to look for the broken link. */
  referrers: string[];
}

/** What a finished run reports. */
export interface PrerenderResult {
  pages: RenderedPage[];
  /** Every redirect the crawl observed, one record per redirected path. */
  redirects: RedirectRecord[];
  /** Extra files integrations emitted. */
  files: EmittedFile[];
  /** Paths that failed and were skipped (only with `failOnError: false`). */
  skipped: SkippedPage[];
}
