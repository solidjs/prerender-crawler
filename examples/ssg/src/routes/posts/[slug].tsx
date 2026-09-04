import { Title } from "@solidjs/meta";
import { type RouteDefinition, type RouteProps } from "@solidjs/router";
import { Show, createMemo } from "solid-js";
import { getPost } from "../../data";

// A dynamic route, statically built: the crawler found each slug by
// following links from /posts, and each page's getPost(slug) call was
// captured as its own artifact — one file per argument list.
export const route = {
  preload: ({ params }) => void getPost(params.slug!)
} satisfies RouteDefinition;

export default function PostPage(props: RouteProps<"/posts/:slug">) {
  const post = createMemo(() => getPost(props.params.slug!));
  return (
    <Show when={post()} fallback={<p>No such post.</p>}>
      {found => (
        <article>
          <Title>{`${found().title} - Static Solid`}</Title>
          <h2>{found().title}</h2>
          <p>
            <time>{found().publishedAt.toISOString().slice(0, 10)}</time>
          </p>
          <p>{found().body}</p>
          <p>
            <a href="/posts">Back to posts</a>
          </p>
        </article>
      )}
    </Show>
  );
}
