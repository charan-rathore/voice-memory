// Probe a real document the way a worried family member would: upload it
// through the public API, then ask questions from the document AND questions
// built to trip the agent (wrong patient, superseded values, drafts, bills,
// planted instructions, Hindi, typos, off-topic). Prints each answer and
// whether it meets the expectation, so failures are visible at a glance.
//
//   node scripts/probe-case.mjs                         # local server
//   VM_BASE=https://host node scripts/probe-case.mjs    # any deployment
//   node scripts/probe-case.mjs --only 3,7              # some questions
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const LOCAL = !process.env.VM_BASE;
const BASE = process.env.VM_BASE || "http://127.0.0.1:4519";
const root = new URL("../", import.meta.url);
const FILE =
  process.env.VM_PROBE_FILE ||
  "evaluation/case-file/harborline-adversarial.pdf";
const QS = JSON.parse(
  readFileSync(
    new URL(
      process.env.VM_PROBE_QS || "evaluation/case-file/questions.json",
      root,
    ),
    "utf8",
  ),
);
// Argument validation: an unsupported flag must fail loudly. A silently
// ignored flag once re-ran the MAIN suite while being reported as the
// holdout suite - a false validation record.
const KNOWN_FLAGS = new Set(["--only"]);
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith("--"))
    fail(`unexpected argument "${a}"; only flags are supported`);
  if (!KNOWN_FLAGS.has(a))
    fail(
      `unsupported flag "${a}"; supported: ${[...KNOWN_FLAGS].join(", ")} ` +
        `(suite selection is via VM_PROBE_QS, document via VM_PROBE_FILE)`,
    );
  if (a === "--only") {
    if (!args[i + 1] || args[i + 1].startsWith("--"))
      fail("--only needs a comma-separated list, e.g. --only 3,7");
    i++; // the value is consumed with the flag
  }
}
// Optional explicit API patient selection. There is no UI selector yet.
// Set VM_PROBE_PATIENT or a per-question patient to exercise selected context.
const PATIENT = process.env.VM_PROBE_PATIENT ?? null;
const onlyArg = process.argv.indexOf("--only");
const only =
  onlyArg > 0
    ? new Set(
        process.argv[onlyArg + 1].split(",").map((n) => {
          const v = Number(n);
          if (!Number.isInteger(v) || v < 1)
            fail(`--only entries must be positive integers, got "${n}"`);
          return v;
        }),
      )
    : null;
