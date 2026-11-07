// Local-only end-to-end evidence capture. No model download or provider transport.
process.env.VM_DENSE = "off";
process.env.VM_RSS_WATCHDOG = "off";
process.env.VM_WS_PER_IP_HOUR = "100";
process.env.VM_WS_FILES = "10";
process.env.VM_RERANK = "off";
process.env.VM_DATA_DIR = "";
process.env.VM_PUBLIC_HOST = "";
const { readFile, readdir, writeFile } = await import("node:fs/promises");
const { createLocalServer } = await import("../../src/server.mjs");
const { createVoiceAdapter } = await import("../../src/voice-adapter.mjs");
const { importBundle } = await import("../../dist/engine.mjs");
const assert = (await import("node:assert/strict")).default;
export const questions = [
  "What deadline does the client want to keep?",
  "How often is progress reported?",
  "Has the money side been signed off by the client’s accountants?",
];
export async function corpus() {
  const dir = new URL("../../examples/corpus-md/", import.meta.url);
  return Promise.all(
    (await readdir(dir))
      .filter((n) => n.endsWith(".md"))
      .sort()
      .map(async (title) => ({
        title,
        text: await readFile(new URL(title, dir), "utf8"),
      })),
  );
}
export async function capture(docs, qs = questions) {
  const voice = createVoiceAdapter(); // default SSE, no external retrieval injection
  let providerCalls = 0;
  const forbidden = async () => {
    providerCalls++;
    throw Error("Provider forbidden");
  };
  const gemini = {
    enabled: () => false,
    searchEnabled: () => false,
    status: () => ({ enabled: false }),
    interpret: forbidden,
    planClaims: forbidden,
    groundedExplain: forbidden,
  };
  const server = createLocalServer({
    port: 0,
    voice,
    gemini,
    vendorFetch: forbidden,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token;
  try {
    const created = await fetch(base + "/api/public/workspace", {
      method: "POST",
    });
    assert.equal(created.status, 200);
    const { id } = await created.json();
    for (const doc of docs) {
      const upload = await fetch(`${base}/api/public/workspace/${id}/upload`, {
        method: "POST",
        headers: { "x-file-name": doc.title },
        body: doc.text,
      });
      assert.equal(upload.status, 202, await upload.text());
      for (let i = 0; i < 200; i++) {
        const state = await fetch(`${base}/api/public/workspace/${id}`).then(
          (r) => r.json(),
        );
        if (state.documents.every((d) => d.status === "ready")) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    let state;
    // Wait only for this process's local ingestion jobs, never external services.
    for (let i = 0; i < 200; i++) {
      state = await fetch(`${base}/api/public/workspace/${id}`).then((r) =>
        r.json(),
      );
      if (
        state.documents.length === docs.length &&
        state.documents.every((d) => d.status === "ready")
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(
      state.documents.every((d) => d.status === "ready"),
      JSON.stringify(state),
    );
    const canonical = [];
    for (const d of state.documents) {
      const response = await fetch(`${base}/api/public/doc/${id}/${d.id}`);
      assert.equal(response.status, 200);
      const { document } = await response.json();
      canonical.push({ id: d.id, title: d.title, text: document.text });
    }
    const bundle = importBundle(canonical);
    token = voice.bind(bundle);
    const output = [];
    for (const question of qs) {
      const response = await fetch(base + "/api/public/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ case: id, question }),
      });
      assert.equal(response.status, 200);
      const typed = await response.json();
      const sse = await fetch(base + "/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          stream: true,
          messages: [{ role: "user", content: question }],
        }),
      });
      assert.equal(sse.status, 200);
      const wire = await sse.text();
      const turn = voice.lastTurn(token);
      assert.ok(wire.endsWith("data: [DONE]\n\n"));
      const streamed = wire
        .split("\n")
        .filter((l) => l.startsWith("data: {"))
        .map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? "")
        .join("");
      assert.equal(streamed, turn.spokenTurn.spoken);
      for (const c of [
        ...(typed.lead?.citations ?? []),
        ...(typed.evidence ?? []),
      ]) {
        const source = canonical.find((s) => s.id === c.documentId);
        assert.ok(source, JSON.stringify(c));
        assert.equal(source.text.slice(c.start, c.end), c.quote);
      }
      for (const c of turn.spokenTurn?.citations ?? []) {
        const source = bundle.sources.find((s) => s.id === c.sourceId);
        assert.ok(source, JSON.stringify(c));
        assert.equal(source.text.slice(c.start, c.end), c.quote);
      }
      output.push({
        question,
        typed,
        wire,
        spokenTurn: turn.spokenTurn,
        result: turn.result,
      });
    }
    assert.equal(providerCalls, 0);
    return output;
  } finally {
    if (token) voice.revoke(token);
    await new Promise((r) => server.close(r));
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const output = await capture(await corpus());
  if (process.argv[2])
    await writeFile(process.argv[2], JSON.stringify(output, null, 2) + "\n");
  else console.log(JSON.stringify(output, null, 2));
}
