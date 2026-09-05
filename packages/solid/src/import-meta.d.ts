// `import.meta.env` is Vite's build-time constant surface (vitest supplies
// it too); other bundlers may leave it undefined, hence optional. Ambient
// only — never emitted into the published types. (Under NodeNext with
// `"type": "module"` every file is a module, so the augmentation must be
// declared global explicitly.)
declare global {
  interface ImportMeta {
    readonly env?: Record<string, unknown>;
  }
}

export {};
