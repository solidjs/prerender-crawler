# prerender-crawler

Framework-agnostic build-time prerendering. Point it at anything fetch-shaped — `Request` in, `Response` out — and it crawls the site into static files: seed pages, link discovery, header hints, redirects, retries, throttling, and an integration seam for capturing build-time data alongside the pages. No browser, no subprocess, no framework knowledge.

Ships as an engine (`prerender-crawler`), a Vite plugin built on it (`prerender-crawler/vite`), and a CLI for everything else.

## CLI

Prerender any running server, or any module exporting a request handler, with no framework integration at all:

```sh
# a running server — a framework's preview server, a container, a staging deploy
npx prerender-crawler http://localhost:3000 --out dist

# a built server module (handleRequest, fetch, or default.fetch), in-process
npx prerender-crawler dist/server/server.js --out dist/client --redirects
```

```
prerender-crawler <target> --out <dir> [options]
  -o, --out <dir>          Output directory (required)
  -p, --page <path>        Seed page; repeatable. Default: /
  -m, --mode <mode>        static (default) or hybrid
  -c, --concurrency <n>    Pages in flight at once. Default: 8
  -i, --interval <ms>      Minimum ms between request starts. Default: 0
  -r, --retries <n>        Re-fetch attempts for a failed page. Default: 2
      --origin <url>       Origin requests are minted under (module targets)
      --hint-header <name> Response header naming extra paths. Default: x-prerender
      --redirects          Write redirects as _redirects rules instead of stubs
      --redirects-file <f> Rules file name (implies --redirects). Default: _redirects
      --sitemap <origin>   Write sitemap.xml with entries under this public origin
      --sitemap-file <f>   Sitemap file name. Default: sitemap.xml
      --report             Write a JSON report of the crawl (pages, timings, referrers, ...)
      --report-file <f>    Report file name (implies --report). Default: prerender-report.json
      --keep-query         Render /posts?page=2 apart from /posts (see Query strings)
      --no-links           Do not follow links in rendered pages
      --no-redirect-stubs  Write no meta-refresh stubs at redirected paths
      --continue           Skip pages that fail instead of failing the run
      --flat               Write /about as about.html instead of about/index.html
```

For an HTTP target the crawl origin is the target's, so absolute links in the rendered HTML count as same-origin.

## Vite plugin

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { prerender } from "prerender-crawler/vite";

export default defineConfig({
  plugins: [
    framework(), // anything producing a client build and an SSR build
    prerender({ mode: "static" })
  ]
});
```

The plugin is build-only. It assumes two things about the app:

1. `vite build` produces a client output directory (the `client` environment's `outDir`, default `dist/client`).
2. Some environment's output includes a module exporting a request handler — `handleRequest`, `fetch`, or `default.fetch`. Default: `server.js` in the `ssr` environment's `outDir`; override with `serverEntry`.

After the other environments build, it imports the server handler and crawls it in-process. Pages and integration-emitted files land in the client output. Which pages exist is the server's to say — see [Seeding from the router](#seeding-from-the-router).

### Options

Everything from [`PrerenderOptions`](#engine-options) plus:

| Option        | Default                  |                                     |
| ------------- | ------------------------ | ----------------------------------- |
| `serverEntry` | `<ssr outDir>/server.js` | Built module exporting the handler. |

### `import.meta.env.PRERENDER_MODE`

The plugin defines this constant in every build environment with the run's `mode`. Runtime code can ask "am I a prerendered build, and which kind" — absent (dev, or a build without the plugin) means live. It's how integrations ship posture-aware client behavior without the app wiring anything.

## Modes

The one distinction every downstream policy keys on:

- **`"static"`** — the written files _are_ the deployment. Every rendered page is written; anything the crawl didn't produce doesn't exist at runtime, so integrations treat gaps as errors.
- **`"hybrid"`** — a live server is deployed alongside. The crawl is a build-time pass (data baking, selected pages). Rendered pages are _not_ written by default, because on most hosts a static HTML file shadows live SSR of the same route; gaps fall back to the server.

## Engine

The plugin and CLI are thin drivers. The engine works with any transport — anything with a `fetch(request: Request): Promise<Response>`:

```ts
import { runPrerender, httpTransport, moduleTransport } from "prerender-crawler";

const result = await runPrerender({
  transport: { fetch: request => app.handle(request) }, // or:
  // transport: httpTransport("http://localhost:3000"),   a running server
  // transport: await moduleTransport("dist/server.js"),  a handler module
  outDir: "dist",
  pages: ["/", "/about", { path: "/404", filename: "404.html" }],
  mode: "static"
});