function fail(msg) {
  console.error(`probe-case: ${msg}`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  const r = await fetch(BASE + "/api/public" + path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(Error(body.error || r.status), { body });
  return body;
}

const expected = only ? only.size : QS.length;
const qsPath = process.env.VM_PROBE_QS || "evaluation/case-file/questions.json";
const canonical =
  !process.env.VM_PROBE_QS ||
  qsPath === "evaluation/case-file/questions-holdout.json";
const base = (p) => (p.split("/").pop() || "qs").replace(/\.[^.]+$/, "");
let suite = process.env.VM_PROBE_QS
  ? qsPath === "evaluation/case-file/questions-holdout.json"
    ? "holdout"
    : `custom-${base(qsPath)}`
  : process.env.VM_PROBE_FILE
    ? `custom-${base(FILE)}`
    : "main";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const questionHash = hash(readFileSync(new URL(qsPath, root)));
const documentHash = hash(readFileSync(new URL(FILE, root)));
if (PATIENT || !canonical || process.env.VM_PROBE_FILE)
  suite += `-${hash(JSON.stringify([questionHash, documentHash, PATIENT])).slice(0, 12)}`;
const artifactPath = `evaluation/results/case-probe-${suite}${only ? "-partial" : ""}.json`;
const runMeta = {
  runId: randomUUID(),
  command: process.argv,
  patient: PATIENT,
  env: {
    VM_PROBE_QS: process.env.VM_PROBE_QS ?? null,
    VM_PROBE_FILE: process.env.VM_PROBE_FILE ?? null,
    VM_PROBE_PATIENT: PATIENT,
  },
  questionHash,
  documentHash,
  startedAt: new Date().toISOString(),
};
for (const n of only ?? [])
  if (n > QS.length) fail(`--only index ${n} exceeds ${QS.length} questions`);
mkdirSync(new URL("evaluation/results/", root), { recursive: true });
writeFileSync(
  new URL(artifactPath, root),
  JSON.stringify({ ...runMeta, status: "running", exitCode: null }),
);

let server;
if (LOCAL) {
  server = spawn(process.execPath, ["scripts/site-dev.mjs"], {
    cwd: new URL(".", root),
    env: {
      ...process.env,
      SITE_PORT: "4519",
      VM_PUBLIC_ASK_PER_MIN: "100000",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 300; i++) {
    if (
      await fetch(BASE + "/api/public/cases")
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await sleep(100);
  }
}
try {
  const { id: ws } = await api("/workspace", { method: "POST" });
  const t0 = performance.now();
  await api(`/workspace/${ws}/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(FILE.split("/").pop()),
    },
    body: readFileSync(new URL(FILE, root)),
  });
  let answerable = null;
  let st;
  for (;;) {
    st = await api(`/workspace/${ws}`);
    const d = st.documents[0];
    if (d?.answerable && answerable == null)
      answerable = Math.round(performance.now() - t0);
    if (/^(ready|needs_review|failed)$/.test(d?.status ?? "")) break;
    if (performance.now() - t0 > 180000) throw Error("timeout");
    await sleep(100);
  }
  const ready = Math.round(performance.now() - t0);
  const d = st.documents[0];
  console.log(
    `upload: answerable ${answerable} ms, ${d.status} ${ready} ms, pages ${d.pages}` +
      (d.review?.length ? `\n  review: ${d.review.join(" | ")}` : ""),
  );
  const out = [];
  let pass = 0;
  let asked = 0;
  for (const [i, q] of QS.entries()) {
    if (only && !only.has(i + 1)) continue;
    const t = performance.now();
    const a = await api("/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        case: ws,
        question: q.ask,
        // Explicit current-patient context, as the screen would send:
        // per-question override, else the suite-level VM_PROBE_PATIENT.
        ...((q.patient ?? PATIENT) ? { patient: q.patient ?? PATIENT } : {}),
      }),
    }).catch((e) => ({ error: e.message }));
    const ms = Math.round(performance.now() - t);
    const text = a.final?.text ?? a.lead?.text ?? a.error ?? "";
    const want = (q.want ?? []).map((w) => new RegExp(w, "i"));
    const never = (q.never ?? []).map((w) => new RegExp(w, "i"));
    const ok =
      want.every((r) => r.test(text)) && !never.some((r) => r.test(text));
    asked++;
    if (ok) pass++;
    out.push({ n: i + 1, ask: q.ask, ok, ms, kind: a.final?.kind, text });
    console.log(
      `\n${ok ? "PASS" : "FAIL"} ${String(i + 1).padStart(2)} (${ms} ms, ${a.final?.kind ?? "-"}) ${q.ask}\n     ${text.replace(/\s+/g, " ").slice(0, 420)}` +
        (ok ? "" : `\n     want ${q.want ?? []} never ${q.never ?? []}`),
    );
  }
  console.log(`\n${pass}/${asked} passed`);
  // Integrity: a partial run never wears the full-suite artifact name (a
  // 2/2 "pass" once overwrote the 35-question record); a run that asked
  // fewer questions than expected, or where any answer failed its
  // expectation, exits non-zero; and the canonical artifact names are
  // reserved for the canonical question file and document - any override
  // is named for its inputs, with the inputs recorded inside the artifact.
  if (asked !== expected) {
    console.error(`probe incomplete: asked ${asked} of ${expected}`);
    process.exitCode = 1;
  }
  {
    if (pass !== asked) {
      console.error(`probe failed: ${pass}/${asked} met expectations`);
      process.exitCode = 1;
    }
    mkdirSync(new URL("evaluation/results/", root), { recursive: true });
    writeFileSync(
      new URL(artifactPath, root),
      JSON.stringify(
        {
          ...runMeta,
          status:
            asked !== expected
              ? "incomplete"
              : pass !== asked
                ? "failed"
                : "passed",
          exitCode: process.exitCode ?? 0,
          at: new Date().toISOString(),
          suite,
          canonical:
            canonical && !only && !process.env.VM_PROBE_FILE && !PATIENT,
          questions: qsPath,
          questionCount: QS.length,
          patient: PATIENT,
          document: FILE,
          answerable,
          ready,
          pass,
          asked,
          out,
        },
        null,
        2,
      ) + "\n",
    );
  }
} finally {
  server?.kill();
}
