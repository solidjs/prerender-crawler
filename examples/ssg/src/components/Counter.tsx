import { createSignal } from "solid-js";

// Proof of hydration: static HTML, live interactivity.
export default function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <button type="button" onClick={() => setCount(count() + 1)}>
      Clicks: {count()}
    </button>
  );
}
