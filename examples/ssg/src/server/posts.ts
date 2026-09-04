// Server-only data. In a real site this is a database, a CMS client, or a
// markdown loader — anything, because it only ever runs at BUILD time: the
// 'use server' functions in src/data.ts are the only importers, so none of
// this reaches the client bundle.
export interface Post {
  slug: string;
  title: string;
  body: string;
  publishedAt: Date;
}

const POSTS: Post[] = [
  {
    slug: "hello-world",
    title: "Hello, world",
    body: "The first post, served with zero servers.",
    publishedAt: new Date("2026-01-05T00:00:00Z")
  },
  {
    slug: "static-server-functions",
    title: "Static server functions",
    body: "This page's data was a typed server function call — executed once, at build time.",
    publishedAt: new Date("2026-02-11T00:00:00Z")
  },
  {
    slug: "crawl-discovers-pages",
    title: "The crawl discovers pages",
    body: "Nobody listed this page in config. The build followed a link here and prerendered it.",
    publishedAt: new Date("2026-03-20T00:00:00Z")
  }
];

export const listPosts = () => POSTS.map(({ slug, title, publishedAt }) => ({ slug, title, publishedAt }));

export const findPost = (slug: string) => POSTS.find(post => post.slug === slug) ?? null;
