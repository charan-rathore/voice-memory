// Real-world report layouts, reproduced with fictional values: the shapes
// found in public sample reports (Indian, Pakistani, US and Drlogy-style
// labs) that the synthetic fixtures never had. Each case here was a failure
// before lab-lines.mjs: a header on its own line, method lines between rows,
// sex- and age-specific ranges, flags inside the range cell, Indian digit
// grouping, qualitative serology, prose that must NOT become a result.
import test from "node:test";
import assert from "node:assert/strict";
import { readLabLine, parseReference, genericMeta } from "./lab-lines.mjs";
import { extractReport } from "./observations.mjs";
import { clinicalAnswer } from "./answer.mjs";
import { canonOf } from "./explain.mjs";

test("rows in real layouts are read by content, not column position", () => {
  const cases = [
    [
      "| HAEMOGLOBIN PERCENTAGE | 14.2 | g/dl | 13-99 YRS,Male:13.5-18 |",
      { test: "HAEMOGLOBIN PERCENTAGE", raw: "14.2", unit: "g/dl" },
    ],
    [
      "DIRECT BILIRUBIN 0.42 mg/ dL 0-0.3",
      { test: "DIRECT BILIRUBIN", raw: "0.42", unit: "mg/dL", range: "0-0.3" },
    ],
    [
      "Hemoglobin (Hb) 12.1 Low 13.0 - 17.0 g/dL",
      {
        test: "Hemoglobin (Hb)",
        raw: "12.1",
        unit: "g/dL",
        flag: "Low",
        range: "13.0 - 17.0",
      },
    ],
    [
      "Hemoglobin: 13.1 g/dL (Normal Range: Female: 11-15 g/dL)",
      { test: "Hemoglobin", raw: "13.1", unit: "g/dL" },
    ],
    [
      "Neutrophils: 67% (Normal Range: 45 - 70 %)",
      { test: "Neutrophils", raw: "67", unit: "%" },
    ],
    [
      "Triglyceride H 168.0 mg/dL Normal : <150",
      { test: "Triglyceride", raw: "168.0", unit: "mg/dL", flag: "H" },
    ],
    [
      "| DENGUE NS1 ANTIGEN | POSITIVE | NEGATIVE |",
      { test: "DENGUE NS1 ANTIGEN", qual: "positive", range: "NEGATIVE" },
    ],
    [
      "| Platelet Count | 383000 | µL | 1,50,000 - 4,10,000 |",
      { test: "Platelet Count", raw: "383000", value: 383000 },
    ],
  ];
  for (const [line, want] of cases) {
    const r = readLabLine(line);
    assert.ok(r, `read: ${line}`);
    for (const [k, v] of Object.entries(want))
      assert.equal(r[k], v, `${line} -> ${k}`);
  }
});

test("prose, metadata and footnotes never become results", () => {
  for (const line of [
    "Age : 23 Yrs 8 Days Bill #: 189455",
    "Amended 15 October 2026: ferritin result corrected from 5 to 50 (transcription error).",
    "4. Values <0.04 mU/L need to be clinically correlated due to presence of a rare TSH variant",
    "HGB is below normal.",
    "Name : Mr Test Person Date:11/06/2026 11:23 AM",
    "Child: 2 - 6 years",
    "TEST NAME RESULTS UNIT REFERENCE VALUES",
  ])
    assert.equal(readLabLine(line), null, line);
});

test("reference ranges: the patient's sex, adults only, Indian grouping, open bounds", () => {
  assert.deepEqual(
    [parseReference("13-99 YRS,Male:13.5-18", "male")].map((r) => [
      r.lowN,
      r.highN,
    ]),
    [[13.5, 18]],
  );
  const mf = parseReference("M:13-17 F:12.0-15.0", "female");
  assert.deepEqual([mf.lowN, mf.highN], [12, 15]);
  assert.equal(
    parseReference("M:13-17 F:12.0-15.0", null),
    null,
    "sex unknown, ranges differ: no range",
  );
  const same = parseReference("Male:35-104 Female : 35-104", null);
  assert.deepEqual(
    [same.lowN, same.highN],
    [35, 104],
    "identical for both sexes",
  );
  const indian = parseReference("1,50,000 - 4,10,000");
  assert.deepEqual([indian.lowN, indian.highN], [150000, 410000]);
  const lt = parseReference("< 150 mg/dL");
  assert.equal(lt.lowN, -Infinity);
  assert.equal(lt.highN, 150);
  assert.equal(
    parseReference("Low: < 40 mg/dL, High: > 60 mg/dL"),
    null,
    "risk categories are not a range",
  );
  assert.equal(parseReference("NEGATIVE").expected, "negative");
  assert.equal(
    parseReference("Adults: 4,000-10,000", "male", 3).adultOnly,
    true,
    "a child is not judged by adult ranges",
  );
  const pm = parseReference("13-99 YRS,M/F:=32.5 +/- 2.5", "male");
  assert.deepEqual([pm.lowN, pm.highN], [30, 35]);
});

