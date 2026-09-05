// The full prerendered-function story, without Vite: the server half
// captures during a real prerender-crawler crawl (through the capture
// integration the plugin installs), artifacts land on disk, and the client
// half — flipped to the static posture — reads them back, rich types
// included.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPrerender } from "prerender-crawler";
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
import { serverFunctions } from "../src/integration.ts";
import { CAPTURE_SINK, staticArtifactPath } from "../src/shared.ts";

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
  vi.unstubAllEnvs();
});

// the client half reads its posture from `import.meta.env.PRERENDER_MODE`,
// the constant `prerender-crawler/vite` defines in a build
const posture = (mode: "static" | "hybrid") => vi.stubEnv("PRERENDER_MODE", mode);

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
    // no plugin defined the constant: live
    expect(import.meta.env?.PRERENDER_MODE).toBeUndefined();
    const id = nextId("live");
    const ref = prerenderedClient(createClientReference(id));
    const meta = getServerFunctionMetadata(ref as unknown as (...args: unknown[]) => unknown);
    expect(meta?.method).toBe("GET");
    expect(meta?.prerendered).toBe(true);
    expect(ref.id).toBe(id);
  });
});

describe("prerendered (client half, hybrid posture)", () => {
  it("falls back to live GET dispatch on an artifact miss", async () => {
    posture("hybrid"); // a server exists
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
    posture("static"); // nobody to fall back to
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
      integrations: [serverFunctions()]
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
    posture("static");
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
      integrations: [serverFunctions()]
    });
    expect(result.files).toHaveLength(2);
    expect(result.files.map(f => f.filename).sort()).toEqual(
      [await staticArtifactPath(id, ["a"]), await staticArtifactPath(id, ["b"])].sort()
    );
  });
});

describe("the static-mode guard", () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "solid-prerender-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(outDir, { recursive: true, force: true });
  });

  /** What @solidjs/vite-plugin's client build leaves behind. */
  async function writeManifest(functions: Array<{ id: string; name: string; module: string }>) {
    await mkdir(join(outDir, ".vite"), { recursive: true });
    await writeFile(
      join(outDir, ".vite/solid-server-functions.json"),
      JSON.stringify({ modules: ["src/data.ts"], functions })
    );
  }

  /** A one-page site whose render performs exactly the given prerendered calls. */
  const siteCalling = (calls: () => Promise<unknown>) => ({
    async fetch() {
      await withEvent(calls);
      return new Response("<html></html>", { headers: { "content-type": "text/html" } });
    }
  });

  it("fails a static run naming client-reachable functions nothing captured", async () => {
    const calledId = nextId("called");
    const called = declare(calledId, async () => 1);
    await writeManifest([
      { id: calledId, name: "called", module: "src/data.ts" },
      { id: "getLive-deadbeef", name: "getLive", module: "src/data.ts" }
    ]);
    await expect(
      runPrerender({
        transport: siteCalling(() => called()),
        outDir,
        crawlLinks: false,
        integrations: [serverFunctions()]
      })
    ).rejects.toThrow(/never captured[\s\S]*getLive \(getLive-deadbeef, src\/data\.ts\)/);
  });

  it("passes when everything reachable was captured, and stays quiet in hybrid mode", async () => {
    const id = nextId("covered");
    const covered = declare(id, async () => 1);
    await writeManifest([
      { id, name: "covered", module: "src/data.ts" },
      { id: "getLive-deadbeef", name: "getLive", module: "src/data.ts" }
    ]);
    // hybrid: a server answers the uncaptured call, nothing to guard
    const hybrid = await runPrerender({
      transport: siteCalling(() => covered()),
      outDir,
      mode: "hybrid",
      crawlLinks: false,
      integrations: [serverFunctions()]
    });
    expect(hybrid.files).toHaveLength(1);

    // static, fully covered
    await writeManifest([{ id, name: "covered", module: "src/data.ts" }]);
    const covering = await runPrerender({
      transport: siteCalling(() => covered()),
      outDir,
      crawlLinks: false,
      integrations: [serverFunctions()]
    });
    expect(covering.files).toHaveLength(1);
  });

  it("downgrades to a warning on request, and warns once on a legacy manifest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeManifest([{ id: "getLive-deadbeef", name: "getLive", module: "src/data.ts" }]);
    await runPrerender({
      transport: siteCalling(async () => {}),
      outDir,
      crawlLinks: false,
      integrations: [serverFunctions({ uncaptured: "warn" })]
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/getLive-deadbeef/);

    // the pre-ids manifest shape: the guard says why it cannot check
    warn.mockClear();
    await writeFile(
      join(outDir, ".vite/solid-server-functions.json"),
      JSON.stringify(["src/data.ts"])
    );
    await runPrerender({
      transport: siteCalling(async () => {}),
      outDir,
      crawlLinks: false,
      integrations: [serverFunctions()]
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/carries no function ids/);
  });
});
