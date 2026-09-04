import { describe, expect, it } from "vitest";
import { collectServerReferences } from "../src/references.ts";

describe("collectServerReferences", () => {
  it("reads ids through the compiler's aliased import", () => {
    const code = `
import { createServerReference as createServerReference_1 } from "@solidjs/web/server-functions";
import { query } from "@solidjs/router";
import { prerendered } from "@solidjs/prerender";
export const getPosts = query(prerendered(createServerReference_1("getPosts-1679f63b")), "posts");
export const getPost = query(prerendered(createServerReference_1("getPost-1679f63b")), "post");
export const again = createServerReference_1("getPost-1679f63b");
`;
    expect(collectServerReferences(code)).toEqual(["getPosts-1679f63b", "getPost-1679f63b"]);
  });

  it("accepts an unaliased import, any runtime specifier, and any quote style", () => {
    const code = `
import { createServerReference, GET } from 'my-runtime/client';
const a = createServerReference('a-1');
const b = GET(createServerReference(\`b-2\`));
`;
    expect(collectServerReferences(code)).toEqual(["a-1", "b-2"]);
  });

  it("ignores lookalikes: other bindings, member calls, non-literal ids", () => {
    const code = `
import { createServerReference as createServerReference_1 } from "@solidjs/web/server-functions";
import { registerServerReference as registerServerReference_1 } from "@solidjs/web/server-functions";
const serverFunction_1 = registerServerReference_1("server-side", async () => 1);
const ref = createServerReference_1(serverFunction_1);
const other = runtime.createServerReference_1("not-ours");
const notEvenImported = createServerReference_2("nope");
`;
    expect(collectServerReferences(code)).toEqual([]);
  });

  it("returns nothing for modules without the import", () => {
    expect(collectServerReferences(`export const x = createServerReference("x");`)).toEqual([]);
    expect(collectServerReferences(`export const y = 1;`)).toEqual([]);
  });
});
