import { createRouter } from "@solidjs/router";
import { BaseRootRoute, BaseRoute, RouterCore } from "@tanstack/router-core";
import { describe, expect, it } from "vitest";
import { runPrerender } from "../src/crawl.ts";
import { announcePages, solidRouterPages, tanstackRouterPages } from "../src/routers.ts";
import type { Transport } from "../src/types.ts";

describe("tanstackRouterPages", () => {
  it("lists leaves and indexes of a real router, skipping params, splats, optionals and index-less layouts", () => {
    const root = new BaseRootRoute({});
    const child = (parent: any, options: Record<string, unknown>) =>
      new BaseRoute({ getParentRoute: () => parent, ...options } as any);
    const posts = child(root, { path: "/posts" });
    const docs = child(root, { path: "/docs" });
    const layout = child(root, { id: "_auth" });
    const tree = root.addChildren([
      child(root, { path: "/" }),
      child(root, { path: "/about" }),
      posts.addChildren([child(posts, { path: "/" }), child(posts, { path: "/$id" })]),
      docs.addChildren([child(docs, { path: "/$" })]),
      layout.addChildren([child(layout, { path: "/account" })]),
      child(root, { path: "/lang/{-$locale}" })
    ]);
    const router = new RouterCore({ routeTree: tree } as any);
    expect(tanstackRouterPages(router as any).sort()).toEqual([
      "/",
      "/about",
      "/account",
      "/posts"
    ]);
  });

  it("reads the documented shape without a router package", () => {
    expect(
      tanstackRouterPages({
        routesByPath: {
          "/": { fullPath: "/" },
          "/blog": { fullPath: "/blog/", children: [{}] },
          "/blog/$slug": { fullPath: "/blog/$slug" },
          "/team": { fullPath: "/team", children: { member: {} } }
        }
      })
    ).toEqual(["/", "/blog"]);
  });
});

describe("solidRouterPages", () => {
  const routes = [
    { path: "/", component: () => null },
    { path: "/about" },
    { path: "/posts", children: [{ path: "/" }, { path: "/:id" }, { path: "/:id/edit" }] },
    { path: "/docs", children: [{ path: "/*rest" }] },
    { children: [{ path: "/account" }, { path: "/settings/" }] }, // pathless layout
    { path: ["/help", "/faq"] }, // aliases
    { path: "/optional/:lang?" },
    { path: "/lazy", children: () => Promise.resolve([{ path: "/child" }]) }
  ];

  it("walks a real createRouter instance", () => {
    const Router = createRouter({ routes } as any);
    expect(solidRouterPages(Router).sort()).toEqual([
      "/",
      "/about",
      "/account",
      "/faq",
      "/help",
      "/posts",
      "/settings"
    ]);
  });

  it("accepts a bare tree with a base, and a single root definition", () => {
    expect(solidRouterPages(routes, { base: "/app" })).toContain("/app/posts");
    expect(solidRouterPages(routes, { base: "/app" })).not.toContain("/posts");
    expect(solidRouterPages({ path: "/", children: [{ path: "/" }, { path: "/x" }] })).toEqual([
      "/",
      "/x"
    ]);
  });

  it("uses the instance's configured base", () => {
    const Router = createRouter({ routes: [{ path: "/" }, { path: "/a" }], base: "/site" } as any);
    expect(solidRouterPages(Router).sort()).toEqual(["/site", "/site/a"]);
  });
});

describe("announcePages", () => {
  it("answers only the crawler's request, on the configured header", () => {
    const crawler = new Request("http://localhost/", { headers: { "x-prerender": "1" } });
    const visitor = new Request("http://localhost/");
    const headers = new Headers();

    expect(announcePages(visitor, headers, ["/a"])).toBe(false);
    expect(headers.has("x-prerender")).toBe(false);

    expect(announcePages(crawler, headers, ["/a", "/b"])).toBe(true);
    expect(headers.get("x-prerender")).toBe("/a,/b");

    expect(announcePages(crawler, new Headers(), [])).toBe(false);

    const custom = new Request("http://localhost/", { headers: { "x-pages": "1" } });
    const customHeaders = new Headers();
    expect(announcePages(custom, customHeaders, ["/a"], { header: "x-pages" })).toBe(true);
    expect(customHeaders.get("x-pages")).toBe("/a");
  });

  it("seeds a crawl end to end: the server announces its router's pages on the first response", async () => {
    const Router = createRouter({
      routes: [{ path: "/" }, { path: "/unlinked" }, { path: "/posts/:id" }]
    } as any);
    const fetched: string[] = [];
    const transport: Transport = {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        fetched.push(path);
        const headers = new Headers({ "content-type": "text/html" });
        announcePages(request, headers, solidRouterPages(Router));
        return new Response(`<h1>${path}</h1>`, { headers });
      }
    };
    const { mkdtemp, rm } = await import("node:fs/promises");
    const outDir = await mkdtemp("/tmp/routers-");
    try {
      const result = await runPrerender({ transport, outDir, emitPages: false });
      expect(result.pages.map(page => page.path).sort()).toEqual(["/", "/unlinked"]);
      expect(fetched.sort()).toEqual(["/", "/unlinked"]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
