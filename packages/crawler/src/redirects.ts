// The redirects integration: the redirects the crawl observed, written as
// the host's own rules so the deployed site answers them with real 3xx
// responses instead of the engine's meta-refresh stubs.
//
// The default output is the `_redirects` line format Netlify and Cloudflare
// Pages share: `/from /to 301`. One divergence between them shapes the
// design: Cloudflare applies a rule whether or not a file exists at the
// path, while Netlify lets an existing file shadow the rule unless it is
// forced (`301!`) — and Cloudflare rejects the forced form. So the
// integration declares `handlesRedirects`, which stops the engine writing
// stubs at redirected paths; with no file to shadow, the plain unforced
// rule works on both hosts.
import type { PrerenderIntegration, RedirectRecord } from "./types.ts";

export interface RedirectsIntegrationOptions {
  /** Output file, relative to the output directory. @default "_redirects" */
  filename?: string;
  /**
   * Produces the file's contents from the run's redirects — for hosts with
   * their own format. Defaults to the `_redirects` line format.
   */
  format?(redirects: readonly RedirectRecord[]): string;
  /**
   * Netlify only: append `!` to force each rule past an existing file at
   * its path. Unneeded when the engine writes no stubs (the default with
   * this integration active), and Cloudflare Pages rejects the syntax.
   * @default false
   */
  force?: boolean;
}

/**
 * Emits the crawl's redirects as host rules — by default a `_redirects` file
 * (Netlify, Cloudflare Pages). Declares `handlesRedirects`, so the engine
 * writes no meta-refresh stubs at redirected paths.
 *
 * ```ts
 * import { redirects } from "prerender-crawler";
 * prerender({ integrations: [redirects()] })
 * ```
 */
export function redirects(options: RedirectsIntegrationOptions = {}): PrerenderIntegration {
  const { filename = "_redirects", force = false } = options;
  const format = options.format ?? (records => formatRedirectsFile(records, force));
  return {
    name: "redirects",
    handlesRedirects: true,
    teardown(context) {
      if (context.redirects.length === 0) return;
      context.emitFile({ filename, contents: format(context.redirects) });
    }
  };
}

/**
 * The `_redirects` line format: `/from /to status`, one rule per line,
 * sorted by source for a stable file across builds.
 */
export function formatRedirectsFile(redirects: readonly RedirectRecord[], force = false): string {
  const lines = [...redirects]
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    .map(({ from, to, status }) => `${from} ${to} ${status}${force ? "!" : ""}`);
  return lines.join("\n") + "\n";
}
