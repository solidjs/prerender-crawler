import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileRoutePages, hasFileSystemRouting, staticRoutePaths } from "../src/file-routes.ts";

// filesystem-routing is an optional peer resolved from the PROJECT root at
// runtime; here it is this package's devDependency, reached by the fallback.

describe("staticRoutePaths", () => {
  it("keeps concrete pages, drops dynamic ones, strips groups, dedupes", () => {
    const paths = staticRoutePaths([
      { path: "/", page: true },
      { path: "/about", page: true },
      { path: "/posts", page: true },
      { path: "/posts/:slug", page: true },
      { path: "/docs/:version?", page: true },
      { path: "/*404", page: true },
      { path: "/(marketing)/pricing", page: true },
      { path: "/(marketing)", page: true },
      { path: "/api/users" }, // a handler-only route is not a page
      { path: "/about", page: true }
    ]);
    expect(paths).toEqual(["/", "/about", "/posts", "/pricing"]);
  });
});

describe("fileRoutePages", () => {
  let root: string;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("scans a route directory for its static pages", async () => {
    root = await mkdtemp(join(tmpdir(), "prerender-routes-"));
    const routes = join(root, "src/routes");
    await mkdir(join(routes, "posts"), { recursive: true });
    await mkdir(join(routes, "(group)"), { recursive: true });
    const page = "export default function Page() { return null; }\n";
    await writeFile(join(routes, "index.tsx"), page);
    await writeFile(join(routes, "about.tsx"), page);
    await writeFile(join(routes, "posts.tsx"), page);
    await writeFile(join(routes, "posts/index.tsx"), page);
    await writeFile(join(routes, "posts/[slug].tsx"), page);
    await writeFile(join(routes, "[...404].tsx"), page);
    await writeFile(join(routes, "(group)/pricing.tsx"), page);
    await writeFile(join(routes, "helpers.ts"), "export const notARoute = 1;\n");

    // the temp root has no node_modules; resolution falls back to the
    // package installed alongside this module
    const pages = await fileRoutePages({ root })();
    expect(pages.sort()).toEqual(["/", "/about", "/posts", "/pricing"]);
  });

  it("honors dir and extensions", async () => {
    root = await mkdtemp(join(tmpdir(), "prerender-routes-"));
    const routes = join(root, "pages");
    await mkdir(routes, { recursive: true });
    await writeFile(join(routes, "index.jsx"), "export default () => null;\n");
    await writeFile(join(routes, "skipped.tsx"), "export default () => null;\n");
    const pages = await fileRoutePages({ root, dir: "pages", extensions: ["jsx"] })();
    expect(pages).toEqual(["/"]);
  });

  it("reports whether the package resolves (from the project, or from here)", () => {
    expect(hasFileSystemRouting(process.cwd())).toBe(true);
  });
});
