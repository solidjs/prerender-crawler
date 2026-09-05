// Route-manifest seeding: the static pages a file-system router declares
// are known before anything renders, so they seed the crawl directly —
// a page nothing links to still gets built, and the crawl starts wide
// instead of unwinding from `/`. Dynamic routes (`/posts/:slug`,
// `/*404`) are left to link discovery: only a render knows their values.
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface FileRoutePagesOptions {
  /** Project root the route dir resolves against. @default process.cwd() */
  root?: string;
  /** Route directory, mirroring `fileRoutes({ dir })`. @default "src/routes" */
  dir?: string;
  /** Route file extensions, mirroring `fileRoutes({ extensions })`. @default ["js", "jsx", "ts", "tsx"] */
  extensions?: string[];
}

/** The subset of a `filesystem-routing` manifest entry this module reads. */
export interface RouteEntryLike {
  path: string;
  page?: boolean;
}

/**
 * The statically addressable page paths of a route manifest: pages whose
 * path has no parameter or catch-all segment, with `(group)` segments
 * stripped the way emission adapters strip them. Pure — the seam the
 * plugin and tests share.
 */
export function staticRoutePaths(entries: readonly RouteEntryLike[]): string[] {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!entry.page) continue;
    const segments = entry.path.split("/").filter(segment => segment !== "");
    if (segments.some(segment => segment.startsWith(":") || segment.startsWith("*"))) continue;
    const concrete = segments.filter(segment => !/^\(.*\)$/.test(segment));
    paths.add("/" + concrete.join("/"));
  }
  return [...paths];
}

/**
 * A `pages` source scanning a `filesystem-routing` route directory for its
 * static pages. The package is resolved from the project root (it is the
 * APP's dependency), loaded lazily so projects without it pay nothing.
 *
 * ```ts
 * prerender({ pages: fileRoutePages({ dir: "src/pages" }) })
 * ```
 *
 * The `prerender()` plugin applies this automatically (`fileRoutes: true`,
 * the default) when the package and the route directory exist.
 */
export function fileRoutePages(options: FileRoutePagesOptions = {}): () => Promise<string[]> {
  const root = options.root ?? process.cwd();
  const dir = path.resolve(root, options.dir ?? "src/routes");
  const extensions = options.extensions ?? ["js", "jsx", "ts", "tsx"];
  return async () => {
    const routing = await loadFileSystemRouting(root);
    const router = new routing.PageFileSystemRouter({ dir, extensions });
    return staticRoutePaths(await router.getRoutes());
  };
}

interface FileSystemRoutingModule {
  PageFileSystemRouter: new (config: { dir: string; extensions: string[] }) => {
    getRoutes(): Promise<RouteEntryLike[]>;
  };
}

/** Whether `filesystem-routing` resolves from the project (for the plugin's auto mode). */
export function hasFileSystemRouting(root: string): boolean {
  try {
    resolveFileSystemRouting(root);
    return true;
  } catch {
    return false;
  }
}

function resolveFileSystemRouting(root: string): string {
  // from the project first (the app's copy), then from here (a test or a
  // setup that installed it alongside the plugin)
  for (const from of [path.join(root, "package.json"), import.meta.url]) {
    try {
      return createRequire(from).resolve("filesystem-routing");
    } catch {
      // try the next base
    }
  }
  throw new Error(
    `fileRoutePages needs the "filesystem-routing" package, which could not be resolved from ${root}.`
  );
}

async function loadFileSystemRouting(root: string): Promise<FileSystemRoutingModule> {
  const resolved = resolveFileSystemRouting(root);
  return (await import(pathToFileURL(resolved).href)) as FileSystemRoutingModule;
}
