// The two transports the engine ships. Both are small because the engine's
// contract is small — `Request` in, `Response` out — and that is the point:
// anything answering that shape is prerenderable, whether it is a module
// in this process or a server on the other side of a socket.
import { pathToFileURL } from "node:url";
import type { Transport } from "./types.ts";

export interface HttpTransportOptions {
  /** Headers added to every request (an auth token for a preview deploy, say). */
  headers?: HeadersInit;
  /** The fetch implementation to use. @default globalThis.fetch */
  fetch?: typeof fetch;
}

/**
 * Prerenders a RUNNING server over HTTP: every request the crawl mints is
 * re-addressed to `target`'s origin (path and query kept) and sent with
 * `fetch`. Works against anything that speaks HTTP — a framework's preview
 * server, a container, a staging deploy — with no knowledge of what it is.
 *
 * Redirects are delivered to the engine as the 3xx responses the server
 * sent (`redirect: "manual"`), not followed here: the engine records them,
 * stubs them, and crawls their targets as pages in their own right.
 *
 * Set the run's `origin` to the same value so absolute links in the
 * rendered HTML count as same-origin — the CLI does this for you.
 */
export function httpTransport(target: string | URL, options: HttpTransportOptions = {}): Transport {
  const base = new URL(target);
  const send = options.fetch ?? globalThis.fetch;
  return {
    async fetch(request) {
      const url = new URL(request.url);
      url.protocol = base.protocol;
      url.host = base.host;
      const headers = new Headers(request.headers);
      new Headers(options.headers).forEach((value, key) => headers.set(key, value));
      return send(new Request(url, { method: request.method, headers, redirect: "manual" }));
    }
  };
}

/** A `Request -> Response` handler, as a built server entry exports it. */
export type RequestHandler = (request: Request) => Response | Promise<Response>;

/**
 * Imports a built server module and returns its request handler:
 * `handleRequest`, `fetch`, or `default.fetch` — the shapes SSR entries and
 * WinterCG-style servers export.
 */
export async function loadHandler(entry: string | URL): Promise<RequestHandler> {
  const href = entry instanceof URL ? entry.href : pathToFileURL(entry).href;
  let serverModule: Record<string, unknown>;
  try {
    serverModule = await import(href);
  } catch (cause) {
    throw new Error(
      `prerender could not import the server entry at ${entry}. Prerendering renders pages ` +
        `through a Request -> Response handler — point it at a module exporting ` +
        `handleRequest, fetch, or default.fetch.`,
      { cause }
    );
  }
  const handler =
    serverModule.handleRequest ??
    serverModule.fetch ??
    (serverModule.default as { fetch?: unknown } | undefined)?.fetch;
  if (typeof handler !== "function") {
    throw new Error(
      `The server entry at ${entry} exports none of handleRequest, fetch, or default.fetch — ` +
        `prerender needs a Request -> Response handler to render pages through.`
    );
  }
  return handler as RequestHandler;
}

/**
 * Prerenders in-process against a built server module — no HTTP server,
 * no subprocess: the crawl calls the handler directly. This is what the
 * Vite plugin drives after the build.
 */
export async function moduleTransport(entry: string | URL): Promise<Transport> {
  const handler = await loadHandler(entry);
  return { fetch: async request => handler(request) };
}
