// The CLI's logic, separated from the executable entry (./cli.ts) so tests
// can drive it with an argv and capture its output.
import path from "node:path";
import { parseArgs } from "node:util";
import { runPrerender } from "./crawl.ts";
import { redirects } from "./redirects.ts";
import { httpTransport, moduleTransport } from "./transports.ts";
import type { PrerenderMode, PrerenderIntegration, Transport } from "./types.ts";

export const USAGE = `Usage: prerender-crawler <target> --out <dir> [options]

Prerenders a site into static files by crawling it.

  <target>                 An http(s) origin of a running server, or the path of a
                           module exporting a Request -> Response handler
                           (handleRequest, fetch, or default.fetch).

Options:
  -o, --out <dir>          Output directory (required)
  -p, --page <path>        Seed page; repeatable. Default: /
  -m, --mode <mode>        static (default) or hybrid — see docs for what each writes
  -c, --concurrency <n>    Pages in flight at once. Default: 8
  -i, --interval <ms>      Minimum ms between request starts. Default: 0
  -r, --retries <n>        Re-fetch attempts for a failed page. Default: 2
      --origin <url>       Origin requests are minted under (module targets).
                           Default: http://localhost
      --hint-header <name> Response header naming extra paths. Default: x-prerender
      --redirects          Write the redirects as host rules (_redirects format,
                           Netlify / Cloudflare Pages) instead of meta-refresh stubs
      --redirects-file <f> Rules file name (implies --redirects). Default: _redirects
      --no-links           Do not follow links in rendered pages
      --no-redirect-stubs  Write no meta-refresh stubs at redirected paths
      --continue           Skip pages that fail instead of failing the run
      --flat               Write /about as about.html instead of about/index.html
  -h, --help               Show this help
`;

export interface CliIO {
  stdout(line: string): void;
  stderr(line: string): void;
}

/** Runs the CLI for `argv` (without the node and script entries). Returns the exit code. */
export async function main(argv: string[], io: CliIO): Promise<number> {
  const parsed = parse(argv);
  if ("error" in parsed) {
    io.stderr(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  const target = positionals[0];
  if (!target || positionals.length > 1 || !values.out) {
    io.stderr(
      !target
        ? "Missing <target>."
        : !values.out
          ? "Missing --out <dir>."
          : `Unexpected argument: ${positionals[1]}.`
    );
    io.stderr(`\n${USAGE}`);
    return 2;
  }
  const mode = values.mode ?? "static";
  if (mode !== "static" && mode !== "hybrid") {
    io.stderr(`--mode must be static or hybrid, got ${mode}.`);
    return 2;
  }

  let transport: Transport;
  let origin = values.origin;
  try {
    if (/^https?:\/\//.test(target)) {
      transport = httpTransport(target);
      origin ??= new URL(target).origin;
    } else {
      transport = await moduleTransport(path.resolve(target));
    }
  } catch (error) {
    io.stderr(describe(error));
    return 1;
  }

  const integrations: PrerenderIntegration[] = [];
  if (values.redirects || values["redirects-file"] !== undefined) {
    integrations.push(redirects({ filename: values["redirects-file"] }));
  }

  const outDir = path.resolve(values.out);
  try {
    const result = await runPrerender({
      transport,
      outDir,
      mode: mode as PrerenderMode,
      origin,
      pages: values.page?.length ? values.page : undefined,
      concurrency: values.concurrency !== undefined ? integer(values.concurrency) : undefined,
      interval: values.interval !== undefined ? integer(values.interval) : undefined,
      retries: values.retries !== undefined ? integer(values.retries) : undefined,
      hintHeader: values["hint-header"],
      crawlLinks: !values["no-links"],
      redirectStubs: values["no-redirect-stubs"] ? false : undefined,
      failOnError: !values.continue,
      autoSubfolderIndex: !values.flat,
      integrations
    });
    const written = result.pages.filter(page => page.emitted).length;
    const parts = [`rendered ${result.pages.length} page(s) (${written} written)`];
    if (result.redirects.length) parts.push(`${result.redirects.length} redirect(s)`);
    if (result.files.length) parts.push(`${result.files.length} file(s) emitted`);
    const relative = path.relative(process.cwd(), outDir);
    const shown = relative === "" ? "." : relative.startsWith("..") ? outDir : relative;
    io.stdout(`[prerender] ${parts.join(", ")} -> ${shown}`);
    for (const miss of result.skipped) {
      io.stderr(`[prerender] skipped ${miss.path}: ${describe(miss.error)}`);
    }
    return 0;
  } catch (error) {
    io.stderr(`[prerender] ${describe(error)}`);
    return 1;
  }
}

const spec = {
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    page: { type: "string", short: "p", multiple: true },
    mode: { type: "string", short: "m" },
    concurrency: { type: "string", short: "c" },
    interval: { type: "string", short: "i" },
    retries: { type: "string", short: "r" },
    origin: { type: "string" },
    "hint-header": { type: "string" },
    redirects: { type: "boolean" },
    "redirects-file": { type: "string" },
    "no-links": { type: "boolean" },
    "no-redirect-stubs": { type: "boolean" },
    continue: { type: "boolean" },
    flat: { type: "boolean" },
    help: { type: "boolean", short: "h" }
  }
} as const;

function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, ...spec });
  } catch (error) {
    return { error: describe(error) };
  }
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got ${JSON.stringify(value)}.`);
  }
  return parsed;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
