/**
 * Where a route's HTML lands on disk. Static hosts resolve `/about` by
 * probing `about/index.html` (and some `about.html`) — `autoSubfolderIndex`
 * picks which convention the output follows. A path that already names a
 * file (`/sitemap.xml`) is written verbatim.
 */
export function outputFilename(path: string, autoSubfolderIndex: boolean): string {
  if (path === "/") return "index.html";
  const trimmed = path.replace(/^\/+/, "");
  // a final segment with an extension is a file, not a route
  const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (lastSegment.includes(".")) return trimmed;
  return autoSubfolderIndex ? `${trimmed}/index.html` : `${trimmed}.html`;
}
