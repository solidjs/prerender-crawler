---
"@solidjs/prerender": minor
"prerender-crawler": minor
---

Prerendered calls now store the live answer, so server components can be prerendered.

**`@solidjs/prerender`.** An artifact is now the response the app's own server-function endpoint gives for the call's GET address (status, headers and body), captured by replaying each call through the crawl after the pages render. Before, the integration encoded the returned value itself, which bypassed the server's result policies: a server component (`return props => <jsx/>`) was stored as an error, and client navigation to it crashed in both static and hybrid builds.

On the client, `prerendered()` now returns the runtime's own GET reference and serves artifacts through the reference's own send (`withMeta(fn, { fetch })`), so an app's transport `fetch` stays the app's and carries the hybrid fallback. Hydration adopts server-rendered reads and server components without a request, where it used to refetch them, and responses decode through the runtime's own pipeline. Artifacts are recognized by a marker line instead of status, so a host answering a missing artifact with a 200 page now falls back to the live server in hybrid mode instead of failing to parse.

Artifacts live under the build's id (`_static/<build>/…`), so they can be cached as immutable and a deploy never serves the previous build's answer from a CDN.

Breaking: artifacts are `_static/<build>/<label>.<key>.txt` in a new format (rebuild to regenerate them); `serverFunctions()` no longer takes `codec` (the server's configured codec is used); `@solidjs/web` 2.0.0-rc.16 or later is required.

**`prerender-crawler`.** `PrerenderContext.fetch(input)` sends a request through the crawl's own transport (paced by `interval`, relative urls resolved against `origin`) and returns the raw response, for integrations that capture what the app answers at an address that is not a page. `buildId` names the build (`context.buildId`); the Vite plugin mints one per build and defines it as `import.meta.env.PRERENDER_BUILD`.
