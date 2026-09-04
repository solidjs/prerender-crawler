// The client-reference scanner behind static mode's build guard.
//
// The `"use server"` compiler turns every server function the CLIENT can
// call into `createServerReference("<id>")` — imported by name from the
// runtime (default `@solidjs/web/server-functions`, but swappable), usually
// under a numbered alias (`createServerReference_1`). That literal id is the
// same one the server registers and the capture integration records, so the
// set of ids seen in client code minus the set of ids captured during the
// walk is exactly the set of calls a static deployment cannot answer.
//
// Scanning happens at transform time (post-compile, pre-minify) where the
// shape is stable; the final bundle has mangled the alias away.

const NAMED_IMPORT = /import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
const IMPORTED_NAME = "createServerReference";

/**
 * The server-function ids a compiled client module references, in order of
 * first appearance. Empty for modules that reference none.
 */
export function collectServerReferences(code: string): string[] {
  if (!code.includes(IMPORTED_NAME)) return [];

  // resolve the local binding(s) the runtime's `createServerReference` is
  // imported under — the compiler aliases it, and a hand-written import may
  // not — without pinning the runtime specifier
  const locals = new Set<string>();
  for (const match of code.matchAll(NAMED_IMPORT)) {
    for (const specifier of match[1].split(",")) {
      const [imported, local] = specifier
        .trim()
        .split(/\s+as\s+/)
        .map(part => part.trim());
      if (imported === IMPORTED_NAME) locals.add(local ?? imported);
    }
  }
  if (locals.size === 0) return [];

  const ids: string[] = [];
  for (const local of locals) {
    const call = new RegExp(`(?<![\\w$.])${escape(local)}\\s*\\(\\s*(["'\`])([^"'\`]+)\\1`, "g");
    for (const match of code.matchAll(call)) {
      if (!ids.includes(match[2])) ids.push(match[2]);
    }
  }
  return ids;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
