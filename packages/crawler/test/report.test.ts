import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPrerender } from "../src/crawl.ts";
import { redirects } from "../src/redirects.ts";
import { report } from "../src/report.ts";
import type { PrerenderReport } from "../src/report.ts";
import type { Transport } from "../src/types.ts";

const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

function site(routes: Record<string, Response>) {
  const transport: Transport = {
    async fetch(request) {
      const answer = routes[new URL(request.url).pathname];
      return answer ? answer.clone() : new Response("not found", { status: 404 });
    }
  };
  return transport;
}

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("report()", () => {
  it("describes the run: pages, timings, referrers, redirects, skips, files", async () => {
    root = await mkdtemp(join(tmpdir(), "report-"));
    const outDir = join(root, "dist");
    const transport = site({
      "/": html(`<a href="/about">a</a> <a href="/old">o</a> <a href="/missing">m</a>`),
      "/about": html(`<a href="/missing">m</a>`),
      "/old": new Response(null, { status: 301, headers: { location: "/about" } })
    });
    await runPrerender({
      transport,
      outDir,
      mode: "hybrid",
      failOnError: false,
      integrations: [redirects(), report({ filename: "../prerender-report.json" })]
    });

    // written outside the deploy, as asked
    expect(await readdir(outDir)).toEqual(["_redirects"]);
    const summary: PrerenderReport = JSON.parse(
      await readFile(join(root, "prerender-report.json"), "utf8")
    );

    expect(summary.mode).toBe("hybrid");
    expect(summary.origin).toBe("http://localhost");
    expect(Date.parse(summary.generatedAt)).not.toBeNaN();
    expect(summary.totals).toEqual({
      pages: 3,
      written: 0,
      redirects: 1,
      skipped: 1,
      files: 1,
      duration: expect.any(Number)
    });
    expect(summary.pages.map(page => page.path)).toEqual(["/", "/about", "/old"]);
    const about = summary.pages[1];
    expect(about).toMatchObject({
      status: 200,
      contentType: "text/html; charset=utf-8",
      filename: "about/index.html",
      written: false,
      // the redirect from /old counts as a mention of /about
      referrers: ["/", "/old"]
    });
    expect(about.duration).toBeGreaterThanOrEqual(0);
    expect(about.redirect).toBeUndefined();
    expect(summary.pages[2]).toMatchObject({
      path: "/old",
      status: 301,
      redirect: { from: "/old", to: "/about", status: 301 }
    });
    expect(summary.redirects).toEqual([{ from: "/old", to: "/about", status: 301 }]);
    // the message names the referrers known at failure time; `referrers`
    // is completed once the crawl settles, so it is the authoritative list
    expect(summary.skipped).toEqual([
      {
        path: "/missing",
        error: expect.stringMatching(/^Prerendering \/missing answered 404 \(linked from \//),
        referrers: ["/", "/about"]
      }
    ]);
    expect(summary.files).toEqual(["_redirects"]);
  });

  it("lands in the output directory by default", async () => {
    root = await mkdtemp(join(tmpdir(), "report-"));
    await runPrerender({
      transport: site({ "/": html("index") }),
      outDir: root,
      integrations: [report()]
    });
    expect((await readdir(root)).sort()).toEqual(["index.html", "prerender-report.json"]);
  });
});
