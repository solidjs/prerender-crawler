# prerender

Build-time prerendering for fetch-shaped apps, and Solid's integration on top of it.

| Package                                   | What it is                                                                                                                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`prerender-crawler`](./packages/crawler) | Framework-agnostic engine + Vite plugin. Crawls a `Request -> Response` handler at build time and writes the site out as static files.                                           |
| [`@solidjs/prerender`](./packages/solid)  | Solid's piece: `prerendered()` turns server functions into build-time data captured as static artifacts; `serverFunctions()` plugs that into the crawl and guards static builds. |

```ts
// vite.config.ts
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

`vite build` renders every page through the server build, follows links to find the rest, bakes each `prerendered()` server-function call into a JSON artifact, and leaves `dist/client` as the whole deployment — a Solid app with typed server-side data loading and no server.

See [`examples/ssg`](./examples/ssg) for a complete site.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Releases use [Changesets](https://github.com/changesets/changesets): add one under `.changeset/` with any consumer-visible change.

## License

[MIT](./LICENSE)
