/**
 * Router helpers: which of a router's routes are static pages.
 *
 * The crawl finds pages by following links and by reading the hint header
 * (`x-prerender`) off responses. A route nothing links to is invisible to
 * the first; the second is how a server that KNOWS its routes declares
 * them — and the thing that knows the routes is the router the app built
 * for the request. So each helper here takes a router (or its route tree)
 * and returns the paths that address a static page: no parameters, no
 * splats, a leaf or an index. The app puts them on the hint header of its
 * response with `announcePages`, and every crawl — the Vite plugin, the
 * CLI against a built module, the CLI against a running server — seeds
 * from the answer.
 *
 * Nothing here imports a router package: each helper is typed against the
 * subset of the router's public shape it reads.
 *
 * This module is imported by application SERVER code, so it stays free of
 * Node imports.
 */

/** The hint header the engine reads, and the request header it sends. */
export const HINT_HEADER = "x-prerender";

export interface AnnounceOptions {
  /** The header name, if the crawl was configured with a custom `hintHeader`. @default "x-prerender" */
  header?: string;
}

/**
 * Puts `paths` on the response's hint header — when the request is the
 * crawler's (it carries the hint header). Returns whether it did. A
 * regular visitor's response is left untouched.
 *
 * ```ts
 * announcePages(event.request, event.response.headers, solidRouterPages(Router));
 * ```
 */
export function announcePages(
  request: Request,
  headers: Headers,
  paths: readonly string[],
  options: AnnounceOptions = {}
): boolean {
  const { header = HINT_HEADER } = options;
  if (!request.headers.has(header) || paths.length === 0) return false;
  headers.set(header, paths.join(","));
  return true;
}

// ---------------------------------------------------------------------------
// TanStack Router (@tanstack/react-router, solid-router, vue-router — one core)

/** The subset of a TanStack `Router` instance this reads. */
export interface TanStackRouterLike {
  /**
   * Every route with a path, keyed by full path with the trailing slash
   * trimmed; where a layout and its index share a path the index wins.
   * Public on the router instance, built by `@tanstack/router-core`.
   */
  routesByPath: Record<string, TanStackRouteLike>;
}

export interface TanStackRouteLike {
  /** The route's full path — an index route's ends with `/`. */
  fullPath: string;
  children?: unknown;
}

/**
 * The static pages of a TanStack Router instance. A route is a page when
 * its path has no `$` segment (params `$id`, splats `$`, optional params
 * `{-$id}`) and it is a leaf or an index — a layout route with children
 * but no index has no page of its own (its URL renders not-found).
 *
 * The router must be a built instance (`createRouter({ routeTree })`): the
 * generated `routeTree` alone has no full paths until the router
 * initializes it.
 */
export function tanstackRouterPages(router: TanStackRouterLike): string[] {
  const paths = new Set<string>();
  for (const [path, route] of Object.entries(router.routesByPath)) {
    if (path.split("/").some(segment => segment.includes("$"))) continue;
    const isIndex = route.fullPath.endsWith("/");
    const isLeaf = !hasChildren(route.children);
    if (!isIndex && !isLeaf) continue;
    paths.add(normalize(path));
  }
  return [...paths];
}

// ---------------------------------------------------------------------------
// Solid Router (@solidjs/router 2)

/** The subset of a Solid Router `RouteDefinition` this reads. */
export interface SolidRouteLike {
  /** A pattern, or several — aliases for one route. Absent on a pathless layout. */
  path?: string | readonly string[];
  /**
   * Nested routes, or a thunk producing them lazily. Lazy children are not
   * enumerated — that would load modules during a render; the crawl finds
   * those pages by their links.
   */
  children?: SolidRouteLike | readonly SolidRouteLike[] | ((...args: never[]) => unknown);
}

/** The subset of a Solid Router `createRouter` instance this reads. */
export interface SolidRouterLike {
  readonly routes: SolidRouteLike | readonly SolidRouteLike[];
  readonly config?: { base?: string };
}

export interface SolidRouterPagesOptions {
  /** The app's base path, when the tree is passed without its router. */
  base?: string;
}

/**
 * The static pages of a Solid Router instance (or a route-definition tree).
 * Paths join root to leaf; a route is a page when it is a leaf — a parent
 * with children has a page only through an index child (`""` or `"/"`) —
 * and its joined path has no `:param`, optional `:param?`, or `*splat`
 * segment. Pathless layouts join through; each alias in a `path` array is
 * its own page.
 */
export function solidRouterPages(
  router: SolidRouterLike | SolidRouteLike | readonly SolidRouteLike[],
  options: SolidRouterPagesOptions = {}
): string[] {
  const instance = isSolidRouter(router) ? router : undefined;
  const routes = instance
    ? instance.routes
    : (router as SolidRouteLike | readonly SolidRouteLike[]);
  const base = options.base ?? instance?.config?.base ?? "";
  const paths = new Set<string>();
  const walk = (route: SolidRouteLike, prefix: string) => {
    const own = route.path === undefined ? [""] : ([] as string[]).concat(route.path);
    for (const pattern of own) {
      const full = join(prefix, pattern);
      const children = route.children;
      if (children === undefined) {
        if (!isDynamic(full)) paths.add(normalize(full));
        continue;
      }
      if (typeof children === "function") continue; // lazy subtree: found by links
      for (const child of ([] as SolidRouteLike[]).concat(children as any)) walk(child, full);
    }
  };
  for (const route of ([] as SolidRouteLike[]).concat(routes as any)) walk(route, base);
  return [...paths];
}

// a `createRouter` instance is the provider component with `routes` on it;
// a route definition never has a `routes` key
function isSolidRouter(value: unknown): value is SolidRouterLike {
  if (value === null || Array.isArray(value)) return false;
  return (typeof value === "function" || typeof value === "object") && "routes" in value;
}

const isDynamic = (path: string) =>
  path.split("/").some(segment => segment.startsWith(":") || segment.startsWith("*"));

function hasChildren(children: unknown): boolean {
  if (children === undefined || children === null) return false;
  if (Array.isArray(children)) return children.length > 0;
  return typeof children === "object" ? Object.keys(children).length > 0 : true;
}

function join(prefix: string, path: string): string {
  const left = prefix.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "");
  return right ? `${left}/${right}` : left || "/";
}

/** One spelling per page, matching the engine's: no trailing slash except the root. */
function normalize(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
