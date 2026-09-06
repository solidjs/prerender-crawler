// `announceRoutes`: the app root's one-liner that tells a crawl which pages
// the router has. Server half reads the ambient request event and writes the
// hint header only for the crawler's request; client half is a no-op.
import { createRequestEvent } from "@solidjs/web";
import { provideRequestEvent } from "@solidjs/web/storage";
import { describe, expect, it } from "vitest";
import { announceRoutes as announceClient } from "../src/client.ts";
import { announceRoutes } from "../src/server.ts";

const routes = [
  { path: "/" },
  { path: "/about" },
  { path: "/posts", children: [{ path: "/" }, { path: "/:id" }] }
];
// the shape `createRouter` returns: the provider component with the tree on it
const Router = Object.assign(() => null, { routes, config: { base: "" } });

const withEvent = <T>(request: Request, body: (event: { response: { headers: Headers } }) => T) => {
  const event = createRequestEvent(request);
  return provideRequestEvent(event, () => body(event));
};

describe("announceRoutes", () => {
  it("puts the router's static pages on the crawler's response", () => {
    const request = new Request("http://localhost/", { headers: { "x-prerender": "1" } });
    withEvent(request, event => {
      expect(announceRoutes(Router)).toBe(true);
      expect(event.response.headers.get("x-prerender")!.split(",").sort()).toEqual([
        "/",
        "/about",
        "/posts"
      ]);
    });
  });

  it("leaves a visitor's response alone, and does nothing without a request scope", () => {
    withEvent(new Request("http://localhost/"), event => {
      expect(announceRoutes(Router)).toBe(false);
      expect(event.response.headers.has("x-prerender")).toBe(false);
    });
    expect(announceRoutes(Router)).toBe(false);
  });

  it("honors a custom hint header and an explicit base for a bare tree", () => {
    const request = new Request("http://localhost/", { headers: { "x-pages": "1" } });
    withEvent(request, event => {
      expect(announceRoutes(routes, { header: "x-pages", base: "/app" })).toBe(true);
      expect(event.response.headers.get("x-pages")).toContain("/app/about");
      expect(event.response.headers.has("x-prerender")).toBe(false);
    });
  });

  it("is a no-op on the client", () => {
    expect(announceClient(Router)).toBe(false);
  });
});
