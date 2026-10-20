// The static-artifact contract: the pieces the capture half (server, at
// prerender time) and the fetch half (client, at runtime) must agree on
// byte-for-byte. A static call's identity is (function id, arguments); both
// halves derive the artifact's filename from it INDEPENDENTLY — the client
// never learns what the build wrote — so derivation must be deterministic
// across realms: canonical-JSON the arguments (sorted keys), hash with
// SHA-256, done. The artifact itself is the live answer: the response the
// server-function endpoint gave for the call's GET address, status and
// headers included, so the client's own transport decodes it exactly as it
// would a live call — plain data, codec payloads and server-component frames
// alike. Everything here is dependency-free and isomorphic.

/** Directory (under the static output root) where artifacts land. */
export const ARTIFACT_DIR = "_static";

/**
 * The capture handshake: the prerender integration (`serverFunctions()`)
 * installs a sink under this registered symbol before the crawl and removes
 * it after.
 * `prerendered`'s server wrapper delivers every call it executes while
 * the sink is present. A registered symbol — not module state — because the
 * built server bundle and the plugin process must agree by construction.
 */
export const CAPTURE_SINK = Symbol.for("solid-prerender.captureArtifacts");

/**
 * What the server wrapper hands the sink per executed static call: the
 * call's identity, its settled value, and the GET address a client's call
 * requests — what the integration replays through the app to capture the
 * live answer.
 */
export interface CaptureSink {
  capture(id: string, args: readonly unknown[], value: unknown, url: string): void | Promise<void>;
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
 * canonical spelling, hex-encoded. Synchronous on purpose: the client
 * derives it inside the transport's send, and hydration adopts a
 * server-rendered read only if that send reaches `fetch` in the same tick
 * (`crypto.subtle` would put an await in between).
 */
export function staticCallKeySync(id: string, args: readonly unknown[]): string {
  const bytes = sha256(new TextEncoder().encode(canonicalJSON([id, ...args]))).subarray(0, 16);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** `staticCallKeySync`, as a promise (the original public shape). */
export async function staticCallKey(id: string, args: readonly unknown[]): Promise<string> {
  return staticCallKeySync(id, args);
}

/**
 * The artifact's path relative to the static output root:
 * `_static/<label>.<key>.txt`. The label is a sanitized slice of the
 * function id — for humans reading a build output or a network tab; the
 * key alone carries the identity. `.txt` so static hosts serve it as text,
 * which they compress.
 */
export function staticArtifactPathSync(id: string, args: readonly unknown[]): string {
  const key = staticCallKeySync(id, args);
  const label = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return `${ARTIFACT_DIR}/${label ? label + "." : ""}${key}.txt`;
}

/** `staticArtifactPathSync`, as a promise (the original public shape). */
export async function staticArtifactPath(id: string, args: readonly unknown[]): Promise<string> {
  return staticArtifactPathSync(id, args);
}

// SHA-256 (FIPS 180-4), synchronous and dependency-free — see
// `staticCallKeySync` for why `crypto.subtle` will not do. Keys are tiny
// (a function id plus JSON arguments), so speed is irrelevant.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export function sha256(message: Uint8Array): Uint8Array {
  const bitLength = message.length * 8;
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

/**
 * The first line of every artifact. A static host answers a path it has no
 * file for with whatever it likes — a 404, but just as often a 200 SPA
 * index or an SSR page — so the client recognizes an artifact by this
 * marker, never by status.
 */
const ARTIFACT_MARKER = "solid-prerender-artifact/1 ";

// Transport-level headers the stored answer must not replay: the body is
// stored decoded and whole, and cookies are per-visitor.
const DROPPED_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "date",
  "set-cookie"
]);

/**
 * Encodes a live answer as an artifact: the marker line carrying status and
 * headers as JSON, then the body bytes untouched.
 */
export async function encodeArtifact(response: Response): Promise<Uint8Array> {
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (!DROPPED_HEADERS.has(name.toLowerCase())) headers.push([name, value]);
  });
  const head = new TextEncoder().encode(
    ARTIFACT_MARKER + JSON.stringify({ status: response.status, headers }) + "\n"
  );
  const body = new Uint8Array(await response.arrayBuffer());
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/**
 * Decodes an artifact back into the Response the live endpoint gave, or
 * undefined when the bytes are not an artifact (a host's fallback page).
 */
export function decodeArtifact(bytes: Uint8Array): Response | undefined {
  const marker = new TextEncoder().encode(ARTIFACT_MARKER);
  if (bytes.length < marker.length) return undefined;
  for (let i = 0; i < marker.length; i++) if (bytes[i] !== marker[i]) return undefined;
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) return undefined;
  let head: { status: number; headers: [string, string][] };
  try {
    head = JSON.parse(new TextDecoder().decode(bytes.subarray(marker.length, newline)));
  } catch {
    return undefined;
  }
  return new Response(bytes.slice(newline + 1), { status: head.status, headers: head.headers });
}

/**
 * Reads a call's identity back off its GET address
 * (`<endpoint>/data/<id>[?args=<json>]`, as `serverFunctionUrl` and the
 * transport spell it). Undefined for anything else — a POST-encoded call,
 * a live address, arguments that are not plain JSON.
 */
export function parseDataAddress(url: string): { id: string; args: unknown[] } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, "http://localhost");
  } catch {
    return undefined;
  }
  const match = /\/data\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  const encoded = parsed.searchParams.get("args");
  if (encoded === null) return { id, args: [] };
  try {
    const args = JSON.parse(encoded);
    return Array.isArray(args) ? { id, args } : undefined;
  } catch {
    return undefined;
  }
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

/** Options for `announceRoutes`. */
export interface AnnounceRoutesOptions {
  /** The crawl's `hintHeader`, if configured away from the default. @default "x-prerender" */
  header?: string;
  /** The app's base path, when passing a route tree rather than the router instance. */
  base?: string;
}
