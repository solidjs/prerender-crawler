// The build handshake `prerendered`'s client half reads. This file is
// the DEFAULT — the posture of a dev server or a build without the
// prerender plugin: no artifacts exist, so static references call through
// to their server functions like ordinary GET references (the app degrades
// to a live-server deployment, nothing breaks). During `vite build`, the
// prerender plugin swaps this module in the client environment for one
// answering `staticArtifacts: true` (plus the app's base path), which is
// what flips the client half from dispatching calls to fetching artifacts.
export interface PrerenderEnv {
  /** Whether the build wrote static artifacts for `prerendered` calls. */
  staticArtifacts: boolean;
  /** The app's public base path (Vite `base`); artifact URLs resolve under it. */
  base: string;
  /**
   * Whether a missing artifact falls back to live GET dispatch. True in
   * hybrid mode (a server exists to answer calls the build never made);
   * false in static mode (no server — a miss is a hard error).
   */
  fallback: boolean;
}

export const env: PrerenderEnv = {
  staticArtifacts: false,
  base: "/",
  fallback: true
};
