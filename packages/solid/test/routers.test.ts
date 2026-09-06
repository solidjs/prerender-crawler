// The router enumerators against REAL router instances — a
// @tanstack/router-core RouterCore and a @solidjs/router createRouter — so
// drift in either package's public shape breaks here, not in a user's build.
import { createRouter } from "@solidjs/router";
import { BaseRootRoute, BaseRoute, RouterCore } from "@tanstack/router-core";
import { describe, expect, it } from "vitest";
import { solidRouterPages, tanstackRouterPages } from "../src/routers.ts";

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
    // the framework wrappers supply the store config; the path index does not depend on it
    const router = new (RouterCore as any)({ routeTree: tree });
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
