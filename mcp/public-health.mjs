// Public health reference lookups for agents (Hermes, Claude, any MCP
// client). Both services are free, key-less and run by the US National
// Library of Medicine:
//   - Clinical Tables LOINC search: maps a test name to its LOINC code
//     https://clinicaltables.nlm.nih.gov/apidoc/loinc_items/v3/doc.html
//   - MedlinePlus Connect: plain-language education for a LOINC code
//     https://medlineplus.gov/medlineplus-connect/web-service/
//
// Everything returned here is GENERAL information, never a fact about the
// person. Results always carry `kind: "external_reference"` and a notice,
// so an agent cannot mix them into the record-backed `answer` from
// ask_records. No numbers from these services ever become report values.

const LOINC_URL =
  "https://clinicaltables.nlm.nih.gov/api/loinc_items/v3/search";
const MEDLINE_URL = "https://connect.medlineplus.gov/service";
const LOINC_OID = "2.16.840.1.113883.6.1";
const TIMEOUT_MS = 6000;
export const NOTICE =
  "General reference from the US National Library of Medicine. It is not from this person's reports and says nothing about their results.";

const LOINC_CODE = /^\d{1,7}-\d$/;
const strip = (s) =>
  String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

async function getJson(url, fetchImpl) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, {
      signal: ctl.signal,
      headers: { accept: "application/json" },
    });
    if (!r.ok) throw new Error(`reference service answered ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError")
      throw new Error("reference service did not answer in time");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Clinical Tables answers [total, codes, extras, display]; with
// df=LOINC_NUM,LONG_COMMON_NAME,EXAMPLE_UCUM_UNITS each display row is
// [code, name, units].
export function parseLoinc(body, max = 5) {
  if (!Array.isArray(body) || !Array.isArray(body[3])) return [];
  return body[3]
    .slice(0, max)
    .map((row) => ({
      loinc: String(row?.[0] ?? ""),
      name: strip(row?.[1]),
      units: strip(row?.[2]) || null,
    }))
    .filter((x) => LOINC_CODE.test(x.loinc) && x.name);
}

// MedlinePlus Connect JSON: feed.entry[] with title._value,
// link[].href and summary._value (HTML).
export function parseMedline(body, max = 3) {
  const entries = body?.feed?.entry;
  if (!Array.isArray(entries)) return [];
  return entries
    .slice(0, max)
    .map((e) => {
      const link = (Array.isArray(e?.link) ? e.link : [e?.link]).find((l) =>
        /^https:\/\/([a-z0-9-]+\.)*(medlineplus|nlm\.nih)\.gov\//i.test(
          String(l?.href ?? ""),
        ),
      );
      const summary = strip(e?.summary?._value);
      return {
        title: strip(e?.title?._value),
        url: link?.href ?? null,
        summary: summary.length > 600 ? summary.slice(0, 597) + "..." : summary,
      };
    })
    .filter((x) => x.title && x.url);
}

export async function lookupTestCode(name, { fetch: f = fetch } = {}) {
  const terms = String(name ?? "").trim();
  if (!terms || terms.length > 80)
    throw new Error("name must be a test name of 1 to 80 characters");
  const q = new URLSearchParams({
    terms,
    df: "LOINC_NUM,LONG_COMMON_NAME,EXAMPLE_UCUM_UNITS",
    maxList: "5",
  });
  const matches = parseLoinc(await getJson(`${LOINC_URL}?${q}`, f));
  return {
    kind: "external_reference",
    source: "NLM Clinical Tables (LOINC)",
    notice: NOTICE,
    query: terms,
    matches,
  };
}

export async function testEducation(
  loinc,
  { fetch: f = fetch, language = "en" } = {},
) {
  const code = String(loinc ?? "").trim();
  if (!LOINC_CODE.test(code))
    throw new Error("loinc must be a LOINC code such as 2345-7");
  const q = new URLSearchParams({
    "mainSearchCriteria.v.cs": LOINC_OID,
    "mainSearchCriteria.v.c": code,
    knowledgeResponseType: "application/json",
    "informationRecipient.languageCode.c": language === "es" ? "es" : "en",
  });
  const topics = parseMedline(await getJson(`${MEDLINE_URL}?${q}`, f));
  return {
    kind: "external_reference",
    source: "MedlinePlus Connect",
    notice: NOTICE,
    loinc: code,
    topics,
  };
}

export const PUBLIC_TOOLS = [
  {
    name: "lookup_test_code",
    title: "Find a test's LOINC code",
    description:
      "Look up the standard LOINC code and usual units for a lab test name (NLM Clinical Tables). General reference only: never a value from the person's reports.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", minLength: 1, maxLength: 80 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "test_education",
    title: "Plain-language test explainer",
    description:
      "MedlinePlus pages explaining what a lab test measures, by LOINC code (get it from lookup_test_code). Keep this separate from record facts; it says nothing about the person's own results.",
    inputSchema: {
      type: "object",
      required: ["loinc"],
      properties: {
        loinc: { type: "string", pattern: "^\\d{1,7}-\\d$" },
        language: { type: "string", enum: ["en", "es"] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];
