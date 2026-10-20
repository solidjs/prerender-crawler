import { describe, expect, it } from "vitest";
import {
  canonicalJSON,
  decodeArtifact,
  encodeArtifact,
  parseDataAddress,
  sha256,
  staticArtifactPath,
  staticCallKey,
  staticCallKeySync
} from "../src/shared.ts";

describe("canonicalJSON", () => {
  it("spells structurally equal values identically regardless of key order", () => {
    expect(canonicalJSON({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJSON({ a: { c: 3, d: 2 }, b: 1 })
    );
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("round-trips as plain JSON", () => {
    const value = { list: [1, "two", false, null], nested: { deep: [{ x: 0.5 }] } };
    expect(JSON.parse(canonicalJSON(value))).toEqual(value);
  });

  it("rejects everything a JSON round trip would reshape", () => {
    expect(() => canonicalJSON(new Date())).toThrow(/JSON-safe/);
    expect(() => canonicalJSON(new Map())).toThrow(/JSON-safe/);
    expect(() => canonicalJSON({ x: undefined })).toThrow(/JSON-safe/);
    expect(() => canonicalJSON(NaN)).toThrow(/JSON-safe/);
    expect(() => canonicalJSON(-0)).toThrow(/JSON-safe/);
    expect(() => canonicalJSON(10n)).toThrow(/JSON-safe/);
    expect(() => canonicalJSON(Symbol("x"))).toThrow(/JSON-safe/);
    expect(() => canonicalJSON(() => {})).toThrow(/JSON-safe/);
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJSON([1, , 3])).toThrow(/JSON-safe/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJSON(cyclic)).toThrow(/JSON-safe/);
  });

  it("permits repeated (non-cyclic) references", () => {
    const shared = { k: 1 };
    expect(canonicalJSON([shared, shared])).toBe('[{"k":1},{"k":1}]');
  });
});

describe("sha256", () => {
  it("matches crypto.subtle across block boundaries", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const input = new Uint8Array(length).map((_, i) => (i * 31 + length) & 0xff);
      const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
      expect(sha256(input)).toEqual(expected);
    }
  });
});

describe("staticCallKey", () => {
  it("is the same key synchronously and as a promise", async () => {
    expect(staticCallKeySync("fn#1", ["x", { a: 1 }])).toBe(
      await staticCallKey("fn#1", ["x", { a: 1 }])
    );
  });

  it("is deterministic and argument-order-insensitive for object keys", async () => {
    const a = await staticCallKey("fn#1", [{ tag: "x", page: 2 }]);
    const b = await staticCallKey("fn#1", [{ page: 2, tag: "x" }]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it("separates calls by id and by arguments", async () => {
    const base = await staticCallKey("fn#1", ["x"]);
    expect(await staticCallKey("fn#2", ["x"])).not.toBe(base);
    expect(await staticCallKey("fn#1", ["y"])).not.toBe(base);
    expect(await staticCallKey("fn#1", [])).not.toBe(base);
  });
});

describe("staticArtifactPath", () => {
  it("carries a sanitized human label plus the key", async () => {
    const path = await staticArtifactPath("src/routes/users.tsx#getUsers", ["eng"]);
    expect(path).toMatch(/^_static\/src_routes_users_tsx_getUsers\.[0-9a-f]{32}\.txt$/);
  });

  it("replaces filename-unsafe characters and drops an empty label", async () => {
    expect(await staticArtifactPath("///", [])).toMatch(/^_static\/___\.[0-9a-f]{32}\.txt$/);
    expect(await staticArtifactPath("", [])).toMatch(/^_static\/[0-9a-f]{32}\.txt$/);
  });

  it("nests under the build's directory when given one", async () => {
    const path = await staticArtifactPath("getUsers", ["eng"], "b1");
    expect(path).toMatch(/^_static\/b1\/getUsers\.[0-9a-f]{32}\.txt$/);
    expect(path.slice("_static/b1/".length)).toBe(
      (await staticArtifactPath("getUsers", ["eng"])).slice("_static/".length)
    );
  });
});

describe("artifacts", () => {
  it("round-trip the live answer: status, headers and body bytes", async () => {
    const live = new Response(";0x00000005;hello", {
      status: 200,
      headers: {
        "X-Frame-Stream": "f1",
        "X-Content-Raw": "1",
        "Content-Length": "17",
        "Set-Cookie": "session=secret"
      }
    });
    const stored = await encodeArtifact(live);
    const answer = decodeArtifact(stored)!;
    expect(answer.status).toBe(200);
    expect(answer.headers.get("x-frame-stream")).toBe("f1");
    expect(answer.headers.get("x-content-raw")).toBe("1");
    // transport and per-visitor headers are not replayed
    expect(answer.headers.has("set-cookie")).toBe(false);
    expect(await answer.text()).toBe(";0x00000005;hello");
  });

  it("are recognized by their marker, not by status", () => {
    const page = new TextEncoder().encode("<!DOCTYPE html><html></html>");
    expect(decodeArtifact(page)).toBeUndefined();
    expect(decodeArtifact(new Uint8Array())).toBeUndefined();
  });
});

describe("parseDataAddress", () => {
  it("reads id and arguments off a GET address", () => {
    const args = [{ params: { id: "1" } }, "x"];
    const url = `/_server/data/${encodeURIComponent("src/a.ts#get")}?args=${encodeURIComponent(
      JSON.stringify(args)
    )}`;
    expect(parseDataAddress(url)).toEqual({ id: "src/a.ts#get", args });
    expect(parseDataAddress("https://example.com/api/data/fn-1")).toEqual({
      id: "fn-1",
      args: []
    });
  });

  it("ignores anything that is not one", () => {
    expect(parseDataAddress("/_server/fn-1")).toBeUndefined();
    expect(parseDataAddress("/_server/live/fn-1")).toBeUndefined();
    expect(parseDataAddress("/_server/data/fn-1?args=not-json")).toBeUndefined();
    expect(parseDataAddress("/_server/data/fn-1?args=%7B%7D")).toBeUndefined();
  });
});
