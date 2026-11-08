// The public reference tools (mcp/public-health.mjs) must stay labelled as
// general information, reject bad input before any network call, and
// keep only NLM links. Fixtures follow the documented response shapes;
// the live services are not called in tests.
import test from "node:test";
import assert from "node:assert/strict";
import {
  lookupTestCode,
  testEducation,
  parseLoinc,
  parseMedline,
  NOTICE,
} from "../mcp/public-health.mjs";
import { handle } from "../mcp/server.mjs";

const LOINC_BODY = [
  2,
  ["2160-0", "38483-4"],
  null,
  [
    ["2160-0", "Creatinine [Mass/volume] in Serum or Plasma", "mg/dL"],
    ["38483-4", "Creatinine [Mass/volume] in Blood", "mg/dL"],
  ],
];
const MEDLINE_BODY = {
  feed: {
    entry: [
      {
        title: { _value: "Creatinine Test" },
        link: [{ href: "https://medlineplus.gov/lab-tests/creatinine-test/" }],
        summary: {
          _value:
            "<p>A creatinine test measures &amp; checks kidney function.</p>",
        },
      },
      {
        title: { _value: "Not ours" },
        link: [{ href: "https://example.com/spam" }],
        summary: { _value: "x" },
      },
    ],
  },
};

const fake =
  (body, seen = []) =>
  async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, json: async () => body };
  };

test("LOINC lookup returns codes, labelled as external reference", async () => {
  const seen = [];
  const out = await lookupTestCode("creatinine", {
    fetch: fake(LOINC_BODY, seen),
  });
  assert.equal(out.kind, "external_reference");
  assert.equal(out.notice, NOTICE);
  assert.deepEqual(out.matches[0], {
    loinc: "2160-0",
    name: "Creatinine [Mass/volume] in Serum or Plasma",
    units: "mg/dL",
  });
  assert.match(
    seen[0],
    /^https:\/\/clinicaltables\.nlm\.nih\.gov\/api\/loinc_items\/v3\/search\?terms=creatinine&/,
  );
});

test("MedlinePlus education keeps only NLM links and strips HTML", async () => {
  const seen = [];
  const out = await testEducation("2160-0", {
    fetch: fake(MEDLINE_BODY, seen),
  });
  assert.equal(out.kind, "external_reference");
  assert.equal(out.topics.length, 1);
  assert.equal(
    out.topics[0].summary,
    "A creatinine test measures & checks kidney function.",
  );
  assert.match(seen[0], /mainSearchCriteria\.v\.c=2160-0/);
  assert.match(seen[0], /knowledgeResponseType=application%2Fjson/);
});

test("bad input is refused before any request", async () => {
  const seen = [];
  await assert.rejects(
    testEducation("creatinine", { fetch: fake({}, seen) }),
    /LOINC code/,
  );
  await assert.rejects(
    lookupTestCode("", { fetch: fake([], seen) }),
    /test name/,
  );
  assert.equal(seen.length, 0);
});

test("malformed or failing services give empty results or a clear error", async () => {
  assert.deepEqual(parseLoinc({ nope: 1 }), []);
  assert.deepEqual(parseLoinc([0, [], null, [["not-a-code", "x"]]]), []);
  assert.deepEqual(parseMedline({ feed: {} }), []);
  const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(lookupTestCode("tsh", { fetch: down }), /503/);
});

test("MCP exposes both tools and returns them as tool results", async () => {
  const list = await handle({ method: "tools/list" }, { remote: true });
  const names = list.tools.map((t) => t.name);
  assert.ok(
    names.includes("lookup_test_code") && names.includes("test_education"),
  );
  const r = await handle(
    {
      method: "tools/call",
      params: { name: "lookup_test_code", arguments: { name: "tsh" } },
    },
    { fetch: fake(LOINC_BODY) },
  );
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.kind, "external_reference");
});
