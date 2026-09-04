import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPrerender } from "../src/crawl.ts";
import type { Transport } from "../src/types.ts";

type Answer = Response | (() => Response);

/** A canned-site transport: path -> Response. Records what was fetched. */
function site(routes: Record<string, Answer>) {
  const requests: string[] = [];
  let closed = false;
  const transport: Transport = {
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname);
      const answer = routes[url.pathname];
      if (!answer) return new Response("not found", { status: 404 });
      const response = typeof answer === "function" ? answer() : answer;
      return response.clone();
    },
    close() {
      closed = true;
    }
  };
  return { transport, requests, isClosed: () => closed };
}

const html = (body: string, init?: ResponseInit) =>
  new Response(body, {
    ...init,
    headers: { "content-type": "text/html", ...Object.fromEntries(new Headers(init?.headers)) }
  });

let outDir: string;
async function makeOutDir() {
  outDir = await mkdtemp(join(tmpdir(), "prerender-"));
  return outDir;
}

afterEach(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe("crawl", () => {
  it("renders seeds, discovers links, dedupes, and writes the conventional files", async () => {
    const { transport, requests, isClosed } = site({
      "/": html(`<a href="/about">a</a> <a href="/about">again</a>`),
      "/about": html(`<a href="/">home</a>`)
    });
    const result = await runPrerender({ transport, outDir: await makeOutDir() });

    expect(result.pages.map(p => p.path).sort()).toEqual(["/", "/about"]);
    // each page fetched exactly once despite mutual links
    expect(requests.sort()).toEqual(["/", "/about"]);
    expect(await readFile(join(outDir, "index.html"), "utf8")).toContain("/about");
    expect(await readFile(join(outDir, "about/index.html"), "utf8")).toContain("home");
    expect(isClosed()).toBe(true);
  });

  it("maps output names by convention: subfolder index, flat, and file paths verbatim", async () => {
    const { transport } = site({
      "/": html(`<a href="/blog/post">p</a> <a href="/sitemap.xml">s</a>`),
      "/blog/post": html("post"),
      "/sitemap.xml": new Response("<urlset/>", { headers: { "content-type": "text/xml" } })
    });
    await runPrerender({ transport, outDir: await makeOutDir() });
    expect(await readFile(join(outDir, "blog/post/index.html"), "utf8")).toBe("post");
    expect(await readFile(join(outDir, "sitemap.xml"), "utf8")).toBe("<urlset/>");

    const flat = site({ "/about": html("flat") });
    await runPrerender({
      transport: flat.transport,
      outDir: await makeOutDir(),
      pages: ["/about"],
      autoSubfolderIndex: false
    });
    expect(await readFile(join(outDir, "about.html"), "utf8")).toBe("flat");
  });

  it("honors explicit filenames on seed entries (the 404 convention)", async () => {
    const { transport } = site({ "/404": html("missing") });
    await runPrerender({
      transport,
      outDir: await makeOutDir(),
      pages: [{ path: "/404", filename: "404.html" }],
      crawlLinks: false
    });
    expect(await readFile(join(outDir, "404.html"), "utf8")).toBe("missing");
  });

  it("accepts an async pages source", async () => {
    const { transport } = site({ "/a": html("a") });
    const result = await runPrerender({
      transport,
      outDir: await makeOutDir(),
      pages: async () => ["/a"]
    });
    expect(result.pages.map(p => p.path)).toEqual(["/a"]);
  });

  it("discovers pages announced on the hint header", async () => {
    const { transport } = site({
      "/": html("index", { headers: { "x-prerender": "/hinted, /hinted-2" } }),
      "/hinted": html("h1"),
      "/hinted-2": html("h2")
    });
    const result = await runPrerender({ transport, outDir: await makeOutDir() });
    expect(result.pages.map(p => p.path).sort()).toEqual(["/", "/hinted", "/hinted-2"]);
  });

  it("marks its requests with the hint header so the app can detect prerendering", async () => {
    let seen: string | null = null;
    const transport: Transport = {
      async fetch(request) {
        seen = request.headers.get("x-prerender");
        return html("ok");
      }
    };
    await runPrerender({ transport, outDir: await makeOutDir(), crawlLinks: false });
    expect(seen).toBe("1");
  });

  it("applies the filter to discovered paths but not to explicit seeds", async () => {
    const { transport, requests } = site({
      "/admin": html(`<a href="/admin/secrets">s</a> <a href="/public">p</a>`),
      "/public": html("public")
    });
    const result = await runPrerender({
      transport,
      outDir: await makeOutDir(),
      pages: ["/admin"],
      filter: path => !path.startsWith("/admin")
    });
    expect(result.pages.map(p => p.path).sort()).toEqual(["/admin", "/public"]);
    expect(requests).not.toContain("/admin/secrets");
  });

  it("follows internal redirects and stubs external ones", async () => {
    const { transport } = site({
      "/moved": new Response(null, { status: 301, headers: { location: "/target" } }),
      "/target": html("landed"),
      "/gone": new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/x" }
      })
    });
    await runPrerender({
      transport,
      outDir: await makeOutDir(),
      pages: ["/moved", "/gone"],
      crawlLinks: false
    });
    // the internal chain landed and the ORIGINAL path holds the content
    expect(await readFile(join(outDir, "moved/index.html"), "utf8")).toBe("landed");
    // the external redirect became a meta-refresh stub
    const stub = await readFile(join(outDir, "gone/index.html"), "utf8");
    expect(stub).toContain('url=https://elsewhere.example/x');
  });

  it("bounds redirect chains", async () => {
    const { transport } = site({
      "/a": new Response(null, { status: 302, headers: { location: "/b" } }),
      "/b": new Response(null, { status: 302, headers: { location: "/a" } })
    });
    await expect(
      runPrerender({
        transport,
        outDir: await makeOutDir(),
        pages: ["/a"],
        crawlLinks: false,
        maxRedirects: 3,
        retries: 0
      })
    ).rejects.toThrow(/exceeded 3 hops/);
  });

  it("retries 5xx answers and succeeds when the page heals", async () => {
    let attempts = 0;
    const { transport } = site({
      "/flaky": () => (++attempts < 2 ? new Response(null, { status: 500 }) : html("healed"))
    });
    await runPrerender({
      transport,
      outDir: await makeOutDir(),
      pages: ["/flaky"],
      crawlLinks: false,
      retryDelay: 1
    });
    expect(attempts).toBe(2);
    expect(await readFile(join(outDir, "flaky/index.html"), "utf8")).toBe("healed");
  });

  it("fails the run on a broken page by default, or records it when opted out", async () => {
    const broken = () =>
      site({ "/": html(`<a href="/missing">m</a>`) });

    await expect(
      runPrerender({ transport: broken().transport, outDir: await makeOutDir(), retries: 0 })
    ).rejects.toThrow(/answered 404/);

    const result = await runPrerender({
      transport: broken().transport,
      outDir: await makeOutDir(),
      retries: 0,
      failOnError: false
    });
    expect(result.pages.map(p => p.path)).toEqual(["/"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].path).toBe("/missing");
  });

  it("writes integration-emitted files and runs setup/teardown around the crawl", async () => {
    const order: string[] = [];
    const { transport } = site({ "/": html("index") });
    const result = await runPrerender({
      transport,
      outDir: await makeOutDir(),
      onRendered: page => void order.push(`rendered:${page.path}`),
      integrations: [
        {
          name: "artifacts",
          setup(context) {
            order.push("setup");
            context.emitFile({ filename: "_static/a1.txt", contents: "artifact" });
          },
          teardown() {
            order.push("teardown");
          }
        }
      ]
    });
    expect(order).toEqual(["setup", "rendered:/", "teardown"]);
    expect(result.files).toHaveLength(1);
    expect(await readFile(join(outDir, "_static/a1.txt"), "utf8")).toBe("artifact");
  });

  it("renders without writing when emission is off, per-entry flags override", async () => {
    const { transport, requests } = site({
      "/": html(`<a href="/data-only">d</a>`),
      "/data-only": html("rendered but unwritten"),
      "/kept": html("written")
    });
    const result = await runPrerender({
      transport,
      outDir: await makeOutDir(),
      pages: ["/", { path: "/kept", emit: true }],
      emitPages: false
    });
    // everything rendered — discovery and execution are not emission
    expect(requests.sort()).toEqual(["/", "/data-only", "/kept"]);
    expect(result.pages.map(p => [p.path, p.emitted]).sort()).toEqual([
      ["/", false],
      ["/data-only", false],
      ["/kept", true]
    ]);
    // only the opted-in page left a file
    expect(await readdir(outDir, { recursive: true })).toEqual(["kept", join("kept", "index.html")]);
  });

  it("accepts a per-path emission predicate", async () => {
    const { transport } = site({
      "/": html(`<a href="/blog/post">p</a>`),
      "/blog/post": html("post")
    });
    const result = await runPrerender({
      transport,
      outDir: await makeOutDir(),
      emitPages: path => path.startsWith("/blog")
    });
    expect(result.pages.find(p => p.path === "/")?.emitted).toBe(false);
    expect(result.pages.find(p => p.path === "/blog/post")?.emitted).toBe(true);
    expect(await readFile(join(outDir, "blog/post/index.html"), "utf8")).toBe("post");
  });

  it("respects the concurrency bound", async () => {
    let active = 0;
    let peak = 0;
    const routes: Record<string, Answer> = {};
    const links = Array.from({ length: 12 }, (_, i) => `/p${i}`);
    routes["/"] = html(links.map(l => `<a href="${l}">x</a>`).join(""));
    for (const link of links) {
      routes[link] = html("leaf");
    }
    const base = site(routes);
    const transport: Transport = {
      async fetch(request) {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        const response = await base.transport.fetch(request);
        active--;
        return response;
      }
    };
    await runPrerender({ transport, outDir: await makeOutDir(), concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect((await readdir(outDir)).length).toBeGreaterThan(10);
  });
});
