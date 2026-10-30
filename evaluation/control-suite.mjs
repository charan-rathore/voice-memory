// Independent qualification controls for the scope/reporting claims repair.
// GROUND TRUTH FIXED HERE FIRST (2026-10-30), before any further code change.
// Each control builds its own corpus variant; expected outcomes below are the
// contract the engine must meet. Run: node evaluation/control-suite.mjs
import { readFileSync, readdirSync } from "node:fs";
import { importBundle, answer } from "../dist/engine.mjs";

const base = readdirSync("corpus-md")
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ title: f, text: readFileSync("corpus-md/" + f, "utf8") }));
const variant = (patch) =>
  base.map((d) => ({ title: d.title, text: patch(d.title, d.text) }));

let pass = 0,
  fail = 0;
const check = (name, cond, detail) => {
  if (cond) {
    pass++;
    console.log("PASS " + name);
  } else {
    fail++;
    console.log("FAIL " + name + " :: " + detail);
  }
};

// C1: independent paraphrase of the regions question (words not in the
// tuned probe set) must still resolve to two regions with caution.
{
  const r = answer(
    "What areas does the pilot cover initially?",
    importBundle(base),
  );
  check(
    "C1 regions paraphrase resolves two regions",
    !r.refused && /two regions/i.test(r.answer),
    JSON.stringify({ refused: r.refused, ans: (r.answer || "").slice(0, 120) }),
  );
}
// C2: independent paraphrase of the reporting question must resolve weekly confirmed.
{
  const r = answer(
    "Do we have an agreed status-update cadence?",
    importBundle(base),
  );
  check(
    "C2 reporting paraphrase resolves weekly",
    !r.refused && /weekly/i.test(r.answer),
    JSON.stringify({ refused: r.refused, ans: (r.answer || "").slice(0, 120) }),
  );
}
// C3: negation control - 02 says NOT confirmed; engine must not say confirmed.
{
  const v = variant((t, x) =>
    t.startsWith("02_")
      ? x.replace(
          "Weekly reporting is confirmed",
          "Weekly reporting is not confirmed",
        )
      : x,
  );
  const r = answer("Is weekly progress reporting confirmed?", importBundle(v));
  check(
    "C3 negated confirmation not reported as confirmed",
    r.refused ||
      !/confirmed/i.test(
        r.answer.replace(
          /not confirmed|unresolved|competing|not established/gi,
          "",
        ),
      ),
    JSON.stringify({ refused: r.refused, ans: (r.answer || "").slice(0, 200) }),
  );
}
// C4: revoked approval - a newer doc revokes the confirmation; must not say confirmed.
{
  const v = variant((t, x) =>
    t.startsWith("07_")
      ? x +
        "\n4. The earlier confirmation of weekly reporting is revoked; cadence is back under discussion.\n"
      : x,
  );
  const r = answer("Is weekly progress reporting confirmed?", importBundle(v));
  check(
    "C4 revoked confirmation not reported as confirmed",
    r.refused ||
      !/\bconfirmed\b/i.test(
        r.answer.replace(
          /revoked|not confirmed|unresolved|competing|not established/gi,
          "",
        ),
      ),
    JSON.stringify({ refused: r.refused, ans: (r.answer || "").slice(0, 200) }),
  );
}
// C5: proposed-only - strip 02's confirmation; must not claim confirmed.
{
  const v = variant((t, x) =>
    t.startsWith("02_")
      ? x.replace("Weekly reporting is confirmed; the client", "The client")
      : x,
  );
  const r = answer("Is weekly progress reporting confirmed?", importBundle(v));
  check(
    "C5 proposed-only not reported as confirmed",
    r.refused ||
      !/\bconfirmed\b/i.test(
        r.answer.replace(
          /not confirmed|unresolved|competing|not established/gi,
          "",
        ),
      ),
    JSON.stringify({ refused: r.refused, ans: (r.answer || "").slice(0, 200) }),
  );
}
// C6: multiple cadences - older daily proposal, newer confirmed weekly;
// answer must give weekly and not present daily as current.
{
  const v = variant((t, x) =>
    t.startsWith("01_")
      ? x.replace("weekly progress reporting", "daily progress reporting")
      : x,
  );
  const r = answer("Is weekly progress reporting confirmed?", importBundle(v));
  const dailyCurrent = /current[^.]*daily|daily[^.]*current/i.test(
    r.answer || "",
  );
  check(
    "C6 multiple cadences: weekly current, daily not current",
    !r.refused && /weekly/i.test(r.answer) && !dailyCurrent,
    JSON.stringify({ refused: r.refused, ans: (r.answer || "").slice(0, 200) }),
  );
}
console.log(`=== CONTROLS: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
