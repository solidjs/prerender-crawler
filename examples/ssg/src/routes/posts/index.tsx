import { Title } from "@solidjs/meta";
import { For, createMemo } from "solid-js";
import { getPosts } from "../../data";

// The list is a prerendered server-function call: executed once at build
// time, baked into a static artifact. The links below are how the crawler
// discovers the post pages — no route list in any config.
export default function PostsIndex() {
  const posts = createMemo(() => getPosts());
  return (
    <section>
      <Title>Posts - Static Solid</Title>
      <ul>
        <For each={posts()}>
          {post => (
            <li>
              <a href={`/posts/${post.slug}`}>{post.title}</a>{" "}
              <small>{post.publishedAt.toISOString().slice(0, 10)}</small>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}
