# @solidjs/prerender

## 0.1.0

### Minor Changes

- 6039452: Initial release.

  `prerender-crawler`: framework-agnostic build-time prerendering engine (`runPrerender`) and Vite plugin (`prerender-crawler/vite`). Crawls a `Request -> Response` handler from seed pages, following same-origin links and `x-prerender` header hints, with redirects, retries, concurrency and interval throttling, per-page emit control, `static`/`hybrid` modes, `filesystem-routing` seeding, and an integration seam (`setup`/`teardown`/`emitFile`) for capturing build-time data alongside pages. Defines `import.meta.env.PRERENDER_MODE` in builds.

  `@solidjs/prerender`: `prerendered(fn)` declares a server function as build-time data — GET-implied, results captured as static artifacts keyed by call identity, fetched by the deployed client (with live fallback in hybrid mode). `serverFunctions()` (`@solidjs/prerender/integration`) captures those calls during the crawl and, in static mode, fails the build naming any client-reachable server function nothing prerendered.
