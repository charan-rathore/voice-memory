// Plain-language explanation safety suite. Checks properties over every test,
// question style and language, not single examples.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ingestFile } from "../ingest/index.mjs";
import { extractReport, parseValue } from "./observations.mjs";
import { clinicalTurn } from "./answer.mjs";
import {
  detectLang,
  position,
  explainOne,
  GLOSSARY,
  SOURCES,
} from "./explain.mjs";

// Words that frighten without informing, in each language. Disease names are
// banned outright: the assistant explains numbers, it does not diagnose.
const ALARM = {
  en: /\b(cancer|tumou?r|leukemia|failure|fatal|deadly|dangerous|emergency|serious(ly)? ill|disease|disorder|diabetes|prediabetes|anemia|anaemia|hypothyroid\w*|hyperthyroid\w*|kidney damage|worry|worried|alarming|scary|nothing to worry|you('re| are) (fine|healthy|ok))\b/i,
  hi: /(कैंसर|ट्यूमर|घातक|खतरनाक|खतरा|बीमारी है|डायबिटीज़?|मधुमेह|एनीमिया|चिंता की बात|घबराने|आप स्वस्थ हैं)/,
  hinglish:
    /\b(cancer|tumou?r|khatarnak|khatra|diabetes|anemia|ghabra\w*|chinta|aap (bilkul )?theek hain|healthy hain)\b/i,
};

const FILES = [
  "a-2026-09.pdf",
  "a-2026-10-prelim.pdf",
  "a-2026-10-amended.pdf",
  "c-2026-10.pdf",
];
let REPORTS;
async function reports() {
  if (REPORTS) return REPORTS;
  REPORTS = [];
  for (const f of FILES) {
    const r = await ingestFile(
      readFileSync(new URL("./fixtures/files/" + f, import.meta.url)),
      f,
    );
    REPORTS.push({ title: f, sourceId: f, ...extractReport(r.doc) });
  }
  return REPORTS;
}

const QUESTIONS = {
  en: (t) => [
    `What was my ${t} result?`,
    `Did my ${t} change since the last report?`,
    `Is my ${t} okay? for SYN-0001`,
  ],
  hinglish: (t) => [
    `Mera ${t} kitna hai? SYN-0001`,
    `Kya mera ${t} pichhli report se badla hai? SYN-0001`,
  ],
  hi: (t) => [
    `मेरा ${t} कितना है? SYN-0001`,
    `क्या मेरा ${t} पिछली रिपोर्ट से बदला है? SYN-0001`,
  ],
};

test("language detection: English, Devanagari Hindi, romanized Hinglish", () => {
  assert.equal(detectLang("What was my TSH result?"), "en");
  assert.equal(detectLang("मेरा TSH कितना है?"), "hi");
  assert.equal(detectLang("Mera TSH kitna hai?"), "hinglish");
  assert.equal(
    detectLang("Is Mera a name?"),
    "en",
    "one Hindi-looking word is not enough",
  );
});

test("every answer, in every language, avoids alarming words and diagnoses", async () => {
  const R = await reports();
  const tests = [
    "Hemoglobin",
    "HbA1c",
    "Creatinine",
    "Urea",
    "TSH",
    "Ferritin",
  ];
  let n = 0;
  for (const [lang, make] of Object.entries(QUESTIONS))
    for (const t of tests)
      for (const q of make(t)) {
        const a = clinicalTurn(q, R);
        assert.ok(a, `answered: ${q}`);
        assert.equal(a.lang, lang, `language kept for: ${q}`);
        assert.doesNotMatch(
          a.spoken,
          ALARM[lang],
          `${lang} alarm word in: ${a.spoken}`,
        );
        assert.doesNotMatch(
          a.spoken,
          ALARM.en,
          `English alarm word in: ${a.spoken}`,
        );
        n++;
      }
  assert.ok(n >= 40, `checked ${n} answers`);
});

test("Hindi answers are in Devanagari, Hinglish answers in Latin script", async () => {
  const R = await reports();
  const hi = clinicalTurn("मेरा TSH कितना है? SYN-0001", R).spoken;
  assert.ok((hi.match(/[ऀ-ॿ]/g) ?? []).length > 40, hi);
  const hl = clinicalTurn("Mera TSH kitna hai? SYN-0001", R).spoken;
  assert.doesNotMatch(hl, /[ऀ-ॿ]/, hl);
  assert.match(hl, /\b(hai|se|aur)\b/);
});

test("Devanagari test names are understood", async () => {
  const R = await reports();
  const a = clinicalTurn("मेरा फेरिटिन पिछली बार से बदला क्या? SYN-0001", R);
  assert.equal(a.verdict, "COMPARED");
  assert.equal(a.direction, "higher");
});

test("the lab's printed range is spoken exactly as printed", async () => {
  const R = await reports();
  const a = clinicalTurn("What was my TSH result? SYN-0001", R).spoken;
  assert.match(a, /range of 0\.40 to 4\.00/);
});

test("position: within, slightly, clearly; bounds never 'slightly'", () => {
  const o = (raw, range) => ({ raw, range, ...parseValue(raw) });
  assert.equal(position(o("50", "30-400")), "within");
  assert.equal(position(o("12.1", "13.0-17.0")), "below_slightly");
  assert.equal(position(o("0.30", "0.40-4.00")), "below_clearly");
  assert.equal(position(o("<0.05", "0.40-4.00")), "below_clearly");
  assert.equal(
    position(o("<0.39", "0.40-4.00")),
    "below_clearly",
    "a bound is never called slightly off",
  );
  assert.equal(position(o("17.5", "13.0-17.0")), "above_slightly");
  assert.equal(position(o("6.4", "4.0-5.6")), "above_clearly");
  assert.equal(position(o("Positive", "Negative")), "unknown");
});

test("tone matches position: perspective when slightly off, 'doctor soon' when clearly off, calm when within", () => {
  const o = (test, key, raw, range, flag = null) => ({
    test,
    key,
    raw,
    range,
    flag,
    unit: "x",
    ...parseValue(raw),
  });
  const slight = explainOne(
    o("Hemoglobin", "hemoglobin", "12.1", "13.0-17.0", "L"),
    "2026-09-03",
    "en",
  );
  assert.match(slight, /a little below/);
  assert.match(slight, /about 1 in 20 people without any illness/);
  assert.doesNotMatch(slight, /soon/);
  const clear = explainOne(
    o("TSH", "tsh", "0.30", "0.40-4.00", "L"),
    "2026-10-12",
    "en",
  );
  assert.match(clear, /clearly below/);
  assert.match(clear, /talking it through with your doctor soon/);
  const within = explainOne(
    o("Ferritin", "ferritin", "50", "30-400"),
    "2026-10-12",
    "en",
  );
  assert.match(within, /within this lab's range/);
  assert.doesNotMatch(within, /doctor/);
});

test("a printed critical flag is urgent but calm, in every language", () => {
  const o = {
    test: "Potassium",
    key: "potassium",
    raw: "6.9",
    range: "3.5-5.1",
    flag: "HH",
    unit: "mmol/L",
    ...parseValue("6.9"),
  };
  const en = explainOne(o, "2026-10-01", "en");
  assert.match(en, /marked this result as critical/);
  assert.match(en, /contact your doctor or clinic today/);
  assert.doesNotMatch(en, ALARM.en);
  assert.match(explainOne(o, "2026-10-01", "hi"), /आज ही/);
  assert.match(explainOne(o, "2026-10-01", "hinglish"), /aaj hi/);
});

test("general context only from the cited glossary; unknown tests get none", () => {
  for (const [k, g] of Object.entries(GLOSSARY)) {
    assert.ok(
      SOURCES[k]?.startsWith("https://medlineplus.gov/"),
      `${k} cites MedlinePlus`,
    );
    for (const lang of ["en", "hi", "hinglish"])
      assert.ok(g[lang]?.length > 20, `${k}.${lang}`);
  }
  const o = {
    test: "Zinc",
    key: "zinc",
    raw: "80",
    range: "60-120",
    flag: null,
    unit: "ug/dL",
    ...parseValue("80"),
  };
  assert.doesNotMatch(explainOne(o, "2026-10-01", "en"), /general background/);
});

test("comparisons still refuse across units, in the asker's language", async () => {
  const R = await reports();
  const hi = clinicalTurn(
    "क्या मेरा creatinine पिछली रिपोर्ट से बदला है? SYN-0001",
    R,
  );
  assert.equal(hi.verdict, "NOT_COMPARABLE");
  assert.match(hi.spoken, /यूनिट नहीं बदलता/);
});
