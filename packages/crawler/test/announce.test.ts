import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { announcePages } from "../src/announce.ts";
import { runPrerender } from "../src/crawl.ts";
import type { Transport } from "../src/types.ts";

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

  it("seeds a crawl end to end: the server announces its pages on the first response", async () => {
    const fetched: string[] = [];
    const transport: Transport = {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        fetched.push(path);
        const headers = new Headers({ "content-type": "text/html" });
        announcePages(request, headers, ["/", "/unlinked"]);
        return new Response(`<h1>${path}</h1>`, { headers });
      }
    };
    const outDir = await mkdtemp(join(tmpdir(), "announce-"));
    try {
      const result = await runPrerender({ transport, outDir, emitPages: false });
      expect(result.pages.map(page => page.path).sort()).toEqual(["/", "/unlinked"]);
      expect(fetched.sort()).toEqual(["/", "/unlinked"]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
