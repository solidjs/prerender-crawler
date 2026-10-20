# @solidjs/prerender

Static server functions for Solid. `prerendered()` declares that a `'use server'` function runs at build time — during prerendering — and that each call's result is captured as a static artifact the deployed client fetches instead of calling a server. Pair it with [`prerender-crawler`](../crawler) and `vite build` produces a folder of files that is a complete Solid app with typed server-side data loading and no server.

Requires `@solidjs/web` 2.0.0-rc.9 or later (server functions) and `@solidjs/vite-plugin` with `serverFunctions: true`.

## Setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import { prerender } from "prerender-crawler/vite";
import { serverFunctions } from "@solidjs/prerender/integration";

export default defineConfig({
  plugins: [
    solid({ start: true, ssr: true, serverFunctions: true }),
    prerender({ mode: "static", integrations: [serverFunctions()] })
  ]
});
```

`prerender` is the generic crawler; `serverFunctions()` is the Solid integration that captures `prerendered()` calls during the crawl and guards the build.

## `prerendered(fn)`

```ts
import { query } from "@solidjs/router";
import { prerendered } from "@solidjs/prerender";

export const getPost = query(
  prerendered(async (slug: string) => {
    "use server";
    return db.posts.find(slug); // runs at build time in a prerendered build
  }),
  "post"
);
```

- **Implies `GET`.** A prerendered call is by definition a safe read. Outside a prerendered build — the dev server, or a build without the prerender plugin — the reference behaves exactly like `GET(fn)`, so the app still works against a live server. Dev stays fullstack; production is static.
- **Arguments are the address.** Each call identity (function id + arguments) becomes one artifact under `_static/`. Both the build and the client derive the key from the arguments, so they must be JSON-safe and spell identically in both realms.
- **Results are unrestricted.** The artifact is the live answer: the build asks the app's own server-function endpoint for each call it captured and stores the response, headers included. Plain data, rich values (Dates, Maps, typed errors) and server components (`return props => <jsx/>`) all come back exactly as a live call would deliver them.
- **The reference is the runtime's own.** In a prerendered build the client still calls through Solid's transport, so hydration adopts server-rendered reads and server components without a request; only the send is answered from `_static/` (see [`staticFetch`](#staticfetchnext)).
- **Only calls the build made have artifacts.** In a static build, a client calling with arguments no prerendered page used gets a rejected call (there is no server). In a hybrid build the call falls back to the live server.

Design pages so the crawl exercises the calls the site needs — which happens naturally when pages link to what they use.

## `announceRoutes(router)`

The crawl follows links; a page nothing links to needs announcing. Call this in the app root during render with the `createRouter` instance (or a route-definition tree, with `{ base }`):

```tsx
import { announceRoutes } from "@solidjs/prerender";
import { Router } from "./router";

export default function App() {
  announceRoutes(Router);
  return <Router>{props => props.children}</Router>;
}
```

On the server, when the request is the crawler's, the router's static pages go on the response's hint header and the crawl seeds every one of them. A visitor's response is untouched; in the browser it is a no-op. Dynamic routes (`/posts/:id`) are not announced — only a render knows their values; the crawl finds them by their links. Options: `header` (a custom crawl `hintHeader`), `base`.

It takes either router Solid apps use. With TanStack Router the instance is built per request, so the call goes where the router is — the `start.setup` hook:

```ts
// src/setup.tsx
const router = createAppRouter(queryClient, history);
announceRoutes(router);
```

The enumerators behind it are exported too — `solidRouterPages(router | routes, { base? })` and `tanstackRouterPages(router)` — for code that wants the path list itself (a sitemap of its own, a hand-rolled `announcePages` call from `prerender-crawler/announce`). Both are pure: they read the router instance's public shape and import nothing from either router package.

## `serverFunctions(options?)`

The integration has two jobs.

**Capture.** For the crawl's duration every executed `prerendered` call is collected (the crawl is in-process, so the built server bundle and the integration share a realm), once per call identity. After the crawl each one's GET address is requested through the crawl's transport (`context.fetch`), and the endpoint's answer — status, headers, body — is emitted alongside the pages. Each captured call therefore runs once more at the end of the build.

**The guard.** `@solidjs/vite-plugin` records every server function the client build can dispatch. After the crawl, any of those ids nothing captured is a call a static deployment cannot answer — because the function lacks `prerendered()`, or because no prerendered page called it. In static mode the build fails naming each one:

```
[@solidjs/prerender] 1 server function(s) the client can call were never captured during prerendering:
  - getLiveCount (getLiveCount-1679f63b, src/data.ts)
A static deployment has no server to answer them, so these calls fail at runtime. ...
```

| Option       | Default                              |                                     |
| ------------ | ------------------------------------ | ----------------------------------- |
| `uncaptured` | `"error"` static / `"ignore"` hybrid | `"error"`, `"warn"`, or `"ignore"`. |

The guard needs a `@solidjs/vite-plugin` that records function ids in `.vite/solid-server-functions.json`; with an older version it warns that it cannot verify and lets the build through.

## Modes

- **`prerender({ mode: "static" })`** — SSG. Every page written, every `prerendered()` call baked, missing artifact is an error. Deploy `dist/client` to any static host.
- **`prerender({ mode: "hybrid" })`** — a live server is deployed too. Chosen calls are baked to static artifacts while everything else stays live; clients fetch artifacts first and fall back to the server. Pages aren't written by default (a static file would shadow live SSR).

The client learns the posture from `import.meta.env.PRERENDER_MODE`, which the crawler's Vite plugin defines. No plugin, no constant, live behavior.

## `staticFetch(next?)`

The transport `fetch` that answers prerendered calls from their artifacts. `prerendered()` installs it on its own in a prerendered build. An app that configures its own transport `fetch` must pass it through, or the artifacts are bypassed:

```ts
import { configureServerFunctionsClient } from "@solidjs/web/server-functions";
import { staticFetch } from "@solidjs/prerender";

configureServerFunctionsClient({ fetch: staticFetch(myFetch) });
```

Anything that is not a prerendered call's GET address goes to `next` untouched, and on the server it is `next` unchanged. A host answering a missing artifact with a 200 page (an SPA fallback, an SSR catch-all) is still a miss: artifacts are recognized by their first line, not by status.

## Other exports

- `solidRouterPages(router | routes, { base? })`, `tanstackRouterPages(router)` — the static-page enumerators behind `announceRoutes`, pure and isomorphic.
- `staticCallKey(id, args)` / `staticArtifactPath(id, args)` — the artifact key derivation (`_static/<label>.<key>.txt`), for tooling that needs to locate an artifact.
- Types: `PrerenderedFunction`, `AnnounceableRouter`, `AnnounceRoutesOptions`, `SolidRouterLike`, `SolidRouteLike`, `TanStackRouterLike`, `ServerFunctionsIntegration`, `ServerFunctionsIntegrationOptions`, `CaptureSink` (server).

## License

MIT
