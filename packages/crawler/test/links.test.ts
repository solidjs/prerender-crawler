import { describe, expect, it } from "vitest";
import { extractLinks, normalizePath, normalizeRoute, splitRoute } from "../src/links.ts";

const page = new URL("http://localhost/blog/post-1");

describe("extractLinks", () => {
  it("finds absolute and relative hrefs, resolved against the page url", () => {
    const html = `
      <a href="/about">about</a>
      <a href='/pricing'>pricing</a>
      <a href="../contact">contact</a>
      <a href="post-2">sibling</a>
    `;
    expect(extractLinks(html, page).sort()).toEqual([
      "/about",
      "/blog/post-2",
      "/contact",
      "/pricing"
    ]);
  });

  it("dedupes spellings of the same page (query, fragment, trailing slash)", () => {
    const html = `
      <a href="/about">a</a>
      <a href="/about?utm=x">b</a>
      <a href="/about#team">c</a>
      <a href="/about/">d</a>
    `;
    expect(extractLinks(html, page)).toEqual(["/about"]);
  });

  it("never leaves the origin and skips non-page schemes", () => {
    const html = `
      <a href="https://example.com/external">x</a>
      <a href="mailto:hi@example.com">m</a>
      <a href="tel:+15551234567">t</a>
      <a href="javascript:void(0)">j</a>
      <a href="/kept">k</a>
    `;
    expect(extractLinks(html, page)).toEqual(["/kept"]);
  });

  it("honors <base href> for relative links", () => {
    const html = `
      <base href="/docs/">
      <a href="getting-started">g</a>
      <a href="/absolute">a</a>
    `;
    expect(extractLinks(html, page).sort()).toEqual(["/absolute", "/docs/getting-started"]);
  });

  it("handles multiline anchors and extra attributes", () => {
    const html = `<a
      class="nav"
      href="/multi"
      data-x="y">m</a>`;
    expect(extractLinks(html, page)).toEqual(["/multi"]);
  });
});

describe("normalizePath", () => {
  it("keeps the root, trims trailing slashes elsewhere", () => {
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/a/")).toBe("/a");
    expect(normalizePath("/a/b")).toBe("/a/b");
  });
});

describe("normalizeRoute", () => {
  it("keeps the query on request, parameters sorted, fragment dropped", () => {
    const url = new URL("http://localhost/posts/?b=2&a=1#top");
    expect(normalizeRoute(url)).toBe("/posts");
    expect(normalizeRoute(url, { keepQuery: true })).toBe("/posts?a=1&b=2");
    expect(normalizeRoute(new URL("http://localhost/posts?"), { keepQuery: true })).toBe("/posts");
  });

  it("extractLinks threads the option through", () => {
    const html = `<a href="/about?utm=x">a</a> <a href="/about?utm=y">b</a> <a href="/about">c</a>`;
    expect(extractLinks(html, page, { keepQuery: true })).toEqual([
      "/about?utm=x",
      "/about?utm=y",
      "/about"
    ]);
  });
});

describe("splitRoute", () => {
  it("separates pathname and search", () => {
    expect(splitRoute("/posts?page=2")).toEqual({ pathname: "/posts", search: "?page=2" });
    expect(splitRoute("/posts")).toEqual({ pathname: "/posts", search: "" });
  });
});
