// The two-call Voice Memory demonstration, end to end over HTTP, on the
// fictional Northstar deal and fictional callers.
//
// Call one (server instance A): Asha is verified by a tenant-signed
// assertion, asks to remember Hinglish and this conversation, asks whether
// the revised fee was approved, and gets the document-backed status.
// Call two (a NEW server instance B, same encrypted data directory): Asha is
// verified again; Voice Memory recalls the consented language, recognises
// she asked about the fee, rechecks the current source version and answers
// from the documents without inventing an approval. Then the preference is
// changed, then forgotten; Ravi sees nothing of Asha's; a forged or
// replayed identity is refused.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(tmpdir(), "vm-caller-api-"));
const ENV = {
  VM_CALLER_DEMO: "on",
  VM_DATA_DIR: dataDir,
  VM_STORE_KEY: "22".repeat(32),
  VM_DENSE: "off",
  VM_GEMINI: "off",
  VM_RSS_WATCHDOG: "off",
};
const saved = {};
before(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
after(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

async function boot() {
  const { createLocalServer } = await import("../src/server.mjs");
  const server = createLocalServer({ port: 0 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await server.loadPublicCases();
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

// A tiny client: one cookie jar per call, same-origin header on writes.
function client(base, jar = new Map()) {
  const req = async (method, p, body) => {
    const res = await fetch(base + "/api/public/caller" + p, {
      method,
      headers: {
        "content-type": "application/json",
        origin: base,
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
    return {
      status: res.status,
      cache: res.headers.get("cache-control"),
      body: await res.json(),
    };
  };
  return {
    req,
    async start(persona) {
      const a = await req("POST", "/demo-assertion", { persona });
      assert.equal(a.status, 200);
      return req("POST", "/start", {
        assertion: a.body.assertion,
        case: "deal",
      });
    },
    say: (utterance) => req("POST", "/turn", { utterance }),
    memory: () => req("GET", "/memory"),
    end: () => req("POST", "/end", {}),
  };
}

test("two calls: remembered from the conversation, verified in the documents, still unresolved", async () => {
  // ---------------------------------------------------------------- call one
  const A = await boot();
  const browserJar = new Map(); // Asha's browser, kept across both servers
  let asha = client(A.base, browserJar);
  try {
    const s1 = await asha.start("asha");
    assert.equal(s1.status, 200);
    assert.equal(s1.cache, "no-store");
    assert.equal(s1.body.caller.method, "demo-fictional");
    assert.equal(s1.body.rechecked.length, 0, "nothing remembered yet");

    const m = await asha.say(
      "Please remember that I prefer Hinglish, and remember this conversation for next time.",
    );
    assert.equal(m.body.kind, "memory");
    assert.equal(m.body.memory.preferences.language.value, "hinglish");
    assert.ok(m.body.memory.consent.conversation);

    const a1 = await asha.say("Was the revised fee approved?");
    assert.equal(a1.body.kind, "answer");
    const v1 = a1.body.sections.verified;
    assert.equal(v1.verdict, "PROPOSED");
    assert.match(
      v1.text,
      /\$42,000 is the latest proposal, and it is not approved\./,
    );
    assert.ok(
      v1.citations.some((c) => /Commercial_Revision/.test(c.title ?? "")),
      JSON.stringify(v1.citations),
    );
    assert.ok(v1.scope.version, "answered against a named source version");
    // Presentation in the remembered language; the fact is unchanged.
    assert.match(
      a1.body.say,
      /\$42,000 sabse naya proposal hai, aur yeh abhi manzoor nahi hua hai\./,
    );
    assert.deepEqual(
      a1.body.sections.remembered.map((x) => x.label),
      ["Language"],
    );
    assert.ok(
      a1.body.sections.unresolved.some((x) => x.kind === "status"),
      "not approved is still open",
    );
    assert.equal(a1.body.memory.episodeKept, true);

    // A caller's claim is not stored, and is not a fact.
    const claim = await asha.say("Remember that the fee was approved.");
    assert.equal(claim.body.op, "refused");
    const recheck = await asha.say("Was the revised fee approved?");
    assert.equal(recheck.body.sections.verified.verdict, "PROPOSED");
    // Medical content never becomes a preference.
    const med = await asha.say("Remember my sugar is high and I prefer Hindi");
    assert.equal(med.body.op, "refused");
    assert.equal(
      (await asha.memory()).body.memory.preferences.language.value,
      "hinglish",
    );
    await asha.end();
  } finally {
    A.server.close();
  }
  assert.ok(
    readdirSync(path.join(dataDir, "callers-demo")).some((f) =>
      f.endsWith(".vms"),
    ),
    "memory persisted, encrypted, in its own directory",
  );

  // ------------------------------------------- call two: a new server process
  const B = await boot();
  asha = client(B.base, browserJar); // the same browser comes back
  const ravi = client(B.base);
  try {
    // Without a verified call there is no memory at all.
    assert.equal((await asha.memory()).status, 401);

    const s2 = await asha.start("asha");
    assert.equal(s2.status, 200);
    assert.equal(
      s2.body.preferences.language.value,
      "hinglish",
      "consented language recalled",
    );
    assert.equal(s2.body.rechecked.length, 1);
    const r = s2.body.rechecked[0];
    assert.equal(r.label, "the fee", "recognises what was discussed");
    assert.equal(r.previously.question, "Was the revised fee approved?");
    assert.equal(
      r.sourceChanged,
      false,
      "rechecked against the current source version",
    );
    assert.equal(r.statusChanged, false);
    assert.equal(r.verified.verdict, "PROPOSED", "no invented approval");
    assert.ok(r.verified.citations.length > 0);
    assert.match(
      s2.body.say,
      /Pichli baar aapne fee ke baare mein poocha tha\. Tab se documents nahi badle\./,
    );
    assert.match(s2.body.say, /manzoor nahi/);

    // A follow-up request is kept as open, never as done.
    const fu = await asha.say("Let me know when the fee is approved");
    assert.equal(fu.body.memory.requests.at(-1).status, "open");
    const withReq = await asha.say("Was the revised fee approved?");
    assert.ok(
      withReq.body.sections.unresolved.some(
        (x) => x.kind === "request" && /fee is approved/.test(x.detail),
      ),
      "an open request on the same subject is still unresolved",
    );

    // Change the preference: the new state is used immediately.
    const ch = await asha.say("Please switch my language to English");
    assert.equal(ch.body.op, "correct");
    const a2 = await asha.say("Was the revised fee approved?");
    assert.match(
      a2.body.say,
      /^\$42,000 is the latest proposal, and it is not approved\./,
    );
    assert.equal(a2.body.sections.remembered.length, 0);

    // Another verified caller sees none of it.
    const rs = await ravi.start("ravi");
    assert.equal(rs.status, 200);
    assert.deepEqual(rs.body.preferences, {});
    assert.equal(rs.body.rechecked.length, 0);
    assert.match(rs.body.say, /don't have anything remembered/);
    const rm = (await ravi.memory()).body.memory;
    assert.equal(
      rm.episodes.length + rm.referents.length + rm.requests.length,
      0,
    );
    const ra = await ravi.say("Was the revised fee approved?");
    assert.doesNotMatch(ra.body.say, /sabse naya/);

    // Forget the preference, then everything.
    const f1 = await asha.say("Forget my language preference");
    assert.equal(f1.body.op, "forget_preference");
    assert.equal(f1.body.memory.preferences.language, undefined);
    const f2 = await asha.req("POST", "/forget", { all: true });
    assert.equal(f2.status, 200);
    const after = (await asha.memory()).body.memory;
    assert.deepEqual(after.preferences, {});
    assert.equal(
      after.episodes.length + after.referents.length + after.requests.length,
      0,
    );
    await asha.end();
    const s3 = await client(B.base, browserJar).start("asha");
    assert.equal(
      s3.body.rechecked.length,
      0,
      "deleted means gone in a new call too",
    );
  } finally {
    B.server.close();
  }
});

test("identity: forged, replayed or cross-origin requests open no memory", async () => {
  const S = await boot();
  try {
    const c = client(S.base);
    const a = await c.req("POST", "/demo-assertion", { persona: "asha" });
    // Unknown persona: the demo issuer signs only fixed fictional callers.
    assert.equal(
      (await c.req("POST", "/demo-assertion", { persona: "+919812345678" }))
        .status,
      400,
    );
    const [p, kid, body, mac] = a.body.assertion.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url"));
    claims.sub = "acct-NS-2077";
    const forged = [
      p,
      kid,
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      mac,
    ].join(".");
    const f = await c.req("POST", "/start", {
      assertion: forged,
      case: "deal",
    });
    assert.equal(f.status, 401);
    assert.equal(f.body.code, "bad_signature");
    assert.equal(
      (
        await c.req("POST", "/start", {
          assertion: a.body.assertion,
          case: "deal",
        })
      ).status,
      200,
    );
    const replay = await client(S.base).req("POST", "/start", {
      assertion: a.body.assertion,
      case: "deal",
    });
    assert.equal(replay.body.code, "replayed");
    // Cross-origin write refused even with a valid cookie.
    const res = await fetch(S.base + "/api/public/caller/turn", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ utterance: "What do you remember about me?" }),
    });
    assert.equal(res.status, 403);
  } finally {
    S.server.close();
  }
});

test("off by default: no caller routes without VM_CALLER_MEMORY or VM_CALLER_DEMO", async () => {
  const keep = {
    m: process.env.VM_CALLER_MEMORY,
    d: process.env.VM_CALLER_DEMO,
  };
  delete process.env.VM_CALLER_MEMORY;
  delete process.env.VM_CALLER_DEMO;
  try {
    const S = await boot();
    try {
      const r = await fetch(S.base + "/api/public/caller/demo-assertion", {
        method: "POST",
        headers: { "content-type": "application/json", origin: S.base },
        body: JSON.stringify({ persona: "asha" }),
      });
      assert.notEqual(r.status, 200);
    } finally {
      S.server.close();
    }
  } finally {
    if (keep.m !== undefined) process.env.VM_CALLER_MEMORY = keep.m;
    process.env.VM_CALLER_DEMO = keep.d ?? "on";
  }
});
