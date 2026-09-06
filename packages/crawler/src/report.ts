import type { PrerenderIntegration, RedirectRecord } from "./types.ts";

/**
 * The report integration: what the crawl did, as JSON — every page with
 * its status, timing, output file and the pages that linked to it; every
 * redirect; every skipped page and why; every file other integrations
 * emitted. The answers to "why was this page crawled", "which page is
 * slow" and "what did the build actually produce" are all in here, and
 * they are otherwise gone the moment the process exits.
 */

export interface ReportIntegrationOptions {
  /**
   * Where to write, resolved against the output directory. The default
   * lands inside it and so deploys with the site; point it outside
   * (`"../prerender-report.json"`) to keep it a build artifact.
   * @default "prerender-report.json"
   */
  filename?: string;
}

export interface PrerenderReport {
  generatedAt: string;
  mode: string;
  origin: string;
  totals: {
    pages: number;
    written: number;
    redirects: number;
    skipped: number;
    files: number;
    /** Sum of page durations, milliseconds — render cost, not wall time. */
    duration: number;
  };
  pages: ReportPage[];
  redirects: RedirectRecord[];
  skipped: ReportSkip[];
  /** Files emitted by integrations that ran before this one, this run's pages excluded. */
  files: string[];
}

export interface ReportPage {
  path: string;
  status: number;
  contentType: string | null;
  /** Milliseconds, the successful attempt. */
  duration: number;
  filename: string;
  /** Whether the HTML was written (`false` in hybrid mode, for query spellings, ...). */
  written: boolean;
  referrers: string[];
  redirect?: RedirectRecord;
}

export interface ReportSkip {
  path: string;
  error: string;
  referrers: string[];
}

export function report(options: ReportIntegrationOptions = {}): PrerenderIntegration {
  const { filename = "prerender-report.json" } = options;
  return {
    name: "report",
    teardown(context) {
      const pages = context.pages
        .map<ReportPage>(page => ({
          path: page.path,
          status: page.response.status,
          contentType: page.response.headers.get("content-type"),
          duration: Math.round(page.duration * 100) / 100,
          filename: page.filename,
          written: page.emitted,
          referrers: [...page.referrers].sort(),
          ...(page.redirect ? { redirect: page.redirect } : {})
        }))
        .sort(byPath);
      const skipped = context.skipped
        .map<ReportSkip>(miss => ({
          path: miss.path,
          error: miss.error instanceof Error ? miss.error.message : String(miss.error),
          referrers: [...miss.referrers].sort()
        }))
        .sort(byPath);
      const summary: PrerenderReport = {
        generatedAt: new Date().toISOString(),
        mode: context.mode,
        origin: context.origin,
        totals: {
          pages: pages.length,
          written: pages.filter(page => page.written).length,
          redirects: context.redirects.length,
          skipped: skipped.length,
          files: context.files.length,
          duration: Math.round(pages.reduce((sum, page) => sum + page.duration, 0))
        },
        pages,
        redirects: [...context.redirects],
        skipped,
        files: context.files.map(file => file.filename)
      };
      context.emitFile({ filename, contents: JSON.stringify(summary, null, 2) + "\n" });
    }
  };
}

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
