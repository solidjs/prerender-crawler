---
"prerender-crawler": minor
---

Prerender anything over HTTP, from the command line, with redirects the host can serve.

**CLI.** `npx prerender-crawler <target> --out <dir>` prerenders a running server (`http://localhost:3000`) or a module exporting a request handler (`dist/server/server.js`) with no framework integration. Options cover seeds, mode, concurrency, interval, retries, link following, redirect handling, and `--continue` for skip-on-failure.

**Transports.** `httpTransport(target, { headers?, fetch? })` re-addresses the crawl's requests to a running server and hands redirects back unfollowed; `moduleTransport(entry)` / `loadHandler(entry)` import a `handleRequest` / `fetch` / `default.fetch` module (what the Vite plugin now uses too). Both exported from `prerender-crawler`.

**Redirects, reworked.** A 3xx path is now recorded in `result.redirects` (`{ from, to, status }`, one record per hop) and its same-origin target is crawled as a page in its own right, rendered once at its own URL. The redirected path gets a meta-refresh stub pointing at the chain's _final_ destination. Previously an internal redirect wrote the destination's full HTML under the old path — duplicate content with no canonical — and never rendered the destination at its own URL unless something linked to it. A redirect to another spelling of the same page (`/posts → /posts/`) is followed in place. `RenderedPage.redirect` marks stub pages so sitemap tooling can skip them.

**`redirects()` integration.** Emits the crawl's redirects as a `_redirects` rules file (Netlify / Cloudflare Pages format; `filename`, `force`, and `format()` options for others) and declares the new `PrerenderIntegration.handlesRedirects`, which makes the engine skip its stubs — on Netlify a stub file would shadow the rule. The new `redirectStubs` option controls stubs directly.

**Integration context.** `PrerenderContext` gains live, read-only `pages` and `redirects` views, complete by `teardown`.

**Removed:** `maxRedirects`. Chains are no longer followed in place, so there is nothing to bound; cycles terminate naturally because each path is crawled once.
