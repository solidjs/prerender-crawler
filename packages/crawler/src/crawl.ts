import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { extractLinks, normalizeLink, normalizeRoute, splitRoute } from "./links.ts";
import type { LinkOptions } from "./links.ts";
import { outputFilename } from "./output.ts";
import type {
  EmittedFile,
  PageEntry,
  PrerenderContext,
  PrerenderOptions,
  PrerenderResult,
  RedirectRecord,
  RenderedPage,
  Transport
} from "./types.ts";

export interface RunOptions extends PrerenderOptions {
  transport: Transport;
  outDir: string;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function resolveSeeds(
  pages: PrerenderOptions["pages"],
  origin: URL,
  links: LinkOptions
): Promise<PageEntry[]> {
  const source = typeof pages === "function" ? await pages() : (pages ?? ["/"]);
  // Seeds are spelled by people and route manifests — `about/`, `/a#top`,
  // `/posts?page=2` — and get the same normalization a crawled link does,
  // so a seed and a link to the same page meet in one queue entry. Seed
  // sources overlap routinely (an explicit list plus a route-manifest scan
  // both naming `/`): one render per path, the first spelling wins.
  const byPath = new Map<string, PageEntry>();
  for (const entry of source) {
    const spelled = typeof entry === "string" ? entry : entry.path;
    const path = normalizeRoute(new URL(spelled, origin), links);
    const page = typeof entry === "string" ? { path } : { ...entry, path };
    if (!byPath.has(page.path)) byPath.set(page.path, page);
  }
  return [...byPath.values()];
}

/**
 * The run: seed, fetch, follow redirects, write, discover (links + header
 * hints), repeat until the queue drains. Every mechanism here is
 * transport-agnostic — in-process dispatch and loopback HTTP drive the
 * identical loop.
 */
export async function runPrerender(options: RunOptions): Promise<PrerenderResult> {
  const {
    transport,
    outDir,
    mode = "static",
    crawlLinks = true,
    hintHeader = "x-prerender",
    filter,
    keepQuery = false,
    concurrency = 8,
    interval = 0,
    retries = 2,
    retryDelay = 500,
    failOnError = true,
    // hybrid's crawl bakes data; writing its HTML would shadow live SSR
    emitPages = mode === "static",
    autoSubfolderIndex = true,
    origin = "http://localhost",
    onRendered,
    integrations = [],
    // an integration turning redirects into host rules makes stubs
    // redundant — and on hosts where a file shadows a rule, harmful
    redirectStubs = !integrations.some(integration => integration.handlesRedirects)
  } = options;

  const originUrl = new URL(origin);
  const links: LinkOptions = { keepQuery };
  const rendered: RenderedPage[] = [];
  const redirects: RedirectRecord[] = [];
  const skipped: PrerenderResult["skipped"] = [];
  const emitted: EmittedFile[] = [];
  const context: PrerenderContext = {
    mode,
    origin,
    outDir,
    pages: rendered,
    redirects,
    skipped,
    files: emitted,
    emitFile: file => void emitted.push(file)
  };
  // A query spelling without a filename of its own has nowhere correct to
  // go: `posts/index.html` is `/posts`, and a static host serves it for
  // every query. It renders (data, links) and leaves no file.
  const shouldEmit = (entry: PageEntry) => {
    if (!entry.filename && entry.path.includes("?")) return false;
    return entry.emit ?? (typeof emitPages === "function" ? emitPages(entry.path) : emitPages);
  };

  const seeds = await resolveSeeds(options.pages, originUrl, links);
  const seen = new Set(seeds.map(page => page.path));
  const queue: PageEntry[] = [...seeds];
  // Provenance: which pages named each discovered path. Recorded for every
  // mention (not just the first), so a failure can point at every page
  // carrying the broken link.
  const referrers = new Map<string, Set<string>>();
  const referrersOf = (path: string) => [...(referrers.get(path) ?? [])];

  // Discovered paths (crawled links, header hints) pass the filter;
  // explicitly seeded pages are the caller's statement of intent and skip it.
  const discovered = (path: string, from: string) => {
    let sources = referrers.get(path);
    if (!sources) referrers.set(path, (sources = new Set()));
    sources.add(from);
    if (seen.has(path) || (filter && !filter(path))) return;
    seen.add(path);
    queue.push({ path });
  };

  // The throttle. Two mechanisms, because the guarantee is about ACTUAL
  // starts: claiming the next slot on a shared timeline keeps concurrent
  // workers apart in advance, and holding until `interval` has passed since
  // the last real start covers the case a claim cannot — a start that ran
  // late (busy event loop) must not be crowded by the next one's on-time
  // slot. The hold's check-then-record runs without interleaving, so two
  // workers waking together cannot both pass it.
  let nextSlot = 0;
  let lastStart = -Infinity;
  async function pace() {
    if (interval <= 0) return;
    const now = performance.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + interval;
    if (slot > now) await wait(slot - now);
    let started = performance.now();
    while (started - lastStart < interval) {
      await wait(lastStart + interval - started);
      started = performance.now();
    }
    lastStart = started;
    if (nextSlot < started + interval) nextSlot = started + interval;
  }

  // Redirects are not followed in place: a 3xx makes the path a redirect
  // record (and a stub, see finalizeRedirects), and its same-origin target
  // enters the queue as a page in its own right — so the destination is
  // rendered once, at its own URL, and a chain is one record per hop the
  // way a host's redirect rules would spell it. Cycles are harmless: the
  // seen-set admits each path once.
  // `started` is taken after pacing: a page's duration is its own, not the
  // throttle's.
  async function fetchUrl(url: URL): Promise<Fetched> {
    await pace();
    const started = performance.now();
    const response = await transport.fetch(
      new Request(url, { headers: { accept: "text/html,*/*", [hintHeader]: "1" } })
    );
    return { response, started };
  }

  // A redirect to a spelling of the SAME page (`/posts` -> `/posts/`, the
  // trailing-slash canonicalization static servers do) is not a redirect
  // between pages: it is followed here, once, and the page renders as
  // itself. Anything else is the caller's to record.
  async function fetchPage(path: string): Promise<Fetched> {
    const url = new URL(path, originUrl);
    const fetched = await fetchUrl(url);
    const { response } = fetched;
    const location = response.headers.get("location");
    if (!location || response.status < 300 || response.status >= 400) return fetched;
    const target = new URL(location, url);
    if (target.origin !== originUrl.origin || normalizeRoute(target, links) !== path) {
      return fetched;
    }
    return { ...(await fetchUrl(target)), started: fetched.started };
  }

  const pendingRedirects: Array<{
    entry: PageEntry;
    filename: string;
    response: Response;
    duration: number;
    redirect: RedirectRecord;
  }> = [];

  async function renderPage(entry: PageEntry): Promise<void> {
    let response: Response | undefined;
    let started = 0;
    let error: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await wait(retryDelay);
      try {
        ({ response, started } = await fetchPage(entry.path));
        error = undefined;
        if (response.status < 500) break; // retry only what might heal
      } catch (thrown) {
        error = thrown;
      }
    }
    if (!response || error !== undefined || response.status >= 400) {
      // The message carries provenance: a 404 is usually a broken link, and
      // the fix lives on the pages that carry it, not at the missing route.
      const from = referrersOf(entry.path);
      const linked = from.length ? ` (linked from ${from.join(", ")})` : "";
      const failure =
        error !== undefined
          ? new Error(`Prerendering ${entry.path} failed${linked}: ${describe(error)}`, {
              cause: error
            })
          : new Error(`Prerendering ${entry.path} answered ${response!.status}${linked}`);
      if (failOnError) throw failure;
      // referrers are completed once the crawl settles: pages still in
      // flight may yet link here, and the report should name all of them
      skipped.push({ path: entry.path, error: failure, referrers: [] });
      return;
    }

    const filename =
      entry.filename ?? outputFilename(splitRoute(entry.path).pathname, autoSubfolderIndex);
    const hints = response.headers.get(hintHeader);
    if (hints) {
      for (const hint of hints.split(",")) {
        const path = normalizeLink(hint.trim(), originUrl, originUrl.origin, links);
        if (path !== undefined) discovered(path, entry.path);
      }
    }

    const location = response.headers.get("location");
    if (location && response.status >= 300 && response.status < 400) {
      const pageUrl = new URL(entry.path, originUrl);
      const target = new URL(location, pageUrl);
      const internal = target.origin === originUrl.origin;
      const to = internal ? normalizeRoute(target, links) : target.href;
      const redirect: RedirectRecord = { from: entry.path, to, status: response.status };
      redirects.push(redirect);
      if (internal) discovered(to, entry.path);
      // the stub needs the chain's end, known only once the crawl settles
      const duration = performance.now() - started;
      pendingRedirects.push({ entry, filename, response, duration, redirect });
      return;
    }

    const html = await response.text();
    const duration = performance.now() - started;
    // Emission is policy, rendering is not: an unemitted page has still
    // fully executed (integration capture happened server-side) and its
    // links still feed the crawl — it just leaves no HTML file behind to
    // shadow a live server's SSR of the route.
    const emitted = shouldEmit(entry);
    if (emitted) await writeOutput(outDir, filename, html);

    if (crawlLinks && (response.headers.get("content-type") ?? "").includes("text/html")) {
      const pageUrl = new URL(entry.path, originUrl);
      for (const path of extractLinks(html, pageUrl, links)) discovered(path, entry.path);
    }

    const page: RenderedPage = {
      path: entry.path,
      referrers: referrersOf(entry.path),
      filename,
      emitted,
      response,
      duration,
      html
    };
    rendered.push(page);
    if (onRendered) await onRendered(page);
  }

