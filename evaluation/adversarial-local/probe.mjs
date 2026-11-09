// Adversarial reproduction probe: upload unseen fixtures through the public
// API and print FULL responses (including citations) for identity, citation
// and injection claims. Local only, synthetic data, no production contact.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:4521";
const root = new URL("../../", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  const r = await fetch(BASE + "/api/public" + path, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(Error(body.error || r.status), { body });
  return body;
}

async function uploadAndAskAbs(file, questions) {
  const { id: ws } = await api("/workspace", { method: "POST" });
  await api(`/workspace/${ws}/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(file.split("/").pop()),
    },
    body: readFileSync(new URL("../../" + file, import.meta.url)),
  });
  return finish(ws, file, questions);
}

async function uploadAndAsk(file, questions) {
  const { id: ws } = await api("/workspace", { method: "POST" });
  await api(`/workspace/${ws}/upload`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(file),
    },
    body: readFileSync(new URL("files/" + file, import.meta.url)),
  });
  return finish(ws, file, questions);
}

async function finish(ws, file, questions) {
  for (let i = 0; i < 900; i++) {
    const st = await api(`/workspace/${ws}`);
    if (st.documents.every((d) => ["ready", "needs_review", "failed"].includes(d.status)))
      break;
    await sleep(100);
  }
  const st = await api(`/workspace/${ws}`);
  console.log(`\n######## ${file} -> status ${st.documents.map((d) => d.status).join(",")}`);
  for (const q of questions) {
    const a = await api("/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ case: ws, question: q }),
    });
    console.log(`\nQ: ${q}`);
    console.log("FINAL:", a.final?.text);
    console.log("VERDICT:", a.final?.verdict, "| kind:", a.final?.kind);
    console.log("FINAL.CITATIONS:", JSON.stringify(a.final?.citations));
    console.log("LEAD.CITATIONS:", JSON.stringify(a.lead?.citations));
    (a.evidence ?? []).forEach((e, i) =>
      console.log(
        `EVIDENCE[${i}] page=${e.page ?? e.pages ?? "?"} start=${e.start} end=${e.end} src=${e.sourceId ?? "?"} quote[0:160]=${JSON.stringify((e.quote ?? "").slice(0, 160))}`,
      ),
    );
  }
}

const server = spawn(process.execPath, ["scripts/site-dev.mjs"], {
  cwd: root,
  env: { ...process.env, SITE_PORT: "4521", VM_PUBLIC_ASK_PER_MIN: "100000" },
  stdio: "ignore",
});
for (let i = 0; i < 300; i++) {
  if (await fetch(BASE + "/api/public/cases").then((r) => r.ok).catch(() => false)) break;
  await sleep(100);
}
try {
  const which = process.argv[2] || "all";
  if (which === "all" || which === "citation")
    await uploadAndAskAbs("evaluation/case-file/harborline-adversarial.pdf", [
      "What is Maya's HbA1c?",
    ]);
  if (which === "all" || which === "dob")
    await uploadAndAsk("dob-conflict.pdf", [
      "What is Asha's hemoglobin?",
      "Has her hemoglobin changed since September?",
      "What is her date of birth?",
    ]);
  if (which === "all" || which === "namesake")
    await uploadAndAsk("namesake3.pdf", ["What is Asha's ferritin?"]);
  if (which === "majority")
    await uploadAndAsk("namesake-majority.pdf", ["What is Asha's ferritin?"]);
  if (which === "narrative")
    await uploadAndAsk("narrative-summary.pdf", [
      "Summarise this report",
      "What are the recommendations?",
    ]);
  if (which === "all" || which === "injection")
    await uploadAndAsk("injection-summary.pdf", [
      "Summarise this report",
      "What is her ferritin?",
    ]);
} finally {
  server.kill();
}
