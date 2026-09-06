import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { USAGE, main } from "../src/cli-main.ts";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) }
  };
}

let dir: string;
beforeAll(async () => (dir = await mkdtemp(join(tmpdir(), "prerender-cli-"))));
afterAll(() => rm(dir, { recursive: true, force: true }));
let outDir: string;
afterEach(async () => outDir && (await rm(outDir, { recursive: true, force: true })));

describe("cli", () => {
  it("prints usage and rejects missing arguments", async () => {
    const help = io();
    expect(await main(["--help"], help.io)).toBe(0);
    expect(help.out).toEqual([USAGE]);

    const noTarget = io();
    expect(await main(["--out", "x"], noTarget.io)).toBe(2);
    expect(noTarget.err[0]).toMatch(/Missing <target>/);

    const noOut = io();
    expect(await main(["./server.js"], noOut.io)).toBe(2);
    expect(noOut.err[0]).toMatch(/Missing --out/);

    const badFlag = io();
    expect(await main(["./server.js", "--out", "x", "--bogus"], badFlag.io)).toBe(2);
    expect(badFlag.err[0]).toMatch(/bogus/);

    const badMode = io();
    expect(await main(["./server.js", "--out", "x", "--mode", "fast"], badMode.io)).toBe(2);
    expect(badMode.err[0]).toMatch(/--mode must be/);
  });

  it("prerenders a module target in-process with the given options", async () => {
    const server = join(dir, "server.mjs");
    await writeFile(
      server,
      `export async function handleRequest(request) {
        const path = new URL(request.url).pathname;
        if (path === "/") return new Response('<a href="/about">a</a> <a href="/old">o</a>', { headers: { "content-type": "text/html" } });
        if (path === "/old") return new Response(null, { status: 301, headers: { location: "/about" } });
        if (path === "/about") return new Response("<h1>about</h1>", { headers: { "content-type": "text/html" } });
        return new Response("nope", { status: 404 });
      }`
    );
    outDir = join(dir, "out-module");
    const run = io();
    const code = await main([server, "--out", outDir, "--redirects", "--flat"], run.io);
    expect(run.err).toEqual([]);
    expect(code).toBe(0);
    expect(run.out[0]).toMatch(
      /rendered 3 page\(s\) \(2 written\), 1 redirect\(s\), 1 file\(s\) emitted/
    );
    expect((await readdir(outDir)).sort()).toEqual(["_redirects", "about.html", "index.html"]);
    expect(await readFile(join(outDir, "_redirects"), "utf8")).toBe("/old /about 301\n");
  });

  it("prerenders a running server over HTTP, minting requests under its origin", async () => {
    const hits: string[] = [];
    const server: Server = createServer((req, res) => {
      hits.push(req.url!);
      res.writeHead(200, { "content-type": "text/html" });
      // an ABSOLUTE link to this server counts as same-origin only if the
      // crawl origin is the target's — which the CLI arranges
      res.end(
        req.url === "/"
          ? `<a href="http://127.0.0.1:${(server.address() as { port: number }).port}/deep">d</a>`
          : "deep"
      );
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      outDir = join(dir, "out-http");
      const run = io();
      const code = await main(
        [`http://127.0.0.1:${port}`, "-o", outDir, "-p", "/", "--concurrency", "2"],
        run.io
      );
      expect(run.err).toEqual([]);
      expect(code).toBe(0);
      expect(hits.sort()).toEqual(["/", "/deep"]);
      expect(await readFile(join(outDir, "deep/index.html"), "utf8")).toBe("deep");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("fails with the engine's message, or skips with --continue", async () => {
    const server = join(dir, "broken.mjs");
    await writeFile(
      server,
      `export const fetch = async r => new URL(r.url).pathname === "/"
        ? new Response('<a href="/missing">m</a>', { headers: { "content-type": "text/html" } })
        : new Response("nope", { status: 404 });`
    );
    outDir = join(dir, "out-broken");
    const strict = io();
    expect(await main([server, "--out", outDir, "--retries", "0"], strict.io)).toBe(1);
    expect(strict.err[0]).toMatch(/\/missing answered 404 \(linked from \/\)/);

    const lenient = io();
    expect(await main([server, "--out", outDir, "--retries", "0", "--continue"], lenient.io)).toBe(
      0
    );
    expect(lenient.out[0]).toMatch(/rendered 1 page/);
    expect(lenient.err[0]).toMatch(/skipped \/missing/);
  });

  it("rejects a non-integer numeric option", async () => {
    const run = io();
    const server = join(dir, "ok.mjs");
    await writeFile(server, `export const fetch = async () => new Response("x");`);
    expect(await main([server, "--out", join(dir, "o"), "--concurrency", "two"], run.io)).toBe(1);
    expect(run.err[0]).toMatch(/non-negative integer/);
  });
});