  // Redirected paths become pages holding a meta-refresh stub — the old URL
  // keeps working on hosts with no redirect support — pointing straight at
  // the chain's final destination so a visitor hops once, not per record.
  async function finalizeRedirects(): Promise<void> {
    const hops = new Map(redirects.map(record => [record.from, record.to]));
    // the chain's end — or, in a cycle (which has none), one hop on
    const destination = (from: string) => {
      const next = hops.get(from)!;
      const visited = new Set([from]);
      let at = next;
      while (hops.has(at)) {
        if (visited.has(at)) return next;
        visited.add(at);
        at = hops.get(at)!;
      }
      return at;
    };
    for (const { entry, filename, response, duration, redirect } of pendingRedirects) {
      const html = redirectStub(destination(entry.path));
      const emitted = redirectStubs && shouldEmit(entry);
      if (emitted) await writeOutput(outDir, filename, html);
      const page: RenderedPage = {
        path: entry.path,
        referrers: referrersOf(entry.path),
        filename,
        emitted,
        response,
        duration,
        html,
        redirect
      };
      rendered.push(page);
      if (onRendered) await onRendered(page);
    }
  }

  try {
    for (const integration of integrations) await integration.setup?.(context);

    // A worker pool over a queue that grows while it drains: discoveries
    // enqueue, idle workers pick them up, the run resolves when the last
    // worker goes idle against an empty queue.
    await new Promise<void>((resolve, reject) => {
      let active = 0;
      let failed = false;
      const pump = () => {
        if (failed) return;
        while (active < concurrency && queue.length) {
          const entry = queue.shift()!;
          active++;
          renderPage(entry).then(
            () => {
              active--;
              pump();
            },
            failure => {
              failed = true;
              reject(failure);
            }
          );
        }
        if (active === 0 && queue.length === 0) resolve();
      };
      pump();
    });

    for (const miss of skipped) miss.referrers = referrersOf(miss.path);
    await finalizeRedirects();

    for (const integration of integrations) await integration.teardown?.(context);

    for (const file of emitted) {
      await writeOutput(outDir, file.filename, file.contents);
    }
  } finally {
    await transport.close?.();
  }

  return { pages: rendered, redirects, files: emitted, skipped };
}

interface Fetched {
  response: Response;
  /** `performance.now()` at the request's start, pacing excluded. */
  started: number;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

function redirectStub(location: string): string {
  const target = location.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=${target}"><link rel="canonical" href="${target}"></head></html>`;
}

async function writeOutput(outDir: string, filename: string, contents: string | Uint8Array) {
  const target = resolve(outDir, filename);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}
