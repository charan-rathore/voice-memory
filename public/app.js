const $ = (id) => document.getElementById(id);
let csrf,
  latestDraft,
  draftAllowed = false;
const ready = fetch("/api/session")
  .then((r) => r.json())
  .then((s) => (csrf = s.csrf));
function status(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
async function api(path, data) {
  await ready;
  const r = await fetch("/api/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(data),
  });
  const out = await r.json();
  if (!r.ok) throw Error(out.error || "Request failed.");
  return out;
}
function busy(on) {
  document.querySelectorAll("button").forEach((b) => (b.disabled = on));
  $("files").disabled = on;
}
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function renderTransform(t) {
  $("transform").replaceChildren();
  $("transform").hidden = !t;
  if (!t) return;
  const heard = document.createElement("p");
  heard.innerHTML = "<strong>Heard:</strong> ";
  heard.append(document.createTextNode(t.original));
  const searched = document.createElement("p");
  searched.innerHTML = "<strong>Searched (fallback expansion):</strong> ";
  searched.append(document.createTextNode(t.expanded));
  const list = document.createElement("ul");
  for (const a of t.applied) {
    const li = document.createElement("li");
    li.textContent = `${a.from} → ${a.to} (${a.kind})`;
    list.append(li);
  }
  $("transform").append(heard, searched, list);
}

function renderTrace(r) {
  const rows = r.retrievalStages?.keyword ?? [];
  const box = $("trace");
  box.replaceChildren();
  $("trace-panel").hidden = !rows.length;
  $("connectors").replaceChildren();
  if (!rows.length) return;
  const scores = rows.map((x) => x.score);
  const min = Math.min(...scores),
    max = Math.max(...scores);
  const span = max - min || 1;
  const head = document.createElement("p");
  head.className = "trace-scale";
  head.textContent = `Keyword stage ranks · raw lexical scores · display scale min ${min.toFixed(2)} – max ${max.toFixed(2)} · bars normalized to that range, clamped at edges`;
  box.append(head);
  const cited = new Set(
    (r.unresolved ? r.reviewEvidence : r.evidence).map((c) => c.title),
  );
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "trace-row";
    el.dataset.title = row.title;
    const rank = document.createElement("span");
    rank.className = "trace-rank";
    rank.textContent = "#" + row.rank;
    const title = document.createElement("span");
    title.className = "trace-title";
    title.textContent = row.title;
    const score = document.createElement("span");
    score.className = "trace-score";
    score.textContent = row.score.toFixed(2);
    const barWrap = document.createElement("span");
    barWrap.className = "trace-bar";
    const t = Math.min(1, Math.max(0, (row.score - min) / span));
    const bar = document.createElement("span");
    bar.className = "trace-fill";
    bar.style.width = (t * 100).toFixed(1) + "%";
    if (row.score <= min) bar.classList.add("clamped");
    barWrap.append(bar);
    el.append(rank, title, score, barWrap);
    if (cited.has(row.title)) el.classList.add("cited");
    box.append(el);
  }
  requestAnimationFrame(drawConnectors);
}

