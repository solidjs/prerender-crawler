import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { httpTransport, loadHandler, moduleTransport } from "../src/transports.ts";

/** A tiny HTTP site that echoes what it received, with one redirect. */
let server: Server;
let origin: string;
const received: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push({
      url: req.url!,
      method: req.method!,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]))
    });
    if (req.url === "/old") {
      res.writeHead(301, { location: "/new" }).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(`<p>${req.url}</p>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
afterEach(() => void received.splice(0));

describe("httpTransport", () => {
  it("re-addresses requests to the target, keeping path and query, and forwards headers", async () => {
    const transport = httpTransport(origin, { headers: { authorization: "Bearer t" } });
    const response = await transport.fetch(
      new Request("http://localhost/about?x=1", { headers: { "x-prerender": "1" } })
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>/about?x=1</p>");
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe("/about?x=1");
    expect(received[0]!.method).toBe("GET");
    expect(received[0]!.headers["x-prerender"]).toBe("1");
    expect(received[0]!.headers.authorization).toBe("Bearer t");
    // the target's host, not the crawl origin's
    expect(received[0]!.headers.host).toBe(new URL(origin).host);
  });

  it("hands redirects to the engine instead of following them", async () => {
    const response = await httpTransport(origin).fetch(new Request("http://localhost/old"));
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/new");
    expect(received.map(r => r.url)).toEqual(["/old"]);
  });

  it("accepts a custom fetch", async () => {
    const seen: string[] = [];
    const transport = httpTransport("https://example.test", {
      fetch: async request => {
        seen.push(request.url);
        return new Response("ok");
      }
    });
    await transport.fetch(new Request("http://localhost/x"));
    expect(seen).toEqual(["https://example.test/x"]);
  });
});

describe("moduleTransport", () => {
  let dir: string;
  beforeAll(async () => (dir = await mkdtemp(join(tmpdir(), "prerender-mod-"))));
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const write = async (name: string, source: string) => {
    const file = join(dir, name);
    await writeFile(file, source);
    return file;
  };

  it("loads handleRequest, fetch, or default.fetch", async () => {
    const shapes = {
      "a.mjs": `export function handleRequest(r) { return new Response("handleRequest " + new URL(r.url).pathname); }`,
      "b.mjs": `export const fetch = async r => new Response("fetch " + new URL(r.url).pathname);`,
      "c.mjs": `export default { fetch: r => new Response("default " + new URL(r.url).pathname) };`
    };
    for (const [name, source] of Object.entries(shapes)) {
      const transport = await moduleTransport(await write(name, source));
      const response = await transport.fetch(new Request("http://localhost/p"));
      expect(await response.text()).toBe(
        `${name === "a.mjs" ? "handleRequest" : name === "b.mjs" ? "fetch" : "default"} /p`
      );
    }
  });

  it("names the problem when the module is missing or exports no handler", async () => {
    await expect(loadHandler(join(dir, "nope.mjs"))).rejects.toThrow(/could not import/);
    const file = await write("empty.mjs", `export const x = 1;`);
    await expect(loadHandler(file)).rejects.toThrow(/exports none of handleRequest/);
  });
});
