#!/usr/bin/env node
// Smoke-test caller memory on a deployed service, across a restart.
//
//   node scripts/caller-memory-smoke.mjs <base-url> create   # before restart
//   (restart or redeploy the service in the Render Dashboard)
//   node scripts/caller-memory-smoke.mjs <base-url> verify   # after restart
//   node scripts/caller-memory-smoke.mjs <base-url> forget   # clean up
//   node scripts/caller-memory-smoke.mjs <base-url> verify-gone
//
// Uses only the fictional demo personas (VM_CALLER_DEMO=on). Prints no
// tokens, cookies or assertions. Exits non-zero on any failed check.
const [, , baseArg, step = "create"] = process.argv;
if (!baseArg) {
  console.error(
    "usage: caller-memory-smoke.mjs <base-url> create|verify|forget|verify-gone",
  );
  process.exit(2);
}
import { readFileSync, writeFileSync } from "node:fs";
const base = baseArg.replace(/\/$/, "");
const origin = process.env.SMOKE_ORIGIN || base;
let ok = true;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) ok = false;
};

// The demo is isolated per browser (a server-issued visitor cookie), so the
// same "browser" must come back across runs: its cookies are kept in a
// local file (SMOKE_JAR, default .caller-memory-smoke-jar.json). It holds
// only demo cookies for fictional callers; delete it after the smoke test.
const jarPath = process.env.SMOKE_JAR || ".caller-memory-smoke-jar.json";
const loadJar = (name) => {
  try {
    return new Map(JSON.parse(readFileSync(jarPath, "utf8"))[name] ?? []);
  } catch {
    return new Map();
  }
};
const saveJar = (name, jar) => {
  let all = {};
  try {
    all = JSON.parse(readFileSync(jarPath, "utf8"));
  } catch {}
  all[name] = [...jar].filter(([k]) => k === "vm_demo");
  writeFileSync(jarPath, JSON.stringify(all), { mode: 0o600 });
};
function client(name) {
  const jar = loadJar(name);
  return async (method, p, body) => {
    const t0 = performance.now();
    const res = await fetch(base + "/api/public/caller" + p, {
      method,
      headers: {
        "content-type": "application/json",
        origin,
        ...(jar.size
          ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const kv = c.split(";")[0];
      const i = kv.indexOf("=");
      if (!kv.slice(i + 1) || /Max-Age=0/i.test(c)) jar.delete(kv.slice(0, i));
      else jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    saveJar(name, jar);
    const json = await res.json().catch(() => ({}));
    return {
      status: res.status,
      body: json,
      ms: Math.round(performance.now() - t0),
    };
  };
}
async function start(req, persona) {
  const a = await req("POST", "/demo-assertion", { persona });
  if (a.status !== 200) return a;
  return req("POST", "/start", { assertion: a.body.assertion, case: "deal" });
}

const health = await fetch(base + "/healthz").then((r) => r.json());
console.log(`commit ${health.commit ?? "unknown"}`);
check(health.callerMemory?.enabled === true, "caller memory enabled");
check(
  health.callerMemory?.storage === "durable",
  `storage durable (got ${health.callerMemory?.storage})`,
);

const asha = client("asha-browser");
const s = await start(asha, "asha");
check(s.status === 200, `Asha verified call starts (${s.ms} ms)`);
if (step === "create") {
  const r = await asha("POST", "/turn", {
    utterance:
      "Please remember that I prefer Hinglish, and remember this conversation for next time.",
  });
  check(
    r.body?.memory?.preferences?.language?.value === "hinglish",
    `preference stored (${r.ms} ms)`,
  );
  const q = await asha("POST", "/turn", {
    utterance: "Was the revised fee approved?",
  });
  check(
    q.body?.sections?.verified?.verdict === "PROPOSED",
    `fee answered from documents: ${q.body?.sections?.verified?.verdict} (${q.ms} ms)`,
  );
} else if (step === "verify") {
  check(
    s.body?.preferences?.language?.value === "hinglish",
    "preference recovered after restart",
  );
  check(
    s.body?.rechecked?.[0]?.label === "the fee",
    "previous subject recalled",
  );
  check(
    typeof s.body?.rechecked?.[0]?.sourceChanged === "boolean",
    "documents rechecked against current version",
  );
} else if (step === "forget") {
  const f = await asha("POST", "/forget", { all: true });
  check(f.status === 200, "forget everything");
} else if (step === "verify-gone") {
  check(
    Object.keys(s.body?.preferences ?? {}).length === 0,
    "deleted memory stays deleted",
  );
  check((s.body?.rechecked ?? []).length === 0, "no recalled subject");
}
const ravi = client("ravi-browser");
const r = await start(ravi, "ravi");
check(
  r.status === 200 && Object.keys(r.body?.preferences ?? {}).length === 0,
  "Ravi sees none of Asha's memory",
);
const forged = await asha("POST", "/start", {
  assertion: "vmca1.demo.e30.AAAA",
  case: "deal",
});
check(forged.status === 401, "forged assertion refused");
await asha("POST", "/end", {});
await ravi("POST", "/end", {});
process.exit(ok ? 0 : 1);