function drawConnectors() {
  const svg = $("connectors");
  svg.replaceChildren();
  const host = $("output");
  const hostRect = host.getBoundingClientRect();
  // viewBox only, never width/height attributes: those become the used CSS
  // size and overflow a narrower viewport before the ResizeObserver redraws.
  svg.setAttribute("viewBox", `0 0 ${hostRect.width} ${hostRect.height}`);
  const evItems = [...document.querySelectorAll("#evidence details")];
  for (const row of document.querySelectorAll(".trace-row.cited")) {
    const target = evItems.find((d) =>
      d.querySelector("summary")?.textContent.includes(row.dataset.title),
    );
    if (!target) continue; // provenance edges only for actual citation links
    const a = row.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const x1 = a.left - hostRect.left - 6,
      y1 = a.top - hostRect.top + a.height / 2,
      x2 = b.left - hostRect.left + 6,
      y2 = b.top - hostRect.top + 10;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const mx = (x1 + x2) / 2;
    path.setAttribute(
      "d",
      `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
    );
    path.setAttribute("class", "connector");
    svg.append(path);
  }
}
new ResizeObserver(() => drawConnectors()).observe($("output"));
document.addEventListener(
  "toggle",
  (e) => {
    if (e.target instanceof HTMLDetailsElement) drawConnectors();
  },
  true,
);

async function load(documents) {
  busy(true);
  status("Reading documents and building source-linked memories…");
  try {
    const r = await api("import", { documents });
    $("sources").replaceChildren(
      ...r.sources.map((s) => {
        const li = document.createElement("li"),
          small = document.createElement("small");
        li.textContent = s.title;
        small.textContent = s.blocks + " memory blocks · original preserved";
        li.append(small);
        return li;
      }),
    );
    $("output").hidden = true;
    $("draft-panel").hidden = true;
    status("Documents ready. Ask a question above.");
  } catch (e) {
    status(e.message, true);
  } finally {
    busy(false);
  }
}
$("files").onchange = async (e) => {
  const files = [...e.target.files];
  if (files.length > 10 || files.some((f) => f.size > 240000)) {
    status("Choose up to 10 text files, each at most 240KB.", true);
    return;
  }
  await load(
    await Promise.all(
      files.map(async (f) => ({ title: f.name, text: await f.text() })),
    ),
  );
};
$("sample").onclick = () =>
  load([
    {
      title: "Fictional · client review.md",
      text: "# Fictional client review\n\nPilot launch is proposed for Tuesday. Security sign-off is still pending. Maya owns the security review.\n\n## Decisions\n- Budget of ₹50,000 approved by Maya.\n\n## Actions\n- Maya to send security review by Friday.",
    },
    {
      title: "Fictional · next meeting.md",
      text: "# Fictional next meeting\n\nThe pilot launch is not approved. Security sign-off remains pending. Budget approval is unchanged. Next discussion will review security findings.",
    },
  ]);
$("ask").onsubmit = async (e) => {
  e.preventDefault();
  draftAllowed = false;
  busy(true);
  status("Searching only this session’s documents…");
  $("draft-panel").hidden = true;
  try {
    const r = await api("query", { question: $("question").value });
    $("output").hidden = false;
    $("output").dataset.state = r.unresolved
      ? "unresolved"
      : r.refused
        ? "refused"
        : r.partial
          ? "partial"
          : "positive";
    $("answer").textContent = r.answer;
    const rs = $("record-status");
    rs.replaceChildren();
    rs.hidden = !r.partialNotice;
    if (r.partialNotice) rs.textContent = r.partialNotice;
    renderTransform(r.queryTransform);
    renderTrace(r);
    $("mode").textContent =
      r.mode +
      (r.evidenceStatus === "ambiguous"
        ? " Several sources are similarly relevant; no single resolved answer is established."
        : "");
    const existing = $("review-signals");
    existing?.remove();
    const panel = document.createElement("section");
    panel.id = "review-signals";
    const heading = document.createElement("h3");
    heading.textContent = "Across all your documents: points to reconcile";
    panel.append(heading);
    for (const [kind, items] of Object.entries(r.context.groups)) {
      if (!items.length) continue;
      const label = document.createElement("h4");
      label.textContent = {
        changes: "Changes mentioned",
        open: "Open items",
        conditions: "Conditions",
        decisions: "Decision statements (not verified approvals)",
      }[kind];
      panel.append(label);
      for (const c of items) {
        const p = document.createElement("p");
        p.className = "review-line";
        p.textContent =
          c.quote + " [" + c.title + ", line " + c.firstLine + "]";
        panel.append(p);
      }
    }
    const caution = document.createElement("p");
    caution.className = "note";
    caution.textContent =
      r.context.notice +
      " Scans all imported documents; check relevance to this question.";
    panel.append(caution);
    $("evidence").after(panel);
    $("timing").textContent = r.latencyMs + " ms retrieval";
    draftAllowed = r.supported === true && !r.refused;
    $("draft").disabled = !draftAllowed;
    $("evidence").replaceChildren(
      ...(r.unresolved ? r.reviewEvidence : r.evidence).map((c, i) => {
        const d = document.createElement("details"),
          s = document.createElement("summary"),
          p = document.createElement("pre"),
          h = document.createElement("p");
        s.textContent = `[${i + 1}] ${c.title} · lines ${c.firstLine}-${c.lastLine}`;
        p.textContent = c.quote;
        h.className = "hash";
        h.textContent = "SHA-256 " + c.hash;
        d.append(s, p, h);
        return d;
      }),
    );
    status(
      r.unresolved
        ? "Relevant passages need review. The question is unresolved; drafting is disabled."
        : r.refused
          ? "No supporting evidence found. Try a more specific question."
          : "Evidence ready. Open an original passage to inspect it.",
    );
  } catch (e) {
    status(e.message, true);
  } finally {
    busy(false);
    $("draft").disabled = !draftAllowed || !$("evidence").children.length;
  }
};
$("draft").onclick = async () => {
  busy(true);
  try {
    latestDraft = await api("draft", {});
    $("subject").value = latestDraft.subject;
    $("body").value = latestDraft.body;
    $("draft-panel").hidden = false;
    status("Review draft ready. No recipient selected and nothing sent.");
  } catch (e) {
    status(e.message, true);
  } finally {
    busy(false);
  }
};
$("download").onclick = () => {
  const url = URL.createObjectURL(
    new Blob(["Subject: " + $("subject").value + "\n\n" + $("body").value], {
      type: "text/plain;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "follow-up-draft.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("reset").onclick = async () => {
  busy(true);
  try {
    await api("reset", {});
    $("sources").replaceChildren();
    $("output").hidden = true;
    $("draft-panel").hidden = true;
    $("files").value = "";
    status("Session cleared. Add documents to start again.");
  } catch (e) {
    status(e.message, true);
  } finally {
    busy(false);
  }
};
// Live voice call via the official Bolna web-call SDK (v3.0.1). The Bolna API
// key never reaches the browser: the SDK POSTs to /api/bolna-session, which
// mints a short-lived single-use session server-side. Session mint expects
// {run_id, wss_url, sip_username} back (verified against the SDK bundle).
ready.then(async () => {
  let configured = false;
  try {
    const r = await fetch("/api/bolna-config");
    configured = (await r.json()).configured === true;
  } catch {}
  $("live-call").hidden = false;
  $("call-note").textContent = configured
    ? "Start a live microphone call with your Voice Memory agent. The browser will ask for microphone permission."
    : "Live calling is not configured on this server yet (BOLNA_API_KEY and BOLNA_AGENT_ID unset). Everything above still works.";
  $("call-start").disabled = !configured;
  const setCall = (t) => {
    $("call-status").textContent = t;
  };
  let call = null;
  $("call-start").onclick = async () => {
    $("call-start").disabled = true;
    setCall("Preparing call…");
    try {
      // Bind this session's imported documents to the voice capability
      // BEFORE minting: a live call must answer from these documents, and
      // the server refuses to mint without this grant.
      await api("voice/start", {});
      if (!window.BolnaWebCall) {
        await new Promise((ok, bad) => {
          const el = document.createElement("script");
          el.src =
            "https://cdn.jsdelivr.net/gh/bolna-ai/web-call@v3.0.1/dist/bolna-web-call.min.js";
          el.onload = ok;
          el.onerror = () =>
            bad(Error("Could not load the Bolna web-call SDK."));
          document.head.append(el);
        });
      }
      call = new BolnaWebCall({ sessionUrl: "/api/bolna-session" });
      call.on("call-start", () => {
        setCall("Live call in progress.");
        $("call-end").hidden = false;
      });
      call.on("call-end", () => {
        setCall("Call ended.");
        $("call-end").hidden = true;
        $("call-start").disabled = false;
      });
      call.on("error", (e) => {
        setCall("Call error: " + (e?.message || "unknown") + ".");
        $("call-end").hidden = true;
        $("call-start").disabled = false;
      });
      call.start();
    } catch (e) {
      setCall(e.message || "Could not start the call.");
      $("call-start").disabled = false;
    }
  };
  $("call-end").onclick = () => {
    try {
      call?.stop?.();
    } catch {}
  };
});
