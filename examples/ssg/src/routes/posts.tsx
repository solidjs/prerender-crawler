import type { ParentProps } from "solid-js";

// Layout route: wraps the posts index and every post page.
export default function PostsLayout(props: ParentProps) {
  return (
    <main>
      <h1>Posts</h1>
      {props.children}
    </main>
  );
}
