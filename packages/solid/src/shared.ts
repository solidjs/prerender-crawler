// The static-artifact contract: the pieces the capture half (server, at
// prerender time) and the fetch half (client, at runtime) must agree on
// byte-for-byte. A static call's identity is (function id, arguments); both
// halves derive the artifact's filename from it INDEPENDENTLY — the client
// never learns what the build wrote — so derivation must be deterministic
// across realms: canonical-JSON the arguments (sorted keys), hash with
// SHA-256, done. Everything here is dependency-free and isomorphic.

/** Directory (under the static output root) where artifacts land. */
export const ARTIFACT_DIR = "_static";

/**
 * The capture handshake: the prerender integration (vite plugin) installs a
 * sink under this registered symbol before the crawl and removes it after.
 * `prerendered`'s server wrapper delivers every call it executes while
 * the sink is present. A registered symbol — not module state — because the
 * built server bundle and the plugin process must agree by construction.
 */
export const CAPTURE_SINK = Symbol.for("solid-prerender.captureArtifacts");

/** What the server wrapper hands the sink per executed static call. */
export interface CaptureSink {
  capture(id: string, args: readonly unknown[], value: unknown): void | Promise<void>;
}

/**
 * Canonical JSON: `JSON.stringify` with object keys sorted at every level,
 * so two structurally equal argument lists spell identically regardless of
 * key insertion order. Throws on anything that would not survive a JSON
 * round trip faithfully — a static call's arguments ARE its address, and an
 * argument the encoding silently reshapes (a Date to a string, undefined to
 * a hole, a Map to `{}`) would derive different keys on the two halves.
 */
export function canonicalJSON(value: unknown): string {
  return writeCanonical(value, new Set());
}

function writeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n) || Object.is(n, -0)) {
      throw notJSONSafe(`the number ${Object.is(n, -0) ? "-0" : String(n)}`);
    }
    return JSON.stringify(n);
  }
  if (t !== "object") throw notJSONSafe(`a ${t}`);
  const obj = value as object;
  if (ancestors.has(obj)) throw notJSONSafe("a cyclic structure");
  ancestors.add(obj);
  let out: string;
  if (Array.isArray(obj)) {
    let body = "";
    for (let i = 0; i < obj.length; i++) {
      if (!(i in obj)) throw notJSONSafe("a sparse array");
      body += (i ? "," : "") + writeCanonical(obj[i], ancestors);
    }
    out = "[" + body + "]";
  } else {
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw notJSONSafe(`an instance of ${proto?.constructor?.name ?? "a null-free prototype"}`);
    }
    const keys = Object.keys(obj).sort();
    let body = "";
    for (let i = 0; i < keys.length; i++) {
      const v = (obj as Record<string, unknown>)[keys[i]];
      if (v === undefined) throw notJSONSafe("an undefined property");
      body += (i ? "," : "") + JSON.stringify(keys[i]) + ":" + writeCanonical(v, ancestors);
    }
    out = "{" + body + "}";
  }
  ancestors.delete(obj);
  return out;
}

function notJSONSafe(what: string): Error {
  return new Error(
    `Static function arguments must be JSON-safe — they are the call's address, and both the ` +
      `build and the client must derive the same artifact key from them. Got ${what}. ` +
      `Rich values belong in the function's RESULT (which rides the codec), not its arguments.`
  );
}

/**
 * The artifact key of a static call: 128 bits of SHA-256 over the call's
 * canonical spelling, hex-encoded. Async because hashing is
 * (`crypto.subtle` is the one SHA-256 both realms share).
 */
export async function staticCallKey(id: string, args: readonly unknown[]): Promise<string> {
  const spelling = canonicalJSON([id, ...args]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(spelling));
  const bytes = new Uint8Array(digest).subarray(0, 16);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The artifact's path relative to the static output root:
 * `_static/<label>.<key>.json`. The label is a sanitized slice of the
 * function id — for humans reading a build output or a network tab; the
 * key alone carries the identity.
 */
export async function staticArtifactPath(id: string, args: readonly unknown[]): Promise<string> {
  const key = await staticCallKey(id, args);
  const label = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return `${ARTIFACT_DIR}/${label ? label + "." : ""}${key}.json`;
}

/**
 * Metadata key `prerendered` brands on the reference's declaration
 * metadata channel (readable via
 * `getServerFunctionMetadata(fn).prerendered`), so routers and
 * integrations can detect prerendered references without property
 * sniffing.
 */
export const PRERENDERED_META_KEY = "prerendered";

/**
 * The public shape of a prerendered reference — mirrors the runtime's
 * `ServerFunction`: an async callable plus its build-stable identity.
 */
export interface PrerenderedFunction<A extends readonly unknown[] = unknown[], T = unknown> {
  (...args: A): Promise<T>;
  /** The build-stable function id. */
  readonly id: string;
  /** The live HTTP address the artifact stands in for (dev fallback, form actions). */
  readonly url: string;
}
