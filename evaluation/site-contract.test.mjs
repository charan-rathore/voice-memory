// The landing page's contract with people and agents:
//   - every documented public endpoint (site/openapi.json) is really routed;
//   - llms.txt points at endpoints that exist;
//   - every local asset the page references exists, and nothing loads from a
//     third-party host (the CSP is 'self' only);
//   - the hero's tether code only reads answers that the snapshot holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createLocalServer } from "../server.mjs";

const site = (p) => new URL(`../site/${p}`, import.meta.url);
const html = readFileSync(site("index.html"), "utf8");
const spec = JSON.parse(readFileSync(site("openapi.json"), "utf8"));
const llms = readFileSync(site("llms.txt"), "utf8");

test("every documented endpoint is routed by the public API", async () => {
  const srv = createLocalServer({ port: 0 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  await srv.loadPublicCases();
  const base = `http://127.0.0.1:${srv.address().port}/api/public`;
  try {
    const { cases } = await (await fetch(base + "/cases")).json();
    const docId = cases.find((c) => c.id === "health").documents[0].id;
    const ws = await (
      await fetch(base + "/workspace", { method: "POST" })
    ).json();
    const fill = (p) =>
      p
        .replace("{case}", "health")
        .replace("{documentId}", docId)
        .replace("{id}", ws.id);
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const method of Object.keys(ops)) {
        const init = { method: method.toUpperCase() };
        if (path === "/ask") {
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify({
            case: "health",
            question: "What is the TSH?",
          });
        }
        if (path.endsWith("/upload")) {
          init.headers = {
            "x-file-name": "note.txt",
            "content-type": "application/octet-stream",
          };
          init.body = "Payment is due on 3 March.";
        }
        if (path === "/workspace") continue; // created above
        const r = await fetch(base + fill(path), init);
        const body = await r.text();
        assert.notEqual(
          r.status,
          404,
          `${method} ${path} -> 404 ${body.slice(0, 80)}`,
        );
        assert.ok(r.status < 500, `${method} ${path} -> ${r.status}`);
      }
    }
  } finally {
    srv.close();
  }
});

test("llms.txt only names endpoints that the OpenAPI document describes", () => {
  const named = [...llms.matchAll(/\/api\/public(\/[\w/{}-]+)/g)].map((m) =>
    m[1].replace(/\{id\}/g, "{id}"),
  );
  assert.ok(named.length >= 3);
  for (const p of named)
    assert.ok(
      spec.paths[p],
      `llms.txt names ${p}, which openapi.json does not describe`,
    );
});

test("every local asset the landing page references exists", () => {
  const refs = [...html.matchAll(/(?:src|href|poster)="([^"#]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:|mailto:|data:)/.test(u));
  assert.ok(refs.length > 10);
  for (const r of refs) {
    const file = r.replace(/^\.\//, "");
    assert.ok(
      existsSync(site(file)) || existsSync(site(file + ".html")),
      `missing ${r}`,
    );
  }
  for (const m of html.matchAll(/<script[^>]*src="(https?:[^"]+)"/g))
    assert.fail(`third-party script ${m[1]}`);
  for (const m of html.matchAll(/<link[^>]*href="(https?:[^"]+)"/g))
    assert.fail(`third-party link ${m[1]}`);
  // the only inline script is JSON-LD data, which the CSP never executes
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map(
    (m) => m[1],
  );
  for (const a of inline) assert.match(a, /type="application\/ld\+json"/);
  JSON.parse(
    html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
  );
});

test("the hero's questions are all in the saved snapshot", () => {
  const hero = readFileSync(site("hero.mjs"), "utf8");
  const snap = readFileSync(site("snapshot.js"), "utf8");
  const keys = [...hero.matchAll(/key: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(keys.length, 3);
  for (const k of keys)
    assert.ok(snap.includes(JSON.stringify(k)), `snapshot lacks ${k}`);
});
