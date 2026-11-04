// The drill-down's numbers: change since the previous reading only when the
// engine's compare() allows it (same unit, exact numbers; corrected values
// never count), precision no finer than the printed values, and the
// distance to the printed range only for an exact value outside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { insightOf } from "../src/visual-summary.mjs";

const obs = (raw, unit, extra = {}) => ({
  key: "hb",
  raw,
  value: Number(String(raw).replace(/[<>]/g, "")),
  unit,
  comparator: /^[<>]/.test(raw) ? raw[0] : null,
  ...extra,
});
const series = (...list) =>
  list.map(([date, o]) => ({ date, current: o, superseded: [] }));

test("comparable readings: signed change, percent, printed precision", () => {
  const s = series(
    ["2026-09-03", obs("12.1", "g/dL")],
    ["2026-10-12", obs("12.9", "g/dL")],
  );
  const i = insightOf(
    s,
    s[1].current,
    { lowN: 13, highN: 17, low: "13.0", high: "17.0" },
    "below",
  );
  assert.deepEqual(i.change, {
    from: "12.1",
    to: "12.9",
    fromDate: "2026-09-03",
    toDate: "2026-10-12",
    abs: 0.8,
    pct: 6.6,
    direction: "higher",
  });
  assert.deepEqual(i.distance, { side: "below", by: 0.1, bound: "13.0" });
  assert.equal(i.notCompared, null);
  assert.equal(i.readings, 2);
});

test("different units: no number, a reason", () => {
  const s = series(
    ["2026-09-03", obs("1.2", "mg/dL")],
    ["2026-10-12", obs("106", "µmol/L")],
  );
  const i = insightOf(s, s[1].current, { lowN: 62, highN: 115 }, "within");
  assert.equal(i.change, null);
  assert.equal(i.notCompared, "unit");
  assert.equal(i.distance, null);
});

test("a bound like <0.05 is never subtracted from", () => {
  const s = series(
    ["2026-09-03", obs("<0.05", "mIU/L")],
    ["2026-10-12", obs("0.30", "mIU/L")],
  );
  const i = insightOf(
    s,
    s[1].current,
    { lowN: 0.4, highN: 4, low: "0.40" },
    "below",
  );
  assert.equal(i.change, null);
  assert.equal(i.notCompared, "bound");
  assert.deepEqual(i.distance, { side: "below", by: 0.1, bound: "0.40" });
});

test("one reading: nothing to compare, nothing claimed", () => {
  const s = series(["2026-10-12", obs("6.1", "%")]);
  const i = insightOf(
    s,
    s[0].current,
    { lowN: 4, highN: 5.6, high: "5.6" },
    "above",
  );
  assert.equal(i.change, null);
  assert.equal(i.notCompared, null);
  assert.deepEqual(i.distance, { side: "above", by: 0.5, bound: "5.6" });
});
