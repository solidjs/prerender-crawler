import { Title } from "@solidjs/meta";
import { Loading } from "solid-js";
import { Router } from "./router";

// The app root: the router and the site-wide layout. Pages live under
// src/routes; the build crawls them into static HTML starting from "/".
export default function App() {
  return (
    <Router>
      {props => (
        <>
          <Title>Static Solid</Title>
          <nav>
            <a href="/">Home</a>
            <a href="/posts">Posts</a>
          </nav>
          <Loading fallback={<main>Loading…</main>}>{props.children}</Loading>
        </>
      )}
    </Router>
  );
}
