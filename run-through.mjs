// LOCAL timed run-through of the spoken contract (voice-adapter), Northstar
// corpus. This is a SIMULATION of the spoken path over the local HTTP voice
// endpoint - no live call, no audio, no Bolna session.
import { NORTHSTAR_DOCS } from "./corpus-northstar.mjs";
const origin = "http://127.0.0.1:4317";
const j = (r) => r.json();
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";

const sessRes = await fetch(origin + "/api/session");
const csrf = (await sessRes.json()).csrf;
const cookie = sessRes.headers.get("set-cookie").split(";")[0];
const H = {
  "content-type": "application/json",
  origin,
  "x-csrf-token": csrf,
  cookie,
};
await fetch(origin + "/api/import", {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    documents: NORTHSTAR_DOCS.map((d) => ({ title: d.title, text: d.text })),
  }),
}).then(async (r) =>
  console.log("import status:", r.status, JSON.stringify(await r.json())),
);
console.log(`[${stamp()}] corpus imported (7 fictional docs)`);

const startRes = await fetch(origin + "/api/voice/start", {
  method: "POST",
  headers: H,
  body: "{}",
});
const start = await startRes.json();
console.log("voice/start status:", startRes.status, JSON.stringify(start));
console.log(`[${stamp()}] voice session started (local contract)`);

const beats = [
  "What is the engagement fee and how is it invoiced?",
  "What payment terms did we finally agree to?",
  "When is signoff expected?",
  "Who gives the signoff?",
  "Turn that into an email",
];
let history = [];
for (const [i, b] of beats.entries()) {
  const bt = Date.now();
  history = [...history, { role: "user", content: b }];
  const r = await fetch(origin + "/api/voice/turn", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ stream: true, messages: history }),
  });
  const body = await r.text();
  let spoken = "";
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
    try {
      spoken += JSON.parse(line.slice(5)).choices?.[0]?.delta?.content ?? "";
    } catch {}
  }
  spoken = spoken.trim() || body.slice(0, 400);
  console.log(
    `\n=== BEAT ${i + 1} [${stamp()}, this beat ${((Date.now() - bt) / 1000).toFixed(1)}s]`,
  );
  console.log("USER:", b);
  console.log("AGENT (spoken text):", spoken.slice(0, 600));
  history = [...history, { role: "assistant", content: spoken }];
}
console.log(`\n[${stamp()}] run-through complete`);
