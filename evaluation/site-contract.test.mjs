// The landing page's contract with people and agents:
//   - every documented public endpoint (site/openapi.json) is really routed;
//   - llms.txt points at endpoints that exist;
//   - every local asset the page references exists, and nothing loads from a
//     third-party host (the CSP is 'self' only);
//   - first load stays inside its weight budget, and the motion bundle is
//     rebuilt from the committed sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { createLocalServer } from "../src/server.mjs";

const site = (p) => new URL(`../site/${p}`, import.meta.url);
const html = readFileSync(site("index.html"), "utf8");
const spec = JSON.parse(readFileSync(site("openapi.json"), "utf8"));
const llms = readFileSync(site("llms.txt"), "utf8");

test("every documented endpoint is routed by the public API", async () => {
  const before = process.env.VM_BYO_VOICE;
  process.env.VM_BYO_VOICE = "on";
  const srv = createLocalServer({ port: 0 });
  if (before === undefined) delete process.env.VM_BYO_VOICE;
  else process.env.VM_BYO_VOICE = before;
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

test("GET /answer is the cacheable twin of POST /ask, for demo cases only", async () => {
  const srv = createLocalServer({ port: 0 });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  await srv.loadPublicCases();
  const base = `http://127.0.0.1:${srv.address().port}/api/public`;
  try {
    for (const [c, q] of [
      ["health", "What is SYN-0001's ferritin result?"],
      ["deal", "Was the $42,000 revision finalized?"],
    ]) {
      const g = await fetch(
        `${base}/answer?${new URLSearchParams({ case: c, q })}`,
      );
      assert.equal(g.status, 200);
      assert.match(g.headers.get("cdn-cache-control"), /s-maxage=\d+/);
      assert.match(
        g.headers.get("cdn-cache-control"),
        /stale-while-revalidate/,
      );
      const p = await fetch(base + "/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: c, question: q }),
      });
      assert.equal(p.headers.get("cache-control"), "no-store");
      assert.deepEqual(await g.json(), await p.json());
    }
    const ws = await (
      await fetch(base + "/workspace", { method: "POST" })
    ).json();
    const priv = await fetch(`${base}/answer?case=${ws.id}&q=anything`);
    assert.equal(priv.status, 400, "a private workspace is never edge-cached");
    assert.equal(priv.headers.get("cache-control"), "no-store");
    const bad = await fetch(`${base}/answer?case=health`);
    assert.equal(bad.status, 400);
    assert.equal(
      bad.headers.get("cache-control"),
      "no-store",
      "errors are never cached",
    );
    const cases = await fetch(base + "/cases");
    assert.match(cases.headers.get("cdn-cache-control") ?? "", /s-maxage/);
  } finally {
    srv.close();
  }
});

test("demo document ids are identical across boots, so cached answers stay valid", async () => {
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const srv = createLocalServer({ port: 0 });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    await srv.loadPublicCases();
    const base = `http://127.0.0.1:${srv.address().port}/api/public`;
    const { cases } = await (await fetch(base + "/cases")).json();
    ids.push(
      cases
        .flatMap((c) => c.documents.map((d) => `${c.id}/${d.title}=${d.id}`))
        .sort(),
    );
    const a = await (
      await fetch(
        `${base}/answer?case=health&q=${encodeURIComponent("What is SYN-0001's ferritin result?")}`,
      )
    ).json();
    const id = a.lead.citations[0].documentId;
    assert.equal((await fetch(`${base}/doc/health/${id}`)).status, 200);
    srv.close();
  }
  assert.ok(ids[0].length >= 11);
  assert.deepEqual(ids[0], ids[1]);
});