result.pages; // RenderedPage[]   — path, referrers, filename, emitted, html, redirect?
result.redirects; // RedirectRecord[] — { from, to, status }, one per redirected path
result.files; // EmittedFile[]    — what integrations emitted
result.skipped; // SkippedPage[]    — failures left out (failOnError: false)
```

`httpTransport` sends the crawl's requests to the target's origin (path and query kept) and hands redirects back as the 3xx responses the server sent. Pass `{ headers }` for an auth token or `{ fetch }` for a custom implementation. `moduleTransport` imports a module exporting `handleRequest`, `fetch`, or `default.fetch` and calls it directly.

### Announcing pages

The crawl finds pages by following links and by reading the hint header (`x-prerender`, comma-separated paths) off responses. A page nothing links to is invisible to the first; the second is how a server that knows its routes declares them — and the thing that knows the routes is the router the app built for the request. The crawler knows no router; it only defines the wire. `prerender-crawler/announce` is that wire, free of Node imports so application server code can use it:

```ts
import { announcePages } from "prerender-crawler/announce";

// in the request handler, with whatever the router exposes — e.g. TanStack Router:
const pages = Object.entries(router.routesByPath)
  .filter(
    ([path, route]) => !path.includes("$") && (route.fullPath.endsWith("/") || !route.children)
  )
  .map(([path]) => path);
announcePages(request, response.headers, pages);
```

`announcePages` writes the header only when the request is the crawler's (it carries the hint header) — a visitor's response is untouched. What to announce: the paths that address a static page — no parameters or splats (only a render knows their values; the crawl finds those pages by their links), leaves and indexes (a layout with children but no index has no page of its own). The Vite plugin, the CLI against a module, and the CLI against a running server all send the hint header, so one line in the app seeds all three.

Enumerating a specific router's static pages is the framework integration's job, not this package's: [`@solidjs/prerender`](../solid) ships `solidRouterPages`, `tanstackRouterPages`, and `announceRoutes(router)` (which also reads the request from the ambient request event) for the routers Solid apps use.

### Redirects

A path that answers 3xx is recorded (`result.redirects`, one record per hop — `/a → /b → /c` is two records, the way host rules spell it) and its same-origin target is crawled as a page in its own right, so the destination renders once at its own URL. The redirected path itself gets a **meta-refresh stub** pointing at the chain's final destination, so the old URL keeps working on hosts with no redirect support. A redirect to another spelling of the same page (`/posts → /posts/`) is followed in place, not recorded.

Hosts with real redirect rules do better than stubs:

```ts
import { redirects } from "prerender-crawler";

runPrerender({ integrations: [redirects()] }); // or prerender({ integrations: [redirects()] })
```

`redirects()` emits a `_redirects` file (`/from /to 301`, the format Netlify and Cloudflare Pages share) and declares `handlesRedirects`, which stops the engine writing stubs — necessary on Netlify, where an existing file shadows the rule. Options: `filename`, `force` (Netlify's `301!`), and `format(records)` for another host's syntax.

### Sitemap

```ts
import { sitemap } from "prerender-crawler";

runPrerender({ integrations: [sitemap({ hostname: "https://example.com" })] });
```

Every rendered page becomes a `<url>` entry — the crawl knows the one thing a route manifest cannot, which pages actually exist with dynamic segments expanded. Redirect stubs, non-HTML responses, query spellings, and pages marked `noindex` (`<meta name="robots">` in the head or an `X-Robots-Tag` header) are left out, the same signals a search engine honors on the live site. Options: `filename`, `trailingSlash`, `filter(page)` for further exclusions, and `entry(page)` returning `lastmod` / `changefreq` / `priority` per page. `indexable(page)` and `formatSitemap(entries)` are exported for tooling that formats its own.

### Report

```ts
import { report } from "prerender-crawler";

