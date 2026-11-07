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
  // The resolver never picks between conflicting or foreign bands.
  assert.equal(
    parseReference("Male:3.5-5.0 Male:4.0-7.0", "male"),
    null,
    "duplicate same-sex bands that disagree abstain",
  );
  assert.equal(
    parseReference("Female:3.0-4.5", "male"),
    null,
    "a sole opposite-sex band is not this patient's range",
  );
  assert.equal(
    parseReference("13-99 YRS", "male"),
    null,
    "a lone age span is an age band, not a reference interval",
  );
  assert.equal(
    parseReference("11.5-15.5child;13-17adult;14-18adult", "male"),
    null,
    "duplicate adult bands that disagree abstain",
  );
  assert.equal(
    parseReference("3.5-5.0;4.0-7.0", null),
    null,
    "distinct unlabelled bands abstain",
  );
  assert.deepEqual(
    [parseReference("Male:35-104 Male: 35-104", "male")].map((r) => [
      r.lowN,
      r.highN,
    ])[0],
    [35, 104],
    "identical duplicates coalesce",
  );
});
test("reference ranges: child report, band labels glued to numbers (no spaces)", () => {
  // RED 2026-11-03: the printed corpus format "11.5-15.5child;13-17adult"
  // (no spaces around band labels) slipped past the adult-band guard and a
  // 7-year-old's 11.3 was judged against the adult 13-17 band.
  for (const printed of [
    "11.5-15.5child;13-17adult",
    "11.5-15.5child / 13-17adult",
    "11.5-15.5 child; 13-17 adult",
    "11.5-15.5 (child); 13-17 (adult)",
    "Child: 11.5-15.5; Adult: 13-17",
  ]) {
    const r = parseReference(printed, null, 7);
    assert.equal(
      r?.adultOnly,
      true,
      `${printed}: adult band must never judge a child`,
    );
    assert.equal(r?.lowN, null, `${printed}: no adult numbers adopted`);
    assert.equal(r?.highN, null, `${printed}: no adult numbers adopted`);
  }
  // Plain adult ranges are untouched: adult patient and unknown age.
  const plain = parseReference("13-17");
  assert.deepEqual([plain.lowN, plain.highN], [13, 17]);
  const adult = parseReference("13-17", null, 40);
  assert.deepEqual([adult.lowN, adult.highN], [13, 17]);
});