test("first load stays inside its weight budget (3D graph, call library and film are deferred)", () => {
  const eager = [
    "index.html",
    ...[
      ...html.matchAll(
        /<(?:script|link)[^>]+(?:src|href)="([^"]+\.(?:js|mjs|css|woff2))"/g,
      ),
    ].map((m) => m[1]),
  ];
  const bytes = [...new Set(eager)].reduce(
    (n, f) => n + statSync(site(f)).size,
    0,
  );
  assert.doesNotMatch(
    html,
    /bolna-web-call/,
    "the call library loads on intent",
  );
  assert.doesNotMatch(
    html,
    /graph3d\.bundle/,
    "the 3D graph loads near its band",
  );
  assert.doesNotMatch(
    html,
    /snapshot-graphs/,
    "the saved memory graphs load with the graph band",
  );
  assert.doesNotMatch(
    html,
    /tune\.bundle/,
    "the tuning panel loads only with ?tune",
  );
  assert.match(html, /<video[^>]*preload="none"/);
  assert.doesNotMatch(
    html,
    /snapshot-visuals/,
    "narrated overviews load with the lazy visual chunk",
  );
  assert.doesNotMatch(
    html,
    /snapshot-answers/,
    "saved cold-boot answers load only when the live engine cannot",
  );
  // index.html + CSS + preloaded fonts + site.js + snapshot + motion bundle.
  // 560 KB -> 572 KB (2026-11-02): the hero tells three stories and the
  // answer panel carries the neural-voice controls.
  // 572 KB -> 530 KB (2026-11-02): the saved memory graphs (~69 KB) moved
  // out of snapshot.js into snapshot-graphs.js, loaded with the graph band;
  // the hero (white evidence card, gauges, funnel) and page actions fit in
  // what that freed.
  // 2026-11-03: the saved cold-boot answers and document texts (~47 KB)
  // moved out of snapshot.js into snapshot-answers.js, loaded only when the
  // live engine could not answer; snapshot.js keeps the case metadata the
  // first paint needs. Same cold-boot behavior, ~47 KB off the first load.
  // 530 KB -> 531 KB (2026-11-10): the whole-question coverage strip
  // (server-recorded coverage on every answer card) plus rejection-aware
  // upload states that stop cold-start retries on quota/request rejections.
  // Measured combined head: 530,136 bytes.
  assert.ok(bytes < 531_000, `first load is ${bytes} bytes`);
});

test("the motion bundle is built from the committed sources", async () => {
  const { build } = await import("esbuild");
  const r = await build({
    entryPoints: [new URL("../site/src/entry.mjs", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    minify: true,
    target: "es2022",
    legalComments: "eof",
    write: false,
  });
  const built = new TextDecoder().decode(r.outputFiles[0].contents);
  assert.equal(
    built,
    readFileSync(site("motion.bundle.mjs"), "utf8"),
    "run node scripts/build-site-motion.mjs",
  );
});

test("every clinical lead verdict has a curated landing chip label", () => {
  const js = readFileSync(site("site.js"), "utf8");
  for (const v of [
    "LATEST",
    "VALUE",
    "SINGLE",
    "COMPARED",
    "NOT_COMPARABLE",
    "NOT_IN_REPORT",
    "FLAGGED",
  ])
    assert.match(
      js,
      new RegExp(`${v}:\\s*\\["v-[a-z]+",\\s*"[^"]+"\\]`),
      `${v} chip label`,
    );
});

test("the range-assessment tile names the reading it judges", () => {
  const js = readFileSync(site("visual.js"), "utf8");
  assert.match(
    js,
    /toRange\)\} · \$\{esc\(shortDate\(t\.latest\.date, lang\)\)\}/,
    "the 'To the printed range' tile must say which reading it assesses",
  );
});

test("BYO controls load on intent and hidden key details stay hidden", () => {
  assert.doesNotMatch(html, /id="byo-bolna-key"/);
  const panel = readFileSync(site("byo-panel.html"), "utf8");
  const css = readFileSync(site("byo.css"), "utf8");
  const js = readFileSync(site("site.js"), "utf8");
  assert.match(panel, /id="byo-bolna-key"/);
  assert.match(panel, /id="byo-llm" hidden/);
  assert.match(css, /\.byo-llm\[hidden\]\s*\{\s*display:\s*none/);
  assert.ok(
    js.indexOf('root.addEventListener("toggle", opened)') <
      js.indexOf('fetch("byo-panel.html")'),
  );
});
