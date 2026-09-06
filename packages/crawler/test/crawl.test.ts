import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPrerender } from "../src/crawl.ts";
import { redirects } from "../src/redirects.ts";
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

  describe("redirects", () => {
    const redirect = (location: string, status = 301) =>
      new Response(null, { status, headers: { location } });

    it("records each hop, crawls the destination as its own page, and stubs the old path to the chain's end", async () => {
      const { transport, requests } = site({
        "/oldest": redirect("/old", 301),
        "/old": redirect("/new", 302),
        "/new": html("landed")
      });
      const result = await runPrerender({
        transport,
        outDir: await makeOutDir(),
        pages: ["/oldest"],
        crawlLinks: false
      });

      expect(result.redirects).toEqual([
        { from: "/oldest", to: "/old", status: 301 },
        { from: "/old", to: "/new", status: 302 }
      ]);
      // the destination rendered once, at its own URL, discovered via the chain
      expect(requests.sort()).toEqual(["/new", "/old", "/oldest"]);
      expect(await readFile(join(outDir, "new/index.html"), "utf8")).toBe("landed");
      const landed = result.pages.find(p => p.path === "/new")!;
      expect(landed.redirect).toBeUndefined();
      expect(landed.referrers).toEqual(["/old"]);
      // both redirected paths stub straight to the FINAL destination
      for (const path of ["oldest", "old"]) {
        const stub = await readFile(join(outDir, `${path}/index.html`), "utf8");
        expect(stub).toContain('content="0; url=/new"');
        expect(stub).toContain('rel="canonical" href="/new"');
      }
      const oldest = result.pages.find(p => p.path === "/oldest")!;
      expect(oldest.redirect).toEqual({ from: "/oldest", to: "/old", status: 301 });
      expect(oldest.emitted).toBe(true);
    });

    it("stubs external redirects with the absolute target and does not crawl it", async () => {
      const { transport, requests } = site({
        "/gone": redirect("https://elsewhere.example/x?q=1&r=2", 302)
      });
      const result = await runPrerender({
        transport,
        outDir: await makeOutDir(),
        pages: ["/gone"],
        crawlLinks: false
      });
      expect(result.redirects).toEqual([
        { from: "/gone", to: "https://elsewhere.example/x?q=1&r=2", status: 302 }
      ]);
      expect(requests).toEqual(["/gone"]);
      const stub = await readFile(join(outDir, "gone/index.html"), "utf8");
      // attribute-escaped, so the query survives HTML parsing intact
      expect(stub).toContain('url=https://elsewhere.example/x?q=1&amp;r=2"');
    });

    it("follows a redirect to another spelling of the same page in place", async () => {
      // the trailing-slash canonicalization static file servers perform
      const { transport, requests } = site({
        "/posts": redirect("/posts/", 301),
        "/posts/": html("the posts")
      });
      const result = await runPrerender({
        transport,
        outDir: await makeOutDir(),
        pages: ["/posts"],
        crawlLinks: false
      });
      expect(requests).toEqual(["/posts", "/posts/"]);
      expect(result.redirects).toEqual([]);
      const page = result.pages.find(p => p.path === "/posts")!;
      expect(page.redirect).toBeUndefined();
      expect(await readFile(join(outDir, "posts/index.html"), "utf8")).toBe("the posts");
    });

    it("terminates redirect cycles", async () => {
      const { transport, requests } = site({
        "/a": redirect("/b", 302),
        "/b": redirect("/a", 302)
      });
      const result = await runPrerender({
        transport,
        outDir: await makeOutDir(),
        pages: ["/a"],
        crawlLinks: false,
        retries: 0
      });
      expect(requests.sort()).toEqual(["/a", "/b"]);
      expect(result.redirects).toHaveLength(2);
      // a cycle has no end; the stub points one hop on rather than hanging
      expect(await readFile(join(outDir, "a/index.html"), "utf8")).toContain("url=/b");
    });

    it("writes no stubs when asked, or when an integration handles redirects", async () => {
      const routes = { "/old": redirect("/new"), "/new": html("landed") };
      const explicit = await runPrerender({
        transport: site(routes).transport,
        outDir: await makeOutDir(),
        pages: ["/old"],
        crawlLinks: false,
        redirectStubs: false
      });
      expect(explicit.pages.find(p => p.path === "/old")!.emitted).toBe(false);
      expect(await readdir(outDir)).toEqual(["new"]);

      await rm(outDir, { recursive: true });
      const seen: string[] = [];
      const declared = await runPrerender({
        transport: site(routes).transport,
        outDir: await makeOutDir(),
        pages: ["/old"],
        crawlLinks: false,
        integrations: [
          {
            name: "rules",
            handlesRedirects: true,
            teardown(context) {
              seen.push(...context.redirects.map(r => `${r.from}>${r.to}`));
              // pages are complete by teardown, redirect pages included
              expect(context.pages.map(p => p.path).sort()).toEqual(["/new", "/old"]);
            }
          }
        ]
      });
      expect(seen).toEqual(["/old>/new"]);
      expect(declared.pages.find(p => p.path === "/old")!.emitted).toBe(false);
      expect(await readdir(outDir)).toEqual(["new"]);
    });

    it("the redirects() integration emits a _redirects rules file and suppresses stubs", async () => {
      const { transport } = site({
        "/b-old": redirect("/b", 301),
        "/a-old": redirect("https://elsewhere.example/", 302),
        "/b": html("b")
      });
      const result = await runPrerender({
        transport,
        outDir: await makeOutDir(),
        pages: ["/b-old", "/a-old"],
        crawlLinks: false,
        integrations: [redirects()]
      });
      expect(result.files).toEqual([
        {
          filename: "_redirects",
          contents: "/a-old https://elsewhere.example/ 302\n/b-old /b 301\n"
        }
      ]);
      expect((await readdir(outDir)).sort()).toEqual(["_redirects", "b"]);

      // Netlify's forced form and a custom filename
      const { transport: again } = site({ "/x": redirect("/y"), "/y": html("y") });
      const forced = await runPrerender({
        transport: again,
        outDir: await makeOutDir(),
        pages: ["/x"],
        crawlLinks: false,
        integrations: [redirects({ filename: "rules.txt", force: true })]
      });
      expect(forced.files[0]).toEqual({ filename: "rules.txt", contents: "/x /y 301!\n" });
    });

    it("the redirects() integration emits nothing when nothing redirected", async () => {
      const { transport } = site({ "/": html("home") });
      const result = await runPrerender({
        transport,
        outDir: await makeOutDir(),
        integrations: [redirects()]
      });
      expect(result.files).toEqual([]);
    });
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
    const broken = () => site({ "/": html(`<a href="/missing">m</a>`) });

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
    expect(await readdir(outDir, { recursive: true })).toEqual([
      "kept",
      join("kept", "index.html")
    ]);
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

  it("dedupes overlapping seed sources, first spelling wins", async () => {
    const { transport, requests } = site({ "/": html("index"), "/about": html("about") });
    const result = await runPrerender({
      transport,
      outDir: await makeOutDir(),
      pages: ["/", { path: "/about", filename: "custom.html" }, "/about/", "/"],
      crawlLinks: false
    });
    expect(requests.sort()).toEqual(["/", "/about"]);
    expect(result.pages.find(p => p.path === "/about")?.filename).toBe("custom.html");
  });

  it("records referrers for discovered pages and names them on failures", async () => {
    const { transport } = site({
      "/": html(`<a href="/about">a</a> <a href="/missing">m</a>`),
      "/about": html(`<a href="/missing">m again</a>`, {
        headers: { "x-prerender": "/hinted" }
      }),
      "/hinted": html("hinted")
    });
    const result = await runPrerender({
      transport,
      outDir: await makeOutDir(),
      retries: 0,
      failOnError: false
    });
    const byPath = Object.fromEntries(result.pages.map(p => [p.path, p.referrers]));
    expect(byPath["/"]).toEqual([]); // a seed came from nobody
    expect(byPath["/about"]).toEqual(["/"]);
    expect(byPath["/hinted"]).toEqual(["/about"]); // header hints count as links
    // the broken link is reported from every page that carries it — resolved
    // after the crawl settles, since /about may render after /missing failed
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].referrers.sort()).toEqual(["/", "/about"]);
    expect(String(result.skipped[0].error)).toMatch(/answered 404 \(linked from \//);

    // and the thrown form carries the same provenance, keeping the cause
    const broken = site({
      "/": html(`<a href="/boom">b</a>`),
      "/boom": () => {
        throw new Error("kaboom");
      }
    });
    await expect(
      runPrerender({ transport: broken.transport, outDir: await makeOutDir(), retries: 0 })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Prerendering \/boom failed \(linked from \/\): kaboom/),
      cause: expect.objectContaining({ message: "kaboom" })
    });
  });

  it("spaces request starts by the interval across all workers", async () => {
    const starts: number[] = [];
    const routes: Record<string, Answer> = { "/": html("index") };
    for (let i = 0; i < 5; i++) routes[`/p${i}`] = html("leaf");
    const base = site(routes);
    const transport: Transport = {
      fetch(request) {
        starts.push(performance.now());
        return base.transport.fetch(request);
      }
    };
    await runPrerender({
      transport,
      outDir: await makeOutDir(),
      pages: ["/", "/p0", "/p1", "/p2", "/p3", "/p4"],
      crawlLinks: false,
      concurrency: 4,
      interval: 20
    });
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) {
      // timers may fire a hair early; the gap must be essentially the interval
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(19);
    }
    expect(starts).toHaveLength(6);
  });

  it("keeps actual starts apart even when one runs late", async () => {
    // A busy event loop fires a claimed start's timer late; the NEXT claim's
    // on-time slot must not then land within the interval of that actual
    // late start. The first request blocks the loop past the second's slot.
    const starts: number[] = [];
    const base = site({ "/a": html("a"), "/b": html("b"), "/c": html("c") });
    const transport: Transport = {
      fetch(request) {
        starts.push(performance.now());
        if (starts.length === 1) {
          const until = performance.now() + 28;
          while (performance.now() < until) {
            /* the second start's timer (due at +20) fires ~8ms late */
          }
        }
        return base.transport.fetch(request);
      }
    };
    await runPrerender({
      transport,
      outDir: await makeOutDir(),
      pages: ["/a", "/b", "/c"],
      crawlLinks: false,
      concurrency: 3,
      interval: 20
    });
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(19);
    }
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
