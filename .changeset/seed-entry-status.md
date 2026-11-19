---
"prerender-crawler": minor
---

A seeded page can declare the status it answers: `{ path: "/404", filename: "404.html", status: 404 }` writes a host's not-found page from a route that answers 404, where the run used to fail with `Prerendering /404 answered 404`. The page is written only when it answers exactly that status; any other status fails the run with the expected status in the message. Pages without `status`, including every discovered link, still fail on 4xx and 5xx. `sitemap()` (and `indexable`) now leaves out pages written with an error status.
