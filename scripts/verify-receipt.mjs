#!/usr/bin/env node
// Standalone Voice Memory receipt verifier. Needs only Node's built-ins.
//
//   node scripts/verify-receipt.mjs <receipt.json> <public-key.pem | https://host/v1/receipts/keys>
//        [--question "<exact question>"] [--answer "<exact admitted answer (say)>"]
//        [--quote "<exact cited text>" ...]
//
// Checks the Ed25519 signature over the canonical receipt, then (optionally)
// that the question, answer and cited spans you hold are the ones signed.
// Exit 0 only if every requested check passes.
//
// What a valid receipt proves: Voice Memory's server signed this outcome
// for this tenant, call, request, source scope and version, applied
// documents, question, answer and cited spans, at this time. It does NOT
// prove that a caller heard the answer or that any decision was made.
import { readFileSync } from "node:fs";
import { canonical, digest, verifyReceipt } from "../memory/receipt-signer.mjs";

const args = process.argv.slice(2);
const [receiptPath, keySource] = args;
if (!receiptPath || !keySource) {
  console.error(
    "usage: verify-receipt.mjs <receipt.json> <key.pem|keys-url> [--question q] [--answer a] [--quote t ...]",
  );
  process.exit(2);
}
const opt = (name) => {
  const out = [];
  for (let i = 2; i < args.length; i++)
    if (args[i] === name) out.push(args[++i]);
  return out;
};
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
let pem;
if (/^https?:\/\//.test(keySource)) {
  const { keys } = await fetch(keySource).then((r) => r.json());
  const k = keys.find((x) => x.kid === receipt.kid);
  if (!k) {
    console.log(`FAIL  no published key ${receipt.kid}`);
    process.exit(1);
  }
  if (k.ephemeral)
    console.log("WARN  the server's key is ephemeral (lost on restart)");
  pem = k.publicKeyPem;
} else pem = readFileSync(keySource, "utf8");

let ok = true;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  ok &&= cond;
};
const v = verifyReceipt(receipt, pem);
check(
  v.ok,
  `signature (${receipt.kid}, ${receipt.schema})${v.ok ? "" : ": " + v.reason}`,
);
for (const q of opt("--question"))
  check(
    digest(q) === receipt.questionDigest,
    "question matches the signed digest",
  );
for (const a of opt("--answer"))
  check(digest(a) === receipt.answerDigest, "answer matches the signed digest");
for (const t of opt("--quote"))
  check(
    (receipt.citations ?? []).some((c) => c.quoteDigest === digest(t)),
    `cited text is one of the signed spans: "${t.slice(0, 40)}${t.length > 40 ? "…" : ""}"`,
  );
console.log(
  `      ${receipt.op} · tenant ${receipt.tenant} · call ${receipt.callId} · ${receipt.at}`,
);
if (receipt.scope) console.log(`      scope ${canonical(receipt.scope)}`);
if (receipt.outcome) console.log(`      outcome ${canonical(receipt.outcome)}`);
process.exit(ok ? 0 : 1);
