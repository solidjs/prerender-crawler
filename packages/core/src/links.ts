/**
 * Link discovery: which hrefs in a rendered page name more pages of this
 * site. The rules here are correctness fixes other prerenderers earned one
 * bug report at a time — resolve relative hrefs against the PAGE's URL
 * (not the origin), honor <base href>, strip queries and fragments before
 * dedupe, and never leave the origin.
 */

const LINK_PATTERN = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gis;
const BASE_PATTERN = /<base\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/is;

/** Schemes that are never pages. */
const NON_PAGE_SCHEME = /^(?:mailto|tel|javascript|data|blob|about):/i;

/**
 * Extracts the crawlable same-origin route paths from a page's HTML.
 * Returned paths are normalized (`/about`, no query, no fragment, no
 * trailing slash except the root) and deduped.
 */
export function extractLinks(html: string, pageUrl: URL): string[] {
  // <base href> shifts what relative hrefs resolve against, exactly as the
  // browser would resolve them.
  const baseMatch = BASE_PATTERN.exec(html);
  let base = pageUrl;
  if (baseMatch) {
    const href = baseMatch[1] ?? baseMatch[2] ?? "";
    try {
      base = new URL(href, pageUrl);
    } catch {
      // an unparseable <base> is ignored, like a browser ignores it
    }
  }

  const found = new Set<string>();
  for (const match of html.matchAll(LINK_PATTERN)) {
    const href = (match[1] ?? match[2] ?? "").trim();
    if (!href || NON_PAGE_SCHEME.test(href)) continue;
    const path = normalizeLink(href, base, pageUrl.origin);
    if (path !== undefined) found.add(path);
  }
  return [...found];
}

/**
 * Resolves one href to a normalized same-origin path, or undefined when it
 * is not a page of this site (foreign origin, unparseable).
 */
export function normalizeLink(href: string, base: URL, origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return undefined;
  }
  if (url.origin !== origin) return undefined;
  return normalizePath(url.pathname);
}

/**
 * One spelling per page: query and fragment never reach here (URL parsing
 * split them off), the trailing slash is dropped (except the root), and
 * percent-encoding is left exactly as the URL parser produced it.
 */
export function normalizePath(pathname: string): string {
  if (pathname === "" || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}
