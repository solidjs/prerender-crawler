// The data layer: server functions declared PRERENDERED. Each call a page
// makes during the build is captured as a static JSON artifact
// (dist/client/_static/…) keyed by the call's identity — function +
// arguments. In the built site, calling these fetches the artifact; no
// server runs anywhere. In dev they are ordinary live server functions.
//
// Note `publishedAt` is a real Date on both sides: rich results ride the
// same codec the live wire uses, so the artifact round-trips types
// faithfully.
import { query } from "@solidjs/router";
import { prerendered } from "@solidjs/prerender";
import { findPost, listPosts } from "./server/posts";

export const getPosts = query(
  prerendered(async () => {
    "use server";
    return listPosts();
  }),
  "posts"
);

export const getPost = query(
  prerendered(async (slug: string) => {
    "use server";
    return findPost(slug);
  }),
  "post"
);
