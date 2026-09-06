# prerender-crawler

## 0.2.0

### Minor Changes

- 7ffcf5e: Prerender anything over HTTP, from the command line, with redirects the host can serve.

  **CLI.** `npx prerender-crawler <target> --out <dir>` prerenders a running server (`http://localhost:3000`) or a module exporting a request handler (`dist/server/server.js`) with no framework integration. Options cover seeds, mode, concurrency, interval, retries, link following, redirect handling, and `--continue` for skip-on-failure.

  **Transports.** `httpTransport(target, { headers?, fetch? })` re-addresses the crawl's requests to a running server and hands redirects back unfollowed; `moduleTransport(entry)` / `loadHandler(entry)` import a `handleRequest` / `fetch` / `default.fetch` module (what the Vite plugin now uses too). Both exported from `prerender-crawler`.

  **Redirects, reworked.** A 3xx path is now recorded in `result.redirects` (`{ from, to, status }`, one record per hop) and its same-origin target is crawled as a page in its own right, rendered once at its own URL. The redirected path gets a meta-refresh stub pointing at the chain's _final_ destination. Previously an internal redirect wrote the destination's full HTML under the old path — duplicate content with no canonical — and never rendered the destination at its own URL unless something linked to it. A redirect to another spelling of the same page (`/posts → /posts/`) is followed in place. `RenderedPage.redirect` marks stub pages so sitemap tooling can skip them.

  **`redirects()` integration.** Emits the crawl's redirects as a `_redirects` rules file (Netlify / Cloudflare Pages format; `filename`, `force`, and `format()` options for others) and declares the new `PrerenderIntegration.handlesRedirects`, which makes the engine skip its stubs — on Netlify a stub file would shadow the rule. The new `redirectStubs` option controls stubs directly.

  **`sitemap()` integration.** `sitemap({ hostname })` writes `sitemap.xml` from the pages the crawl actually rendered — dynamic routes expanded — leaving out redirect stubs, non-HTML responses, query spellings, and pages marked `noindex` via `<meta name="robots">` or `X-Robots-Tag`. Options: `filename`, `trailingSlash`, `filter(page)`, `entry(page)` for `lastmod` / `changefreq` / `priority`. `indexable()` and `formatSitemap()` are exported. CLI: `--sitemap <origin>`, `--sitemap-file`.

  **`report()` integration.** Writes a JSON account of the run — each page's status, content type, duration, output file, written flag and referrers; redirects; skipped pages with errors; files other integrations emitted; totals. `filename` resolves against the output directory, so `"../prerender-report.json"` keeps it out of the deploy. CLI: `--report`, `--report-file`.

  **Query-string pages.** `keepQuery: true` renders `/posts?page=2` apart from `/posts` (parameters sorted for dedupe), following its links and capturing its data, but writes it only when its seed entry names a `filename` — a static host serves a path the same for every query. Off by default; CLI `--keep-query`.

  **Announcing pages, from the server.** New `prerender-crawler/announce` (no Node imports — for application server code): `announcePages(request, headers, paths)` puts a server's static page paths on the response's hint header when the request is the crawler's, so every crawl — the Vite plugin, the CLI against a module, the CLI against a running server — seeds from the same header. The crawler defines only the wire; which routes a router has is the framework integration's to enumerate. `@solidjs/prerender` ships that for the routers Solid apps use: `solidRouterPages(router | routes, { base? })` (a Solid Router 2 `createRouter` instance or definition tree), `tanstackRouterPages(router)` (a TanStack instance's `routesByPath`), and `announceRoutes(router)` — one line in the app root (Solid Router) or the request setup (TanStack Router); it takes either router by shape, reads the ambient request event, and is a no-op in the browser.

  **Removed:** `fileRoutePages`, `staticRoutePaths`, and the Vite plugin's `fileRoutes` option — build-time seeding that walked a `filesystem-routing` directory and re-derived its path rules. The server's own router is the source of truth for which pages exist, and the header works for crawls that never see the project's disk (the CLI against a running server). `filesystem-routing` is no longer a peer dependency.

  **Seeds are normalized like links.** A seed spelled `about/`, `/a#top`, or `/posts?page=2` now meets the crawled link to the same page in one queue entry. Previously a seed with a query was fetched verbatim and written to a literal `posts?page=2/` directory.

  **`RenderedPage.duration`.** Milliseconds from request start to body read, pacing excluded.

  **Integration context.** `PrerenderContext` gains live, read-only `pages`, `redirects`, `skipped` and `files` views, complete by `teardown`. `emitFile` filenames now resolve against the output directory (`path.resolve`), so `../` and absolute paths land outside it.

  **Fixed:** `interval` now bounds the gap between _actual_ request starts. Previously it spaced claimed time slots, so a start delayed by a busy event loop could be followed by an on-time one less than `interval` later.

  **Removed:** `maxRedirects`. Chains are no longer followed in place, so there is nothing to bound; cycles terminate naturally because each path is crawled once.

## 0.1.0

### Minor Changes

- 6039452: Initial release.

  `prerender-crawler`: framework-agnostic build-time prerendering engine (`runPrerender`) and Vite plugin (`prerender-crawler/vite`). Crawls a `Request -> Response` handler from seed pages, following same-origin links and `x-prerender` header hints, with redirects, retries, concurrency and interval throttling, per-page emit control, `static`/`hybrid` modes, `filesystem-routing` seeding, and an integration seam (`setup`/`teardown`/`emitFile`) for capturing build-time data alongside pages. Defines `import.meta.env.PRERENDER_MODE` in builds.

  `@solidjs/prerender`: `prerendered(fn)` declares a server function as build-time data — GET-implied, results captured as static artifacts keyed by call identity, fetched by the deployed client (with live fallback in hybrid mode). `serverFunctions()` (`@solidjs/prerender/integration`) captures those calls during the crawl and, in static mode, fails the build naming any client-reachable server function nothing prerendered.