test("report headers: name, ID, sex, age; numeric dates only when unambiguous", () => {
  const a = genericMeta(
    "| Name | : Test Person |  |  |\n| Lab No. | : 439854467 | Age | : 30 Years |\n| Ref By | : U | Gender | : Male |\n| Collected | : 14/5/2023 11:03AM | Reported | : 16/5/2023 1:36PM |",
  );
  assert.equal(a.patient.name, "Test Person");
  // Lab No. names the order/specimen, not the person: kept, never an identity
  assert.equal(a.patient.id, null);
  assert.equal(a.accession, "439854467");
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
  // Three flagged results are judged and cited (dengue NS1, platelets,
  // bilirubin); the neutrophils band "13-99 YRS,M/F:40-75" is applicability-
  // labelled provenance, quoted but never judged.
  assert.ok(sum.used.length >= 3, "flagged results are cited");

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
  // "Male:21-72" is a sex-labelled band: quoted as printed, never judged.
  assert.match(sgpt.spoken, /ALT \(SGPT\) result is 30 U\/L/);
  assert.match(sgpt.spoken, /21-72/);
  assert.match(sgpt.spoken, /can't judge|haven't compared|haven't judged/i);
  assert.doesNotMatch(sgpt.spoken, /within this lab's range/i);
  const tsh = clinicalAnswer("What is my TSH?", R);
  assert.equal(tsh.verdict, "NOT_IN_REPORT");
  assert.match(tsh.spoken, /^I don't see a TSH result in these reports\./);
  // "an" only for vowel sounds: a ferritin, an ESR, an SGOT.
  const fer = clinicalAnswer("Is his ferritin in the report?", R);
  assert.match(fer.spoken, /^I don't see a ferritin result/);
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

test("a named ratio is its own result even with no unit or range", () => {
  // LalPath WM14 prints "| BUN/Creatinine Ratio | 14 |  |  |": a real result
  // that the bare-number guard ("Age 23") must not keep swallowing.
  const row = readLabLine("| BUN/Creatinine Ratio | 14 |  |  |");
  assert.equal(row.test, "BUN/Creatinine Ratio");
  assert.equal(row.value, 14);
  const text =
    "Creatinine, Serum 0.86 mg/dL 0.67 - 1.17\nBUN/Creatinine Ratio 14\n";
  const R = [
    {
      ...extractReport({ text, elements: [] }),
      title: "kidney.pdf",
      sourceId: "s1",
      haystack: ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `,
    },
  ];
  const ans = clinicalAnswer("What is the BUN creatinine ratio?", R);
  assert.match(ans.spoken, /BUN\/Creatinine Ratio result is 14/);
  assert.doesNotMatch(ans.spoken, /0\.86/, "never substitutes creatinine");
  // The noise guard still stands: a bare "Ratio"/"Score" with nothing it
  // belongs to is the same junk as "Age 23".
  assert.equal(readLabLine("Age 23"), null);
  assert.equal(readLabLine("Bill 189455"), null);
  assert.equal(readLabLine("Ratio 2"), null);
  assert.equal(readLabLine("Score 5"), null);
  // Named dimensionless results read clean.
  assert.equal(readLabLine("Body Mass Index 27.2").value, 27.2);
  assert.equal(readLabLine("CD4/CD8 Ratio 1.8").value, 1.8);
});

test("risk-category table bleed never becomes an observation", () => {
  // WM14's LDL risk table bleeds "| Moderate | 100 | <130 ≥100 ≥130 |".
  assert.equal(readLabLine("| Moderate | 100 | <130 ≥100 ≥130 |"), null);
});

test("a row an overlaid stamp crosses answers with provenance, never certainty", () => {
  // WM14 shape: the "Sample Report" stamp crosses the BUN/Creatinine Ratio
  // row. The text layer holds a value; the page does not show it readably.
  const elements = [
    {
      id: "e1",
      type: "table",
      page: 1,
      bbox: [40, 420, 535, 470],
      method: "pdf-text",
    },
    {
      id: "e1.r0",
      parent: "e1",
      type: "table-header",
      cells: ["Test Name", "Results", "Units", "Bio. Ref. Interval"],
      page: 1,
      bbox: [40, 420, 535, 430],
      method: "pdf-text",
      start: 0,
      end: 10,
    },
    {
      id: "e1.r1",
      parent: "e1",
      type: "table-row",
      cells: ["BUN/Creatinine Ratio", "14", "", ""],
      page: 1,
      bbox: [40, 425, 282, 436],
      method: "pdf-text",
      start: 11,
      end: 30,
    },
    {
      id: "e1.r2",
      parent: "e1",
      type: "table-row",
      cells: ["Creatinine", "0.86", "mg/dL", "0.67 - 1.17"],
      page: 1,
      bbox: [40, 445, 535, 455],
      method: "pdf-text",
      start: 31,
      end: 50,
    },
    {
      id: "w1",
      type: "overlay",
      text: "Sample Report",
      page: 1,
      bbox: [232, 376, 377, 430],
      method: "pdf-text",
    },
  ];
  const rep = extractReport({ text: "", elements });
  const ratio = rep.observations.find((o) => /ratio/i.test(o.test));
  const creat = rep.observations.find((o) => o.test === "Creatinine");
  assert.equal(ratio.suspectObscured, true, "stamp-crossed row flagged");
  assert.equal(creat.suspectObscured, undefined, "clear row untouched");
  const R = [
    {
      ...rep,
      title: "stamped.pdf",
      sourceId: "s1",
      haystack: " creatinine bun ratio ",
    },
  ];
  const ans = clinicalAnswer("What is the BUN creatinine ratio?", R);
  assert.match(ans.spoken, /embedded text reads 14/);
  assert.match(ans.spoken, /can't confirm it from the page/);
  assert.doesNotMatch(ans.spoken, /Your BUN\/Creatinine Ratio result is 14/);
  assert.doesNotMatch(ans.spoken, /range/i && /within this lab's range/);
  // An unobscured row in the same report answers exactly as before.
  const c = clinicalAnswer("What is the creatinine result?", R);
  assert.match(c.spoken, /Your Creatinine result is 0.86 mg\/dL/);
  assert.match(c.spoken, /within this lab's range/);
});

test("no distance math against a limit a stamp may be covering", () => {
  const elements = [
    {
      id: "e1",
      type: "table",
      page: 1,
      bbox: [40, 340, 535, 365],
      method: "pdf-text",
    },
    {
      id: "e1.r0",
      parent: "e1",
      type: "table-header",
      cells: ["Test Name", "Results", "Units", "Bio. Ref. Interval"],
      page: 1,
      bbox: [40, 340, 535, 350],
      method: "pdf-text",
      start: 0,
      end: 10,
    },
    {
      id: "e1.r1",
      parent: "e1",
      type: "table-row",
      cells: ["LDL Cholesterol, Calculated", "160.20", "mg/dL", "<100.00"],
      page: 1,
      bbox: [40, 352, 535, 362],
      method: "pdf-text",
      start: 11,
      end: 40,
    },
    {
      id: "w1",
      type: "overlay",
      text: "Sample Report",
      page: 1,
      bbox: [232, 350, 556, 420],
      method: "pdf-text",
    },
  ];
  const rep = extractReport({ text: "", elements });
  const R = [
    {
      ...rep,
      title: "stamped.pdf",
      sourceId: "s1",
      haystack: " ldl cholesterol ",
    },
  ];
  const ans = clinicalAnswer("How far above the LDL limit is it?", R);
  assert.doesNotMatch(ans.spoken, /above the lab's upper limit/);
  assert.match(ans.spoken, /can't confirm it from the page/);
});

test("a stamped copy answers with embedded-text provenance and a caveat", () => {
  // LalPath WM14 shape: a declared Watermark annotation on the page whose
  // appearance stream the text layer cannot see, so any cell may be
  // covered: values are spoken as embedded-text reads, never as print.
  const elements = [
    {
      id: "e1",
      type: "table",
      page: 1,
      bbox: [40, 340, 535, 365],
      method: "pdf-text",
    },
    {
      id: "e1.r0",
      parent: "e1",
      type: "table-header",
      cells: ["Test Name", "Results", "Units", "Bio. Ref. Interval"],
      page: 1,
      bbox: [40, 340, 535, 350],
      method: "pdf-text",
      start: 0,
      end: 10,
    },
    {
      id: "e1.r1",
      parent: "e1",
      type: "table-row",
      cells: ["BUN/Creatinine Ratio", "14", "", ""],
      page: 1,
      bbox: [40, 352, 282, 362],
      method: "pdf-text",
      start: 11,
      end: 40,
    },
  ];
  const pages = [{ number: 1, watermark: true }];
  const rep = extractReport({ text: "", elements, pages });
  const ratio = rep.observations[0];
  assert.equal(ratio.stampedCopy, true);
  assert.equal(ratio.suspectObscured, undefined, "no visible stamp text");
  const R = [
    { ...rep, title: "stamped.pdf", sourceId: "s1", haystack: " bun ratio " },
  ];
  const ans = clinicalAnswer("What is the BUN creatinine ratio?", R);
  assert.match(ans.spoken, /^The report's embedded text reads 14/);
  assert.match(ans.spoken, /overlaid stamp/);
  assert.doesNotMatch(ans.spoken, /Your BUN\/Creatinine Ratio result is 14/);
  // The unit is not asserted as printed fact either.
  assert.doesNotMatch(ans.spoken, /reads 14 mg\/dL/);
  // Hinglish keeps the same provenance and caveat.
  const hg = clinicalAnswer("Cholesterol kitna hai?", [
    {
      ...extractReport({
        text: "Cholesterol, Total 250.70 mg/dL <200.00\n",
        elements: [],
        pages,
      }),
      title: "stamped2.pdf",
      sourceId: "s2",
      haystack: " cholesterol ",
    },
  ]);
  assert.match(
    hg.spoken,
    /embedded text mein Cholesterol, Total ka result 250.70 mg\/dL likha hai/,
  );
  assert.match(hg.spoken, /overlaid stamp/);
});

test("an unstamped report keeps the plain printed-value wording", () => {
  const rep = extractReport({
    text: "Creatinine, Serum 0.86 mg/dL 0.67 - 1.17\n",
    elements: [],
    pages: [{ number: 1 }],
  });
  const R = [
    { ...rep, title: "plain.pdf", sourceId: "s1", haystack: " creatinine " },
  ];
  const ans = clinicalAnswer("What is the creatinine result?", R);
  assert.match(ans.spoken, /Your Creatinine, Serum result is 0.86 mg\/dL/);
  assert.doesNotMatch(ans.spoken, /overlaid stamp|embedded text/);
});
