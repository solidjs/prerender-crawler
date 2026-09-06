import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPrerender } from "../src/crawl.ts";
import { formatSitemap, indexable, sitemap } from "../src/sitemap.ts";
import type { RenderedPage, Transport } from "../src/types.ts";

const html = (body: string, init?: ResponseInit) =>
  new Response(body, {
    ...init,
    headers: { "content-type": "text/html", ...Object.fromEntries(new Headers(init?.headers)) }
  });

function site(routes: Record<string, Response>) {
  const transport: Transport = {
    async fetch(request) {
      const answer = routes[new URL(request.url).pathname];
      return answer ? answer.clone() : new Response("not found", { status: 404 });
    }
  };
  return transport;
}

let outDir: string;
afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const page = (html: string, init?: ResponseInit, path = "/x"): RenderedPage => ({
  path,
  referrers: [],
  filename: "x/index.html",
  emitted: true,
  response: new Response(html, {
    ...init,
    headers: { "content-type": "text/html", ...Object.fromEntries(new Headers(init?.headers)) }
  }),
  duration: 1,
  html
});

describe("sitemap()", () => {
  it("lists every indexable rendered page as an absolute, sorted entry", async () => {
    outDir = await mkdtemp(join(tmpdir(), "sitemap-"));
    const transport = site({
      "/": html(
        `<a href="/b">b</a> <a href="/a">a</a> <a href="/old">o</a> <a href="/feed.xml">f</a> <a href="/secret">s</a>`
      ),
      "/a": html("a"),
      "/b": html("b"),
      "/old": new Response(null, { status: 301, headers: { location: "/a" } }),
      "/feed.xml": new Response("<rss/>", { headers: { "content-type": "application/xml" } }),
      "/secret": html(`<html><head><meta content="noindex, follow" name="robots"></head></html>`)
    });
    const result = await runPrerender({
      transport,
      outDir,
      integrations: [sitemap({ hostname: "https://example.com" })]
    });
    expect(result.files.map(file => file.filename)).toEqual(["sitemap.xml"]);
    expect(await readFile(join(outDir, "sitemap.xml"), "utf8")).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
  </url>
  <url>
    <loc>https://example.com/a</loc>
  </url>
  <url>
    <loc>https://example.com/b</loc>
  </url>
</urlset>
`
    );
  });

  it("applies the filter, per-page metadata, trailing slashes and a custom filename", async () => {
    outDir = await mkdtemp(join(tmpdir(), "sitemap-"));
    const transport = site({
      "/": html(`<a href="/about">a</a> <a href="/draft">d</a>`),
      "/about": html("about"),
      "/draft": html("draft")
    });
    await runPrerender({
      transport,
      outDir,
      integrations: [
        sitemap({
          hostname: "https://example.com/",
          filename: "seo/sitemap.xml",
          trailingSlash: true,
          filter: page => page.path !== "/draft",
          entry: page =>
            page.path === "/"
              ? { priority: 1, changefreq: "daily", lastmod: new Date("2026-01-02T03:04:05Z") }
              : { lastmod: "2026-01-01" }
        })
      ]
    });
    const xml = await readFile(join(outDir, "seo/sitemap.xml"), "utf8");
    expect(xml).toContain(
      "<loc>https://example.com/</loc>\n    <lastmod>2026-01-02T03:04:05.000Z</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>"
    );
    expect(xml).toContain(
      "<loc>https://example.com/about/</loc>\n    <lastmod>2026-01-01</lastmod>"
    );
    expect(xml).not.toContain("draft");
  });

  it("requires a hostname", () => {
    expect(() => sitemap({ hostname: "" })).toThrow(/hostname/);
  });
});

describe("indexable", () => {
  it("honors robots meta in any attribute order and the X-Robots-Tag header, head only", () => {
    expect(indexable(page(`<head><meta name="robots" content="noindex"></head>`))).toBe(false);
    expect(indexable(page(`<head><meta content='NOINDEX' name='robots'></head>`))).toBe(false);
    expect(indexable(page(`<head><meta name=robots content=noindex></head>`))).toBe(false);
    expect(indexable(page(`<head><meta name="robots" content="index, follow"></head>`))).toBe(true);
    expect(indexable(page(`<head><meta name="googlebot" content="noindex"></head>`))).toBe(true);
    // a meta in the body is not a directive (and the text "noindex" certainly is not)
    expect(
      indexable(page(`<head></head><body>noindex <meta name="robots" content="noindex"></body>`))
    ).toBe(true);
    expect(indexable(page("ok", { headers: { "x-robots-tag": "noindex, nofollow" } }))).toBe(false);
  });

  it("drops redirects, non-HTML responses and query spellings", () => {
    expect(indexable({ ...page("x"), redirect: { from: "/x", to: "/y", status: 301 } })).toBe(
      false
    );
    expect(indexable(page("x", undefined, "/x?page=2"))).toBe(false);
    const json = page("{}");
    json.response.headers.set("content-type", "application/json");
    expect(indexable(json)).toBe(false);
  });
});

describe("formatSitemap", () => {
  it("escapes locs and clamps priorities", () => {
    expect(formatSitemap([{ loc: "https://e.com/a?b=1&c=<2>", priority: 7 }])).toContain(
      "<loc>https://e.com/a?b=1&amp;c=&lt;2&gt;</loc>\n    <priority>1.0</priority>"
    );
  });
});
