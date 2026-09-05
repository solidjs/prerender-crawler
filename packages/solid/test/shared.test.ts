import { describe, expect, it } from "vitest";
import { canonicalJSON, staticArtifactPath, staticCallKey } from "../src/shared.ts";

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

describe("staticCallKey", () => {
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
    expect(path).toMatch(/^_static\/src_routes_users_tsx_getUsers\.[0-9a-f]{32}\.json$/);
  });

  it("replaces filename-unsafe characters and drops an empty label", async () => {
    expect(await staticArtifactPath("///", [])).toMatch(/^_static\/___\.[0-9a-f]{32}\.json$/);
    expect(await staticArtifactPath("", [])).toMatch(/^_static\/[0-9a-f]{32}\.json$/);
  });
});
