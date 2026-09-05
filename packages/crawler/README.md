# prerender-crawler

Framework-agnostic build-time prerendering. Point it at anything fetch-shaped — `Request` in, `Response` out — and it crawls the site into static files: seed pages, link discovery, header hints, redirects, retries, throttling, and an integration seam for capturing build-time data alongside the pages. No browser, no subprocess, no framework knowledge.

Ships as an engine (`prerender-crawler`) and a Vite plugin built on it (`prerender-crawler/vite`).

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

The plugin is build-only. It assumes three things about the app:

1. `vite build` produces a client output directory (the `client` environment's `outDir`, default `dist/client`).
2. Some environment's output includes a module exporting a request handler — `handleRequest`, `fetch`, or `default.fetch`. Default: `server.js` in the `ssr` environment's `outDir`; override with `serverEntry`.
3. Optionally, a [`filesystem-routing`](https://www.npmjs.com/package/filesystem-routing) route directory names the static pages.

After the other environments build, it imports the server handler and crawls it in-process. Pages and integration-emitted files land in the client output.

### Options

Everything from [`PrerenderOptions`](#engine-options) plus:

| Option        | Default                  |                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverEntry` | `<ssr outDir>/server.js` | Built module exporting the handler.                                                                                                                                                                                                                                                                                                                         |
| `fileRoutes`  | `true`                   | Seed the crawl with the static pages of the project's `filesystem-routing` directory. `true` applies when the package and `src/routes` exist and is skipped silently otherwise; pass `{ dir, extensions }` to mirror a customized `fileRoutes()` (then a missing package is an error); `false` disables. Dynamic routes are still found by following links. |

### `import.meta.env.PRERENDER_MODE`

The plugin defines this constant in every build environment with the run's `mode`. Runtime code can ask "am I a prerendered build, and which kind" — absent (dev, or a build without the plugin) means live. It's how integrations ship posture-aware client behavior without the app wiring anything.

## Modes

The one distinction every downstream policy keys on:

- **`"static"`** — the written files _are_ the deployment. Every rendered page is written; anything the crawl didn't produce doesn't exist at runtime, so integrations treat gaps as errors.
- **`"hybrid"`** — a live server is deployed alongside. The crawl is a build-time pass (data baking, selected pages). Rendered pages are _not_ written by default, because on most hosts a static HTML file shadows live SSR of the same route; gaps fall back to the server.

## Engine

The plugin is a thin driver. The engine works with any transport:

```ts
import { runPrerender } from "prerender-crawler";

const result = await runPrerender({
  transport: { fetch: request => app.handle(request) },
  outDir: "dist",
  pages: ["/", "/about", { path: "/404", filename: "404.html" }],
  mode: "static"
});

result.pages; // RenderedPage[] — path, referrers, filename, emitted, html
result.files; // EmittedFile[]  — what integrations emitted
result.skipped; // SkippedPage[]  — failures left out (failOnError: false)
```

### Engine options

| Option                   | Default                        |                                                                                                                                                                                         |
| ------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                   | `"static"`                     | See [Modes](#modes). Decides the `emitPages` default.                                                                                                                                   |
| `pages`                  | `["/"]`                        | Seeds: strings, `{ path, filename?, emit? }` entries, or a (async) function returning them. Duplicates collapse to one render.                                                          |
| `crawlLinks`             | `true`                         | Follow same-origin links in rendered HTML. The only way dynamic routes are discovered without explicit seeding.                                                                         |
| `hintHeader`             | `"x-prerender"`                | Response header naming additional paths (comma-separated) — the route the data lives on announces the routes built from it.                                                             |
| `filter`                 |                                | `(path) => boolean`; drops a discovered path before it's fetched.                                                                                                                       |
| `concurrency`            | `8`                            | Pages in flight at once.                                                                                                                                                                |
| `interval`               | `0`                            | Minimum ms between the starts of consecutive requests across all workers — a throttle for renders hitting rate-limited APIs.                                                            |
| `retries` / `retryDelay` | `2` / `500`                    | Re-fetch attempts for a failed page, and the wait between them.                                                                                                                         |
| `failOnError`            | `true`                         | Whether a page that still fails after retries fails the run. Otherwise it's reported in `skipped`, with the pages that linked to it.                                                    |
| `maxRedirects`           | `5`                            | Internal redirect hops followed for one page.                                                                                                                                           |
| `emitPages`              | `true` static / `false` hybrid | Whether rendered pages are written: a boolean, or a per-path predicate. Per-entry `emit` overrides. Unemitted pages still render fully — links are still followed, data still captured. |
| `autoSubfolderIndex`     | `true`                         | `/about` → `about/index.html` (true) or `about.html` (false).                                                                                                                           |
| `origin`                 | `"http://localhost"`           | Origin requests are minted under.                                                                                                                                                       |
| `onRendered`             |                                | Observes every rendered page — the seam for sitemaps and post-processing.                                                                                                               |
| `integrations`           | `[]`                           | See below.                                                                                                                                                                              |

### Integrations

An integration is a hook bundle that participates in the run without owning it:

```ts
interface PrerenderIntegration {
  name: string;
  setup?(context: PrerenderContext): void | Promise<void>; // before the first render
  teardown?(context: PrerenderContext): void | Promise<void>; // after the last render, before writes
  client?: string; // module a bundler plugin imports into the client build (reserved)
}

interface PrerenderContext {
  mode: PrerenderMode;
  origin: string;
  outDir: string;
  emitFile(file: { filename: string; contents: string | Uint8Array }): void;
}
```

`emitFile` is the channel for artifacts produced during the crawl — captured server-function results, extracted payloads, sitemaps. Throwing from `teardown` fails the run: the place to verify the crawl produced everything the runtime half will need. [`@solidjs/prerender`](../solid) is the reference integration.

### Utilities

- `fileRoutePages({ root, dir, extensions })` / `staticRoutePaths(entries)` — the static page paths of a `filesystem-routing` manifest, as a `pages` source.
- `extractLinks(html)`, `normalizeLink(href, from)`, `normalizePath(path)`, `outputFilename(path, autoSubfolderIndex)` — the crawl's own primitives.

## Requirements

Node 20+. Vite 7 or 8 for the plugin (optional peer). `filesystem-routing` ≥ 0.2 for route seeding (optional peer).

## License

MIT
