// probe-case.mjs argument validation: unsupported flags must fail loudly.
// A silently ignored "--holdout" flag once re-ran the MAIN question file
// while being reported as a holdout pass - a false validation record.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("../scripts/probe-case.mjs", import.meta.url).pathname;

const run = (args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

test("unsupported flags exit non-zero with a named error", () => {
  for (const args of [["--holdout"], ["--bogus"], ["positional"]]) {
    const r = run(args);
    assert.notEqual(r.status, 0, `${args}: must not silently run`);
    assert.match(r.stderr, /probe-case: /, `${args}: error names the problem`);
    assert.equal(r.stdout.includes("passed"), false, `${args}: no suite ran`);
  }
});

test("malformed --only values exit non-zero", () => {
  for (const args of [["--only"], ["--only", "abc"], ["--only", "0"]]) {
    const r = run(args);
    assert.notEqual(r.status, 0, `${args}`);
    assert.match(r.stderr, /--only/, `${args}`);
  }
});

test("failed invocations replace stale artifacts with this invocation's non-pass status", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "probe-integrity-"));
  const q = '[{"ask":"test-probe-stale-artifact"}]';
  const doc = "synthetic probe crash fixture";
  const hash = (x) => createHash("sha256").update(x).digest("hex");
  const suffix = hash(JSON.stringify([hash(q), hash(doc), null, [null]])).slice(
    0,
    12,
  );
  const qs = join(dir, "crash-fixture.json"),
    file = join(dir, "document.txt");
  writeFileSync(qs, q);
  writeFileSync(file, doc);
  const artifact = new URL(
    `results/case-probe-custom-crash-fixture-${suffix}.json`,
    import.meta.url,
  );
  try {
    writeFileSync(
      artifact,
      JSON.stringify({ status: "passed", runId: "stale" }),
    );
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        VM_BASE: "http://127.0.0.1:1",
        VM_PROBE_QS: qs,
        VM_PROBE_FILE: file,
      },
    });
    assert.notEqual(r.status, 0);
    const a = JSON.parse(readFileSync(artifact, "utf8"));
    assert.notEqual(a.runId, "stale");
    assert.equal(a.status, "failed");
    assert.equal(a.exitCode, 1);
    assert.ok(a.finishedAt);
    assert.ok(a.errorClass);
    assert.ok(a.implementation.sourceHash);
    assert.equal(a.implementation.verified, false);
    assert.equal(a.canonical, false);
    assert.equal(a.questionHash, hash(q));
    assert.equal(a.documentHash, hash(doc));
  } finally {
    rmSync(artifact, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("modified canonical paths and per-question patient context cannot claim canonical", async () => {
  const {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    readdirSync,
    copyFileSync,
    rmSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "probe-canonical-"));
  try {
    for (const p of ["scripts", "evaluation/case-file"])
      mkdirSync(join(dir, p), { recursive: true });
    copyFileSync(SCRIPT, join(dir, "scripts/probe-case.mjs"));
    const pdf = new URL(
      "case-file/harborline-adversarial.pdf",
      import.meta.url,
    );
    copyFileSync(
      pdf,
      join(dir, "evaluation/case-file/harborline-adversarial.pdf"),
    );
    for (const q of [
      [{ ask: "changed", patient: "HLG-P1047" }],
      [{ ask: "changed" }],
    ]) {
      writeFileSync(
        join(dir, "evaluation/case-file/questions.json"),
        JSON.stringify(q),
      );
      const r = spawnSync(
        process.execPath,
        [join(dir, "scripts/probe-case.mjs")],
        {
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            VM_BASE: "http://127.0.0.1:1",
            VM_PROBE_QS: "",
            VM_PROBE_FILE: "",
            VM_PROBE_PATIENT: "",
          },
        },
      );
      assert.notEqual(r.status, 0);
      const files = readdirSync(join(dir, "evaluation/results"));
      assert.ok(
        files.every((f) => /^case-probe-main-[a-f0-9]{12}\.json$/.test(f)),
      );
      for (const f of files)
        assert.equal(
          JSON.parse(readFileSync(join(dir, "evaluation/results", f), "utf8"))
            .canonical,
          false,
        );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
