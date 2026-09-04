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

/** A page the engine rendered (and, when `emitted`, wrote). */
export interface RenderedPage {
  /** The normalized route path (`/about`), origin and query stripped. */
  path: string;
  /** The page's output file (written only when `emitted`), relative to the output directory. */
  filename: string;
  /** Whether the HTML was written to disk (see `emitPages` / `PageEntry.emit`). */
  emitted: boolean;
  /** The response the transport answered with (body consumed). */
  response: Response;
  /** The rendered HTML. */
  html: string;
}

/** An extra artifact an integration ships alongside the rendered pages. */
export interface EmittedFile {
  /** Output path relative to the output directory. */
  filename: string;
  contents: string | Uint8Array;
}

/**
 * The context integrations set up against. `emitFile` is the channel for
 * artifacts produced during the crawl (payload extraction, captured
 * server-function results): queued during the run, written with the pages.
 */
export interface PrerenderContext {
  origin: string;
  outDir: string;
  emitFile(file: EmittedFile): void;
}

/** A hook bundle participating in the run without owning any of it. */
export interface PrerenderIntegration {
  name: string;
  /** Before the first page renders. */
  setup?(context: PrerenderContext): void | Promise<void>;
  /** After the last page rendered, before the run resolves. */
  teardown?(context: PrerenderContext): void | Promise<void>;
}

export interface PrerenderOptions {
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
  /** Pages in flight at once. @default 8 */
  concurrency?: number;
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
  /** Internal redirect hops followed for one page. @default 5 */
  maxRedirects?: number;
  /**
   * Whether rendered pages are written to disk: a blanket policy, or a
   * per-path predicate; per-entry `emit` flags override it either way. A
   * page excluded from emission still renders fully — link discovery and
   * integration capture (build-time data baking) happen regardless — it
   * just produces no HTML file. Turn this off (or scope it) when a live
   * server keeps serving the crawled routes: a written HTML file is served
   * ahead of SSR by most hosts, freezing the route.
   * @default true
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

/** What a finished run reports. */
export interface PrerenderResult {
  pages: RenderedPage[];
  /** Extra files integrations emitted. */
  files: EmittedFile[];
  /** Paths that failed and were skipped (only with `failOnError: false`). */
  skipped: Array<{ path: string; error: unknown }>;
}
