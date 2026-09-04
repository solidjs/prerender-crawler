import type { ParentProps } from "solid-js";
import { HydrationScript } from "@solidjs/web";

// The document shell: wraps the app in the plugin's generated entries and
// renders the full <html>. Every page of this site is prerendered from it.
export default function Document(props: ParentProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Static Solid</title>
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