runPrerender({ integrations: [report({ filename: "../prerender-report.json" })] });
```

Writes what the crawl did as JSON: every page with its status, content type, duration, output file, whether it was written and which pages linked to it; every redirect; every skipped page with its error and referrers; every file other integrations emitted; and totals. It answers "why was this page crawled", "which pages are slow" and "what did the build produce" after the process is gone. The default filename lands in the output directory and deploys with the site — `../` keeps it a build artifact.

### Query strings

By default the query is stripped from every URL the crawl sees: `/posts`, `/posts?page=2` and `/posts?utm=x` are one page, rendered once. That is what a static host can serve — a file at a path, the same for every query.

`keepQuery: true` makes each query spelling a page of its own (parameters sorted, so `?a=1&b=2` and `?b=2&a=1` meet). Each renders separately — its links are followed, its data captured — but is **written only when its seed entry names a `filename`**, because `posts/index.html` is already `/posts`. It exists for hybrid builds baking per-query data, and for sites that map queries onto files themselves:

```ts
runPrerender({
  keepQuery: true,
  pages: [{ path: "/posts?page=2", filename: "posts/page/2/index.html" }]
});
```

### Engine options

| Option                   | Default                                         |                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                   | `"static"`                                      | See [Modes](#modes). Decides the `emitPages` default.                                                                                                                                   |
| `pages`                  | `["/"]`                                         | Seeds: strings, `{ path, filename?, emit? }` entries, or a (async) function returning them. Duplicates collapse to one render.                                                          |
| `crawlLinks`             | `true`                                          | Follow same-origin links in rendered HTML. The only way dynamic routes are discovered without explicit seeding.                                                                         |
| `hintHeader`             | `"x-prerender"`                                 | Response header naming additional paths (comma-separated) — the route the data lives on announces the routes built from it.                                                             |
| `filter`                 |                                                 | `(path) => boolean`; drops a discovered path before it's fetched.                                                                                                                       |
| `keepQuery`              | `false`                                         | Render query spellings as distinct pages. See [Query strings](#query-strings).                                                                                                          |
| `concurrency`            | `8`                                             | Pages in flight at once.                                                                                                                                                                |
| `interval`               | `0`                                             | Minimum ms between the starts of consecutive requests across all workers — a throttle for renders hitting rate-limited APIs.                                                            |
| `retries` / `retryDelay` | `2` / `500`                                     | Re-fetch attempts for a failed page, and the wait between them.                                                                                                                         |
| `failOnError`            | `true`                                          | Whether a page that still fails after retries fails the run. Otherwise it's reported in `skipped`, with the pages that linked to it.                                                    |
| `redirectStubs`          | `true` unless an integration `handlesRedirects` | Whether redirected paths get a meta-refresh stub file pointing at the chain's end. See [Redirects](#redirects).                                                                         |
| `emitPages`              | `true` static / `false` hybrid                  | Whether rendered pages are written: a boolean, or a per-path predicate. Per-entry `emit` overrides. Unemitted pages still render fully — links are still followed, data still captured. |
| `autoSubfolderIndex`     | `true`                                          | `/about` → `about/index.html` (true) or `about.html` (false).                                                                                                                           |
| `origin`                 | `"http://localhost"`                            | Origin requests are minted under.                                                                                                                                                       |
| `onRendered`             |                                                 | Observes every rendered page — the seam for sitemaps and post-processing.                                                                                                               |
| `integrations`           | `[]`                                            | See below.                                                                                                                                                                              |

### Integrations

An integration is a hook bundle that participates in the run without owning it:

```ts
interface PrerenderIntegration {
  name: string;
  setup?(context: PrerenderContext): void | Promise<void>; // before the first render
  teardown?(context: PrerenderContext): void | Promise<void>; // after the last render, before writes
  handlesRedirects?: boolean; // "I write host redirect rules" — the engine skips its stubs
  client?: string; // module a bundler plugin imports into the client build (reserved)
}

interface PrerenderContext {
  mode: PrerenderMode;
  origin: string;
  outDir: string;
  pages: readonly RenderedPage[]; // complete by teardown
  redirects: readonly RedirectRecord[]; // complete by teardown
  skipped: readonly SkippedPage[]; // complete by teardown
  files: readonly EmittedFile[]; // what earlier integrations emitted
  emitFile(file: { filename: string; contents: string | Uint8Array }): void;
}
```

`emitFile` is the channel for artifacts produced during the crawl — captured server-function results, extracted payloads, sitemaps. Filenames resolve against the output directory; `../` or an absolute path lands outside it. Throwing from `teardown` fails the run: the place to verify the crawl produced everything the runtime half will need. `redirects()`, `sitemap()` and `report()` above are the shipped examples, each a formatter over the context; [`@solidjs/prerender`](../solid) is the reference integration with a runtime half.

### Utilities

- `httpTransport(target, { headers?, fetch? })`, `moduleTransport(entry)`, `loadHandler(entry)` — the shipped transports.
- `redirects(options?)`, `formatRedirectsFile(records, force?)` — the redirects integration and its `_redirects` formatter.
- `sitemap(options)`, `indexable(page)`, `formatSitemap(entries)` — the sitemap integration and its parts.
- `report(options?)` — the crawl report integration.
- `prerender-crawler/announce`: `announcePages(request, headers, paths, { header? })`, `HINT_HEADER` — the wire, for application server code.
- `extractLinks(html, pageUrl, { keepQuery? })`, `normalizeLink(href, base, origin)`, `normalizeRoute(url)`, `normalizePath(pathname)`, `splitRoute(route)`, `outputFilename(path, autoSubfolderIndex)` — the crawl's own primitives.

## Requirements

Node 20+. Vite 7 or 8 for the plugin (optional peer).

## License

MIT
