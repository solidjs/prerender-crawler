// The full prerendered-function story, without Vite: the server half
// captures during a real prerender-core crawl (through the capture
// integration the plugin installs), artifacts land on disk, and the client
// half — flipped to the static posture — reads them back, rich types
// included.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPrerender } from "prerender-core";
import {
  createServerReference as createServerSideReference,
  getServerFunctionMetadata,
  registerServerReference
} from "@solidjs/web/server-functions/server";
import { createServerReference as createClientReference } from "@solidjs/web/server-functions/client";
import { createRequestEvent } from "@solidjs/web";
import { provideRequestEvent } from "@solidjs/web/storage";
import { prerendered as prerenderedServer } from "../src/server.ts";
import { prerendered as prerenderedClient } from "../src/client.ts";
import { createCaptureIntegration } from "../src/vite.ts";
import { CAPTURE_SINK, staticArtifactPath } from "../src/shared.ts";
import { env } from "../src/env.ts";

let ids = 0;
const nextId = (label: string) => `test/prerendered.ts#${label}${ids++}`;

/** Runs `body` inside a request-event scope, the way SSR would. */
const withEvent = <T>(body: () => T): T =>
  provideRequestEvent(createRequestEvent(new Request("http://localhost/")), body);

const declare = <A extends readonly unknown[], R>(id: string, fn: (...args: A) => R) =>
  prerenderedServer(createServerSideReference(registerServerReference(id, fn)));

const globals = globalThis as { [CAPTURE_SINK]?: unknown };

afterEach(() => {
  delete globals[CAPTURE_SINK];
  vi.unstubAllGlobals();
});

describe("prerendered (server half)", () => {
  it("is call-through without a sink; with one, delivers identity + settled value", async () => {
    const id = nextId("team");
    const getTeam = declare(id, async (dept: string) => ({ dept, size: 3 }));

    expect(await withEvent(() => getTeam("eng"))).toEqual({ dept: "eng", size: 3 });

    const captured: unknown[][] = [];
    globals[CAPTURE_SINK] = { capture: (...entry: unknown[]) => void captured.push(entry) };
    await withEvent(() => getTeam("design"));
    expect(captured).toEqual([[id, ["design"], { dept: "design", size: 3 }]]);
  });

  it("awaits the sink before returning, and captures nothing for thrown calls", async () => {
    const fn = declare(nextId("flaky"), async (fail: boolean) => {
      if (fail) throw new Error("nope");
      return "ok";
    });

    let settled = false;
    globals[CAPTURE_SINK] = {
      capture: () => new Promise<void>(r => setTimeout(() => ((settled = true), r()), 10))
    };
    await withEvent(() => fn(false));
    expect(settled).toBe(true);

    const captures: unknown[] = [];
    globals[CAPTURE_SINK] = { capture: (...entry: unknown[]) => void captures.push(entry) };
    await expect(withEvent(() => fn(true))).rejects.toThrow("nope");
    expect(captures).toHaveLength(0);
  });

  it("declares GET and brands the prerendered metadata", () => {
    const fn = declare(nextId("meta"), async () => 1);
    const meta = getServerFunctionMetadata(fn as unknown as (...args: unknown[]) => unknown);
    expect(meta?.method).toBe("GET");
    expect(meta?.prerendered).toBe(true);
    expect(typeof fn.id).toBe("string");
    expect(fn.url).toContain("/_server/");
  });
});

describe("prerendered (client half, live posture)", () => {
  it("degrades to a branded GET reference when no static artifacts exist", () => {
    expect(env.staticArtifacts).toBe(false); // the default module answers live
    const id = nextId("live");
    const ref = prerenderedClient(createClientReference(id));
    const meta = getServerFunctionMetadata(ref as unknown as (...args: unknown[]) => unknown);
    expect(meta?.method).toBe("GET");
    expect(meta?.prerendered).toBe(true);
    expect(ref.id).toBe(id);
  });
});

