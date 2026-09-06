import type { PrerenderIntegration, RenderedPage } from "./types.ts";

/**
 * The sitemap integration: every rendered page becomes a `<url>` entry.
 *
 * The crawl already knows the one thing a sitemap needs and a route
 * manifest cannot supply — which pages actually exist, dynamic segments
 * expanded — so the integration is a formatter over `context.pages`.
 * Pages are dropped when they are redirects, are not HTML, carry a query
 * (a static host cannot serve them, see `keepQuery`), or ask not to be
 * indexed (`<meta name="robots" content="noindex">` or an `X-Robots-Tag`
 * header) — the same signals a search engine would honor on the live site.
 */

export type SitemapChangeFrequency =
  "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";

export interface SitemapEntry {
  /** Absolute URL of the page. */
  loc: string;
  /** Last-modification date, as a `Date` or an already-formatted W3C datetime. */
  lastmod?: Date | string;
  changefreq?: SitemapChangeFrequency;
  /** 0.0 – 1.0 */
  priority?: number;
}

export interface SitemapIntegrationOptions {
  /**
   * The site's public origin — `https://example.com`. Sitemap entries are
   * absolute URLs, and the crawl only knows the loopback origin it
   * rendered against.
   */
  hostname: string;
  /** @default "sitemap.xml" */
  filename?: string;
  /**
   * Spell entries with a trailing slash (`/about/`) — for hosts that
   * canonicalize that way. The root is `/` either way.
   * @default false
   */
  trailingSlash?: boolean;
  /**
   * Which pages are listed. Runs after the built-in exclusions (redirects,
   * non-HTML, query spellings, `noindex`); return false to drop more.
   */
  filter?(page: RenderedPage): boolean;
  /**
   * Per-page metadata — `lastmod`, `changefreq`, `priority` — or a
   * replacement `loc`. Return nothing to list the page with its URL alone.
   */
  entry?(page: RenderedPage): Partial<SitemapEntry> | void;
}

export function sitemap(options: SitemapIntegrationOptions): PrerenderIntegration {
  const { filename = "sitemap.xml", trailingSlash = false, filter, entry } = options;
  if (!options.hostname) {
    throw new Error("sitemap(): `hostname` is required — entries must be absolute URLs");
  }
  const hostname = new URL(options.hostname);
  return {
    name: "sitemap",
    teardown(context) {
      const entries: SitemapEntry[] = [];
      for (const page of context.pages) {
        if (!indexable(page) || (filter && !filter(page))) continue;
        const path = trailingSlash && page.path !== "/" ? `${page.path}/` : page.path;
        entries.push({ loc: new URL(path, hostname).href, ...entry?.(page) });
      }
      entries.sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
      context.emitFile({ filename, contents: formatSitemap(entries) });
    }
  };
}

/**
 * Whether a rendered page belongs in a sitemap by the signals the page
 * itself gives: an HTML document, not a redirect, not a query spelling,
 * not marked `noindex`.
 */
export function indexable(page: RenderedPage): boolean {
  if (page.redirect || page.path.includes("?")) return false;
  if (!(page.response.headers.get("content-type") ?? "").includes("text/html")) return false;
  if (/\bnoindex\b/i.test(page.response.headers.get("x-robots-tag") ?? "")) return false;
  return !robotsMeta(page.html).some(content => /\bnoindex\b/i.test(content));
}

const META_PATTERN = /<meta\s[^>]*>/gi;
const ATTRIBUTE = (name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
const NAME = ATTRIBUTE("name");
const CONTENT = ATTRIBUTE("content");

/** The `content` of every `<meta name="robots">` in the document's head, any attribute order. */
function robotsMeta(html: string): string[] {
  const head = html.slice(0, headEnd(html));
  const found: string[] = [];
  for (const [tag] of head.matchAll(META_PATTERN)) {
    const name = NAME.exec(tag);
    if (!name || (name[1] ?? name[2] ?? name[3]).trim().toLowerCase() !== "robots") continue;
    const content = CONTENT.exec(tag);
    if (content) found.push(content[1] ?? content[2] ?? content[3]);
  }
  return found;
}

function headEnd(html: string): number {
  const at = html.search(/<\/head\s*>|<body\b/i);
  return at === -1 ? html.length : at;
}

export function formatSitemap(entries: readonly SitemapEntry[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  lines.push('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  for (const entry of entries) {
    lines.push("  <url>");
    lines.push(`    <loc>${escapeXml(entry.loc)}</loc>`);
    if (entry.lastmod !== undefined) {
      const lastmod =
        entry.lastmod instanceof Date ? entry.lastmod.toISOString() : String(entry.lastmod);
      lines.push(`    <lastmod>${escapeXml(lastmod)}</lastmod>`);
    }
    if (entry.changefreq) lines.push(`    <changefreq>${entry.changefreq}</changefreq>`);
    if (entry.priority !== undefined) {
      lines.push(`    <priority>${clampPriority(entry.priority)}</priority>`);
    }
    lines.push("  </url>");
  }
  lines.push("</urlset>");
  return lines.join("\n") + "\n";
}

function clampPriority(priority: number): string {
  return Math.min(1, Math.max(0, priority)).toFixed(1);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
