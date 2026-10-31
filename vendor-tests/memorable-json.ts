// Diagnostics of memoRABLE's JSON import under zod 4 (compiled by the test).
import { importJson } from "../vendor/memorable/src/import/json/import-json";
import { parseText } from "../vendor/memorable/src/import/text/parse-text";

export function run() {
  const doc = parseText({
    text: "# Plan\n\n## Decisions\n- Use weekly reporting.\n\n## Actions\n- Maya to send the review by Friday.",
    label: "p.md",
  });
  if (!doc.ok) throw Error("parseText failed");
  const valid = {
    version: 1,
    title: doc.value.title,
    blocks: doc.value.blocks.map((b: any) => ({
      kind: b.kind,
      title: b.title,
      payload: b.payload,
    })),
  };
  const codes = (src: unknown) => {
    const r = importJson({ text: JSON.stringify(src), label: "t.json" });
    return r.ok ? ["ok"] : r.errors.map((d: any) => `${d.code}|${d.message}`);
  };
  const clone = () => JSON.parse(JSON.stringify(valid));
  const badKind = clone();
  badKind.blocks[0].kind = "mood";
  const badType = clone();
  badType.title = 42;
  const extra = clone();
  extra.colour = "blue";
  const badVersion = clone();
  badVersion.version = 2;
  return {
    valid: codes(valid),
    badKind: codes(badKind),
    badType: codes(badType),
    extra: codes(extra),
    badVersion: codes(badVersion),
  };
}