describe("prerendered (client half, hybrid posture)", () => {
  afterEach(() => {
    env.staticArtifacts = false;
    env.fallback = true;
  });

  it("falls back to live GET dispatch on an artifact miss", async () => {
    env.staticArtifacts = true;
    env.fallback = true; // hybrid: a server exists
    const id = nextId("hybridMiss");
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      const target = new URL(String(url instanceof Request ? url.url : url), "http://localhost");
      requested.push(target.pathname);
      if (target.pathname.startsWith("/_static/")) {
        return new Response("not found", { status: 404 });
      }
      // the live GET answer: plain JSON body with the runtime's format tag
      return new Response(JSON.stringify({ live: true }), {
        headers: { "X-Server-Function-Format": "8" }
      });
    });

    const ref = prerenderedClient(createClientReference(id));
    expect(await ref("unseen-args")).toEqual({ live: true });
    expect(requested[0]).toMatch(/^\/_static\//); // artifact-first
    expect(requested[1]).toBe(`/_server/data/${encodeURIComponent(id)}`); // then live
  });

  it("errors on a miss in the static posture (no fallback)", async () => {
    env.staticArtifacts = true;
    env.fallback = false; // static: nobody to fall back to
    vi.stubGlobal("fetch", async () => new Response("not found", { status: 404 }));
    const ref = prerenderedClient(createClientReference(nextId("staticMiss")));
    await expect(ref("unseen")).rejects.toThrow(/No static artifact/);
  });
});

describe("static round trip through a prerender run", () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "solid-prerender-"));
  });
  afterEach(async () => {
    env.staticArtifacts = false;
    env.fallback = true;
    await rm(outDir, { recursive: true, force: true });
  });

  it("captures during the crawl and serves the client half from the artifacts", async () => {
    const plainId = nextId("plain");
    const richId = nextId("rich");
    const getTeam = declare(plainId, async (dept: string) => ({
      dept,
      users: ["ada", "grace"]
    }));
    const getReport = declare(richId, async () => ({
      asOf: new Date("2026-01-15T00:00:00Z"),
      totals: new Map([["eng", 7]])
    }));

    // a fake built app: the page render performs the prerendered calls,
    // the way SSR component code would
    const transport = {
      async fetch(_request: Request) {
        const [team] = await withEvent(() => Promise.all([getTeam("eng"), getReport()]));
        return new Response(`<html><body>${team.users.join(", ")}</body></html>`, {
          headers: { "content-type": "text/html" }
        });
      }
    };
    const result = await runPrerender({
      transport,
      outDir,
      crawlLinks: false,
      integrations: [createCaptureIntegration()]
    });
    expect(result.pages).toHaveLength(1);
    expect(result.files.map(f => f.filename).sort()).toEqual(
      [await staticArtifactPath(plainId, ["eng"]), await staticArtifactPath(richId, [])].sort()
    );
    // the sink is gone after teardown
    expect(globals[CAPTURE_SINK]).toBeUndefined();

    // plain results are human-readable JSON on disk
    const plainText = await readFile(
      join(outDir, await staticArtifactPath(plainId, ["eng"])),
      "utf8"
    );
    expect(JSON.parse(plainText)).toEqual({ dept: "eng", users: ["ada", "grace"] });
    // rich results ride the codec's framed encoding
    const richText = await readFile(join(outDir, await staticArtifactPath(richId, [])), "utf8");
    expect(richText.startsWith(";0x")).toBe(true);

    // ---- the client, in the STATIC posture (no fallback server), against
    // the written files ----
    env.staticArtifacts = true;
    env.fallback = false;
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const pathname = new URL(String(url), "http://localhost").pathname;
      try {
        return new Response(await readFile(join(outDir, pathname), "utf8"));
      } catch {
        return new Response("not found", { status: 404 });
      }
    });

    const teamClient = prerenderedClient(createClientReference(plainId));
    const reportClient = prerenderedClient(createClientReference(richId));

    expect(await teamClient("eng")).toEqual({ dept: "eng", users: ["ada", "grace"] });
    const report = (await reportClient()) as { asOf: Date; totals: Map<string, number> };
    expect(report.asOf).toBeInstanceOf(Date);
    expect(report.asOf.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(report.totals).toBeInstanceOf(Map);
    expect(report.totals.get("eng")).toBe(7);

    // a call no prerendered page made has no artifact — and no server to
    // fall back to
    await expect(teamClient("marketing")).rejects.toThrow(/No static artifact/);
  });

  it("keys artifacts by arguments, not just by function", async () => {
    const id = nextId("byArgs");
    const byTag = declare(id, async (tag: string) => ({ tag }));
    const transport = {
      async fetch(request: Request) {
        const tag = new URL(request.url).pathname === "/" ? "a" : "b";
        await withEvent(() => byTag(tag));
        return new Response(`<html><body><a href="/second">next</a></body></html>`, {
          headers: { "content-type": "text/html" }
        });
      }
    };
    const result = await runPrerender({
      transport,
      outDir,
      integrations: [createCaptureIntegration()]
    });
    expect(result.files).toHaveLength(2);
    expect(result.files.map(f => f.filename).sort()).toEqual(
      [await staticArtifactPath(id, ["a"]), await staticArtifactPath(id, ["b"])].sort()
    );
  });
});