test("report headers: name, ID, sex, age; numeric dates only when unambiguous", () => {
  const a = genericMeta(
    "| Name | : Test Person |  |  |\n| Lab No. | : 439854467 | Age | : 30 Years |\n| Ref By | : U | Gender | : Male |\n| Collected | : 14/5/2023 11:03AM | Reported | : 16/5/2023 1:36PM |",
  );
  assert.equal(a.patient.name, "Test Person");
  assert.equal(a.patient.id, "439854467");
  assert.equal(a.patient.sex, "male");
  assert.equal(a.patient.age, 30);
  assert.equal(a.collected, "2023-05-14");
  const b = genericMeta(
    "Name : Mr Test Person            Date:11/06/2026 11:23 AM\nAge : 23 Yrs 8 Days\nUHID : 52672\nSex : Male",
  );
  assert.equal(b.collected, null, "11/06 could be June or November");
  assert.equal(b.dateRaw, "11/06/2026");
  assert.equal(b.patient.id, "52672");
  const c = genericMeta(
    "Patient Name: MR. TEST    MR #: AKRH-000000-25   Sampled: 12-Apr-2025 7:49PM\nGender: Male",
  );
  assert.equal(c.collected, "2025-04-12");
});

test("printed names map to one test: abbreviations, spellings, extra generic words", () => {
  assert.equal(canonOf("HAEMOGLOBIN PERCENTAGE"), "hemoglobin");
  assert.equal(canonOf("ALANINE AMINOTRANSFERASE ALT (SGPT)"), "alt");
  assert.equal(canonOf("MEAN CORPUSCULAR HB CONCENTRATION"), "mchc");
  assert.equal(canonOf("Total WBC count"), "wbc");
  assert.equal(canonOf("Bilirubin Direct"), "bilirubin");
  assert.equal(
    canonOf("Hb A2"),
    null,
    "a hemoglobin fraction is not hemoglobin",
  );
});

// One fictional report in the layout of a real Indian lab printout.
const TEXT = `Name : Mr Test Person            Date:11/06/2026 11:23 AM
Age : 23 Yrs 8 Days               Bill #: 100001
UHID : 90001                      Reported On : 11/06/2026 03:58 PM
Sex : Male

TEST NAME RESULTS UNIT REFERENCE VALUES

HAEMATOLOGY

| HAEMOGLOBIN PERCENTAGE | 14.2 | g/dl | 13-99 YRS,Male:13.5-18 |
| --- | --- | --- | --- |
| TOTAL WBC COUNT | 7400 | /Cmm | 13-99 YRS,M/F:4000-11000 |
| NEUTROPHILS | 82.0 | % | 13-99 YRS,M/F:40-75 |
| PLATELET COUNT | 121000 | /Cmm | 140000 - 440000 |

LIVER FUNCTION TEST- LFT

DIRECT BILIRUBIN 0.42 mg/ dL 0-0.3

Diazo

ALANINE AMINOTRANSFERASE ALT (SGPT) 30 U/ L Male:21-72

IFCC

DENGUE PROFILE

| DENGUE ANTIBODY IGM | NEGATIVE | NEGATIVE |
| --- | --- | --- |
| DENGUE NS1 ANTIGEN | POSITIVE | NEGATIVE |`;
const report = () => {
  const r = extractReport({ text: TEXT, elements: [] });
  return [
    {
      ...r,
      title: "my-report.pdf",
      sourceId: "s1",
      haystack: ` ${TEXT.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `,
    },
  ];
};
const ALARM =
  /\b(cancer|disease|disorder|diabetes|anemia|worry|dangerous|emergency|you('re| are) (fine|healthy))\b/i;

test("a real-layout report answers the questions people actually ask", () => {
  const R = report();
  assert.equal(R[0].observations.length, 8);
  const sum = clinicalAnswer(
    "does this patient have some critical symptoms? what exactly is this report suggesting",
    R,
  );
  assert.equal(sum.verdict, "FLAGGED");
  assert.match(sum.spoken, /^A lab report shows test results, not symptoms/);
  assert.match(
    sum.spoken,
    /dengue NS1 antigen is positive, where the lab expects negative/,
  );
  assert.match(
    sum.spoken,
    /platelet count 121000 \/Cmm \(below the 140000 to 440000 range\)/,
  );
  assert.match(sum.spoken, /I can't diagnose/);
  assert.doesNotMatch(sum.spoken, ALARM);
  assert.ok(sum.used.length >= 4, "flagged results are cited");

  const plt = clinicalAnswer("my platlets are low?", R);
  assert.match(plt.spoken, /platelet count result is 121000 \/Cmm/);
  const dengue = clinicalAnswer("Is the dengue test positive?", R);
  assert.match(
    dengue.spoken,
    /dengue NS1 antigen positive, where the lab expects negative/,
  );
  assert.match(dengue.spoken, /dengue antibody IgM negative, as expected/);
  const liver = clinicalAnswer("How is my liver?", R);
  assert.match(
    liver.spoken,
    /^For your liver tests: direct bilirubin 0\.42 mg\/dL, above the 0 to 0\.3 range/,
  );
  const sgpt = clinicalAnswer("what's my SGPT", R);
  assert.match(
    sgpt.spoken,
    /ALT \(SGPT\) result is 30 U\/L, from 11\/06\/2026\. That's within this lab's range of 21 to 72/,
  );
  const tsh = clinicalAnswer("What is my TSH?", R);
  assert.equal(tsh.verdict, "NOT_IN_REPORT");
  assert.match(tsh.spoken, /^I don't see a TSH result in these reports\./);
  const hi = clinicalAnswer("मेरी रिपोर्ट में क्या गड़बड़ है?", R);
  assert.match(hi.spoken, /लैब की सीमा से बाहर हैं/);
  const hinglish = clinicalAnswer("kya meri report mein sab theek hai?", R);
  assert.match(hinglish.spoken, /range se bahar hain/);
  assert.equal(
    clinicalAnswer("Who prepared this report?", R),
    null,
    "not a lab question",
  );
});
