import { Title } from "@solidjs/meta";
import Counter from "../components/Counter";

export default function Home() {
  return (
    <main>
      <Title>Home - Static Solid</Title>
      <h1>Every page here is a file.</h1>
      <p>
        Built with streaming SSR at build time, deployed as plain HTML and JSON. The counter
        below hydrates and works — this is a full Solid app, it just has no server.
      </p>
      <Counter />
      <p>
        <a href="/posts">Read the posts</a> — their data comes from server functions executed
        during the build.
      </p>
    </main>
  );
}
