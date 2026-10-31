// Ingestion benchmark: runs every fixture through the real pipeline and scores
// it against hand-written gold labels. Saves raw per-case results with the
// git SHA, parser versions and timings.
//
//   node ingest/bench.mjs            # prints a table, writes ingest/results/
//   node ingest/bench.mjs --json     # prints raw JSON only
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { ingestFile } from "./index.mjs";

const FIX = new URL("./fixtures/files/", import.meta.url);
const gold = JSON.parse(
  readFileSync(new URL("./fixtures/gold.json", import.meta.url), "utf8"),
);

const eqCells = (a, b) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export function score(name, g, r) {
  const checks = [];
  const add = (check, pass, detail = "") =>
    checks.push({ check, pass, detail });
  if (g.status === "failed") {
    add("fails", !r.ok, r.ok ? `got ${r.status}` : "");
    add("code", !r.ok && r.code === g.code, r.ok ? "" : `got ${r.code}`);
    add(
      "actionable message",
      !r.ok && typeof r.message === "string" && r.message.length > 20,
    );
    return checks;
  }
  if (g.safety) {
    // Safety case: exact reading is NOT required, but a misread must never be
    // presented as ready. Rejecting the file as unreadable is also safe.
    if (!r.ok) {
      add(
        "no silent misread (rejected as unreadable)",
        r.code === "unreadable_scan",
        r.code,
      );
      return checks;
    }
    const misses = (g.contains ?? []).filter((s) => !r.doc.text.includes(s));
    add(
      "no silent misread (misread => needs_review)",
      misses.length === 0 || r.status === "needs_review",
      `${misses.length} line(s) misread, status ${r.status}`,
    );
    return checks;
  }
  add(
    "status",
    g.status === "ready_or_review" ? r.ok : r.ok && r.status === g.status,
    r.ok ? r.status : `${r.code}: ${r.message}`,
  );
  if (!r.ok) return checks;
  const { doc } = r;
  const leaf = doc.elements.filter((e) => e.indexed && !(e.type === "table"));
  for (const s of g.contains ?? [])
    add(`contains "${s.slice(0, 40)}"`, doc.text.includes(s));
  if (g.order) {
    const idx = g.order.map((s) => doc.text.indexOf(s));
    add(
      "reading order",
      idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1])),
      idx.join(","),
    );
  }
  for (const [s, p] of Object.entries(g.page ?? {})) {
    const el = leaf.find((e) => (e.text ?? "").includes(s));
    add(
      `"${s}" on page ${p}`,
      el?.page === p,
      el ? `page ${el.page}` : "not found",
    );
  }
  for (const h of g.headings ?? [])
    add(
      `heading "${h}"`,
      doc.elements.some((e) => e.type === "heading" && e.text === h),
    );
  for (const row of g.rows ?? []) {
    const hit = doc.elements.some(
      (e) =>
        (e.type === "table-row" || e.type === "table-header") &&
        eqCells(e.cells, row),
    );
    const near = doc.elements.find((e) => e.cells && e.cells[0] === row[0]);
    add(
      `row ${row[0]}`,
      hit,
      hit ? "" : near ? `got [${near.cells.join(" | ")}]` : "missing",
    );
  }
  for (const s of g.absent ?? [])
    add(`not indexed "${s.slice(0, 30)}"`, !doc.text.includes(s));
  if (g.furnitureAtLeast)
    add(
      "page furniture detected",
      doc.stats.furnitureExcluded >= g.furnitureAtLeast,
      String(doc.stats.furnitureExcluded),
    );
  if (g.textSource)
    add(
      `text source ${g.textSource}`,
      doc.pages[0]?.textSource === g.textSource,
      doc.pages[0]?.textSource,
    );
  if (g.exactText !== undefined)
    add("text is the original", doc.text === g.exactText);
  // Every indexed element's span must be the exact slice of canonical text.
  add(
    "element spans exact",
    doc.elements
      .filter((e) => e.indexed && e.text !== undefined && e.type !== "table")
      .every(
        (e) =>
          doc.text.slice(e.start, e.end).endsWith(e.text) ||
          doc.text.slice(e.start, e.end) === e.text,
      ),
  );
  return checks;
}

export async function runBench() {
  const files = readdirSync(FIX)
    .filter((f) => gold.cases[f])
    .sort();
  const results = [];
  for (const f of files) {
    const bytes = readFileSync(new URL(f, FIX));
    const t0 = performance.now();
    const r = await ingestFile(bytes, f);
    const ms = Math.round(performance.now() - t0);
    const checks = score(f, gold.cases[f], r);
    results.push({
      file: f,
      ms,
      ok: r.ok,
      status: r.ok ? r.status : "failed",
      code: r.ok ? null : r.code,
      parser: r.ok ? r.doc.parser : null,
      stats: r.ok ? r.doc.stats : null,
      warnings: r.ok ? r.doc.warnings.map((w) => w.code) : [],
      checks,
    });
  }
  return results;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const results = await runBench();
  let sha = "unknown";
  let dirty = false;
  try {
    sha = execSync("git rev-parse --short HEAD").toString().trim();
    dirty = execSync("git status --porcelain").toString().trim().length > 0;
  } catch {}
  const all = results.flatMap((r) => r.checks);
  const summary = {
    sha,
    dirtyWorkingTree: dirty,
    goldVersion: gold.version,
    date: new Date().toISOString(),
    node: process.version,
    files: results.length,
    checks: all.length,
    passed: all.filter((c) => c.pass).length,
  };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    for (const r of results) {
      const failed = r.checks.filter((c) => !c.pass);
      console.log(
        `${failed.length ? "FAIL" : "pass"}  ${r.file.padEnd(22)} ${String(r.ms).padStart(6)} ms  ${r.status.padEnd(12)} ${r.checks.length - failed.length}/${r.checks.length}` +
          failed
            .map(
              (c) =>
                `\n        x ${c.check}${c.detail ? " (" + c.detail + ")" : ""}`,
            )
            .join(""),
      );
    }
    console.log(
      `\n${summary.passed}/${summary.checks} checks passed across ${summary.files} files at ${sha}${dirty ? " (uncommitted changes)" : ""}`,
    );
    mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
    writeFileSync(
      new URL(
        `./results/ingest-${summary.date.slice(0, 10)}-${sha}.json`,
        import.meta.url,
      ),
      JSON.stringify({ summary, results }, null, 2),
    );
  }
}
