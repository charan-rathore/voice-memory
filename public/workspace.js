// Workspace: document library (real server-side stages), asking, answers
// with verdicts, citations that open the source viewer, and the follow-up
// draft. The live-call wiring lives in app.js.
import { $, api, ready, status } from "./app.js";
import { openSource, closeSource } from "./viewer.js";

let draftAllowed = false;
let library = [];
let polling = null;
const history = [];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function busy(on) {
  for (const id of [
    "query",
    "draft",
    "northstar",
    "sample",
    "reset",
    "download",
  ]) {
    const b = $(id);
    if (b) b.disabled = on || (id === "draft" && !draftAllowed);
  }
  $("files").disabled = on;
}

// ------------------------------------------------------------- library
const STAGE_TEXT = {
  uploading: () => "Uploading",
  uploaded: () => "Waiting to be read",
  validating: () => "Checking the file",
  parsing: (d) =>
    d.kind === "png" || d.kind === "jpeg" || /\.(png|jpe?g)$/i.test(d.filename)
      ? "Reading text from the image"
      : /\.pdf$/i.test(d.filename)
        ? "Reading pages"
        : "Reading",
  indexing: () => "Indexing",
};
const KIND_LABEL = {
  pdf: "pdf",
  docx: "docx",
  png: "png",
  jpeg: "jpg",
  text: "txt",
  markdown: "md",
};

function readyFacts(d) {
  const s = d.stats ?? {};
  const bits = [];
  if (s.pages) bits.push(`${s.pages} ${s.pages === 1 ? "page" : "pages"}`);
  if (s.tables) bits.push(`${s.tables} ${s.tables === 1 ? "table" : "tables"}`);
  if (s.ocrPages || d.kind === "png" || d.kind === "jpeg")
    bits.push(
      `read by OCR${s.meanOcrConfidence != null ? ` at ${s.meanOcrConfidence}% confidence` : ""}`,
    );
  if (!bits.length && s.words) bits.push(`${s.words.toLocaleString()} words`);
  return bits.join(", ");
}

function renderLibrary() {
  const list = $("sources");
  list.replaceChildren(
    ...library.map((d) => {
      const li = el("li", "doc");
      li.dataset.status = d.status;
      const tab = el(
        "span",
        "doc-kind",
        KIND_LABEL[d.kind] ??
          (d.filename.split(".").pop() || "file").toLowerCase().slice(0, 4),
      );
      tab.setAttribute("aria-hidden", "true");
      const body = el("div", "doc-body");
      const name = el("p", "doc-name", d.filename);
      const state = el("p", "doc-state");
      if (STAGE_TEXT[d.status]) {
        state.append(
          el("span", "spinner"),
          document.createTextNode(
            STAGE_TEXT[d.status](d) +
              (d.progress != null && d.status === "uploading"
                ? ` ${d.progress}%`
                : ""),
          ),
        );
      } else if (d.status === "ready") {
        state.textContent = readyFacts(d) || "Ready";
      } else if (d.status === "needs_review") {
        state.textContent = "Check before using";
      } else if (d.status === "failed") {
        state.textContent = d.error?.message ?? "This file could not be read.";
      }
      body.append(name, state);
      if (d.status === "needs_review") {
        const why = el("ul", "doc-review");
        for (const r of d.review ?? []) why.append(el("li", "", r));
        body.append(why);
      }
      const actions = el("div", "doc-actions");
      if (d.status === "ready" || d.status === "needs_review") {
        const view = el("button", "link", "View");
        view.type = "button";
        view.onclick = () => openSource({ documentId: d.id });
        actions.append(view);
      }
      if (d.status === "needs_review" && !d.included) {
        const inc = el("button", "link", "Use it anyway");
        inc.type = "button";
        inc.onclick = () => libraryAction(d.id, "include");
        actions.append(inc);
      }
      if (["ready", "needs_review", "failed"].includes(d.status) && !d.local) {
        const rm = el("button", "link danger", "Remove");
        rm.type = "button";
        rm.setAttribute("aria-label", `Remove ${d.filename}`);
        rm.onclick = () => libraryAction(d.id, "remove");
        actions.append(rm);
      }
      if (d.local && d.status === "failed") {
        const rm = el("button", "link danger", "Dismiss");
        rm.type = "button";
        rm.onclick = () => {
          library = library.filter((x) => x !== d);
          renderLibrary();
        };
        actions.append(rm);
      }
      if (actions.childNodes.length) body.append(actions);
      li.append(tab, body);
      return li;
    }),
  );
  const usable = library.filter(
    (d) => d.status === "ready" || (d.status === "needs_review" && d.included),
  ).length;
  const working = library.filter((d) => STAGE_TEXT[d.status]).length;
  $("corpus-line").textContent = !library.length
    ? "No documents yet"
    : `${usable} ${usable === 1 ? "document" : "documents"} ready` +
      (working ? `, ${working} still reading` : "");
  $("empty").hidden = usable > 0 || !$("output").hidden;
  $("desk").dataset.docs = String(library.length);
}

async function refreshLibrary() {
  try {
    const r = await fetch("/api/library");
    if (!r.ok) return;
    const { documents } = await r.json();
    const locals = library.filter((d) => d.local);
    library = [...documents, ...locals];
    renderLibrary();
    return documents;
  } catch {
    return null;
  }
}

function pollLibrary() {
  if (polling) return;
  const tick = async () => {
    const docs = await refreshLibrary();
    const pending =
      (docs ?? []).some((d) => STAGE_TEXT[d.status]) ||
      library.some((d) => d.local && d.status === "uploading");
    if (pending) polling = setTimeout(tick, 450);
    else {
      polling = null;
      announceLibrary();
    }
  };
  polling = setTimeout(tick, 250);
}

function announceLibrary() {
  const ready = library.filter((d) => d.status === "ready").length;
  const review = library.filter(
    (d) => d.status === "needs_review" && !d.included,
  ).length;
  const failed = library.filter((d) => d.status === "failed").length;
  if (!library.length) return;
  const parts = [];
  if (ready) parts.push(`${ready} ready`);
  if (review) parts.push(`${review} to check`);
  if (failed) parts.push(`${failed} couldn't be read`);
  status(
    `Documents ready. Ask a question above.${parts.length > 1 || review || failed ? " (" + parts.join(", ") + ")" : ""}`,
    false,
  );
}

async function libraryAction(id, action) {
  try {
    await api(`library/${id}/${action}`, {});
    if (action === "remove") closeSource(id);
    await refreshLibrary();
    announceLibrary();
  } catch (e) {
    status(e.message, true);
  }
}

function uploadOne(file) {
  const local = {
    id: "local-" + Math.random().toString(36).slice(2),
    filename: file.name,
    status: "uploading",
    progress: 0,
    local: true,
  };
  library.push(local);
  renderLibrary();
  return new Promise((resolve) => {
    ready.then((csrf) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-CSRF-Token", csrf);
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        local.progress = Math.round((e.loaded / e.total) * 100);
        renderLibrary();
      };
      xhr.onload = () => {
        if (xhr.status === 202) library = library.filter((d) => d !== local);
        else {
          let msg = "Upload failed.";
          try {
            msg = JSON.parse(xhr.responseText).error || msg;
          } catch {}
          Object.assign(local, { status: "failed", error: { message: msg } });
        }
        renderLibrary();
        resolve();
      };
      xhr.onerror = () => {
        Object.assign(local, {
          status: "failed",
          error: {
            message:
              "The upload didn't reach the server. Check your connection and try again.",
          },
        });
        renderLibrary();
        resolve();
      };
      xhr.send(file);
    });
  });
}

async function addFiles(files) {
  if (!files.length) return;
  status(`Reading ${files.length} ${files.length === 1 ? "file" : "files"}…`);
  $("output").hidden = true;
  $("draft-panel").hidden = true;
  for (const f of files) await uploadOne(f);
  pollLibrary();
}

$("files").onchange = (e) => {
  addFiles([...e.target.files]);
  e.target.value = "";
};

// Whole-window drag and drop.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("dropveil").hidden = false;
});
addEventListener("dragover", (e) => {
  if (hasFiles(e)) e.preventDefault();
});
addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("dropveil").hidden = true;
  }
});
addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("dropveil").hidden = true;
  addFiles([...e.dataTransfer.files]);
});

async function loadText(documents, label) {
  busy(true);
  status(`Loading ${label}…`);
  try {
    await api("import", { documents });
    await refreshLibrary();
    $("output").hidden = true;
    $("draft-panel").hidden = true;
    closeSource();
    status("Documents ready. Ask a question above.");
  } catch (e) {
    status(e.message, true);
  } finally {
    busy(false);
  }
}
$("northstar").onclick = async () => {
  const r = await fetch("/api/demo-corpus");
  if (!r.ok)
    return status("The demo documents aren't available on this server.", true);
  await loadText((await r.json()).documents, "the Northstar demo");
  $("question").placeholder = "Was the $42,000 revision finalized?";
};
$("sample").onclick = () =>
  loadText(
    [
      {
        title: "Fictional · client review.md",
        text: "# Fictional client review\n\nPilot launch is proposed for Tuesday. Security sign-off is still pending. Maya owns the security review.\n\n## Decisions\n- Budget of ₹50,000 approved by Maya.\n\n## Actions\n- Maya to send security review by Friday.",
      },
      {
        title: "Fictional · next meeting.md",
        text: "# Fictional next meeting\n\nThe pilot launch is not approved. Security sign-off remains pending. Budget approval is unchanged. Next discussion will review security findings.",
      },
    ],
    "the fictional project",
  );

$("reset").onclick = async () => {
  busy(true);
  try {
    await api("reset", {});
    library = [];
    history.length = 0;
    renderHistory();
    renderLibrary();
    closeSource();
    $("output").hidden = true;
    $("draft-panel").hidden = true;
    $("empty").hidden = false;
    status("Session cleared. Add documents to start again.");
  } catch (e) {
    status(e.message, true);
  } finally {
    busy(false);
  }
};

$("docs-toggle").onclick = () => {
  const open = $("docs-toggle").getAttribute("aria-expanded") !== "true";
  $("docs-toggle").setAttribute("aria-expanded", String(open));
  $("docs-toggle").textContent = open ? "Hide" : "Show";
  $("rail-body").hidden = !open;
};

// ------------------------------------------------------------- answers
// Verdicts from the deterministic spoken renderer (spoken.mjs).
const LEAD_VERDICT = {
  CONFIRMED: ["positive", "supported", "Confirmed in the documents"],
  PROPOSED: ["partial", "partial", "Proposed, not approved"],
  OPEN: ["unresolved", "conflict", "Still open: the records differ"],
  "NO-RECORD": ["refused", "absent", "Not recorded in these documents"],
  "REJECTED-EXPLICIT": ["unresolved", "conflict", "Recorded as rejected"],
  QUOTED: ["positive", "supported", "Quoted from your documents"],
  // Lab results across reports (clinical prototype).
  COMPARED: ["positive", "supported", "Compared across reports"],
  LATEST: ["positive", "supported", "From the latest report"],
  SINGLE: ["positive", "supported", "Only one result on record"],
  NOT_COMPARABLE: ["unresolved", "conflict", "Not comparable as printed"],
  AMBIGUOUS_PATIENT: ["unresolved", "conflict", "More than one patient"],
};
const VERDICT = {
  positive: ["supported", "Supported by the documents"],
  partial: ["partial", "Supported, but related points are still open"],
  unresolved: ["conflict", "Not settled: the records disagree or need review"],
  refused: ["absent", "Not established by these documents"],
};

function locationText(c) {
  const loc = c.location;
  const focusPages = loc?.focus?.pages?.length ? loc.focus.pages : loc?.pages;
  if (focusPages?.length)
    return focusPages.length === 1
      ? `page ${focusPages[0]}`
      : `pages ${focusPages[0]}–${focusPages[focusPages.length - 1]}`;
  return c.firstLine === c.lastLine
    ? `line ${c.firstLine}`
    : `lines ${c.firstLine}-${c.lastLine}`;
}

// Our canonical text uses markdown-ish markers for headings and tables.
// Those are OUR linearization, not the person's document: show structure,
// not syntax. (The exact quoted span stays in the "full passage" disclosure.)
function renderQuote(node, text) {
  const lines = text.split("\n");
  let rows = [];
  const flushRows = () => {
    if (!rows.length) return;
    const t = el("table", "mini");
    for (const r of rows) {
      const tr = el("tr");
      for (const c of r) tr.append(el("td", "", c));
      t.append(tr);
    }
    node.append(t);
    rows = [];
  };
  for (const ln of lines) {
    const t = ln.trim();
    if (/^\|.*\|$/.test(t)) {
      if (!/^\|\s*:?-{3,}/.test(t))
        rows.push(
          t
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((x) => x.trim()),
        );
      continue;
    }
    flushRows();
    if (!t) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    node.append(el("p", h ? "q-head" : "q-line", h ? h[1] : t));
  }
  flushRows();
}
function miniTable(rows) {
  const t = el("table", "mini");
  const header = rows.find((r) => r.header)?.header;
  if (header) {
    const tr = el("tr");
    for (const h of header) tr.append(el("th", "", h));
    t.append(tr);
  }
  for (const r of rows) {
    const tr = el("tr", "mini-hit");
    for (const c of r.cells) tr.append(el("td", "", c));
    t.append(tr);
  }
  return t;
}

function renderCitation(c, i) {
  const li = el("li", "cite");
  const head = el("button", "cite-open");
  head.type = "button";
  const n = el("span", "cite-n", String(i + 1));
  n.setAttribute("aria-hidden", "true");
  const title = el("span", "cite-title", c.title);
  const where = el("span", "cite-where", locationText(c));
  head.append(n, title, where);
  head.setAttribute(
    "aria-label",
    `Open source ${i + 1}: ${c.title}, ${locationText(c)}`,
  );
  head.onclick = () =>
    openSource({ documentId: c.documentId, title: c.title, evidence: c });
  const quote = el("blockquote", "cite-quote");
  const focus = c.location?.focus;
  if (focus?.rows?.length) quote.append(miniTable(focus.rows));
  else {
    const focusText = focus?.text?.length ? focus.text.join("\n") : null;
    const text =
      focusText && focusText.length < c.quote.length ? focusText : c.quote;
    renderQuote(
      quote,
      text.length > 600 ? text.slice(0, 560).trimEnd() + "…" : text,
    );
  }
  li.append(head, quote);
  if (c.location?.methods?.includes("ocr"))
    li.append(
      el(
        "p",
        "cite-flag",
        `Read by OCR at ${c.location.minConfidence ?? "?"}% confidence. Check numbers against the original.`,
      ),
    );
  // Kept for the existing journey checks: a disclosure with the full passage.
  const d = el("details", "cite-full");
  const s = el(
    "summary",
    "",
    `[${i + 1}] ${c.title} · lines ${c.firstLine}-${c.lastLine}`,
  );
  const pre = el("pre", "", c.quote);
  const h = el("p", "hash", "SHA-256 " + c.hash);
  d.append(s, pre, h);
  li.append(d);
  return li;
}

function renderTrace(r) {
  const rows = r.retrievalStages?.keyword ?? [];
  $("trace-panel").hidden = !rows.length && !r.queryTransform;
  $("mode").textContent =
    "Found by keyword search over this session's documents, then checked against the original text. No language model writes these answers." +
    (r.evidenceStatus === "ambiguous"
      ? " Several sources were similarly relevant, so no single answer is treated as settled."
      : "");
  const box = $("trace");
  box.replaceChildren();
  if (rows.length) {
    const max = Math.max(...rows.map((x) => x.score)) || 1;
    const cited = new Set(
      [...(r.evidence ?? []), ...(r.reviewEvidence ?? [])].map((c) => c.title),
    );
    for (const row of rows) {
      const line = el(
        "div",
        "trace-row" + (cited.has(row.title) ? " cited" : ""),
      );
      const t = el("span", "trace-title", row.title);
      const bar = el("span", "trace-bar");
      const fill = el("span", "trace-fill");
      fill.style.width = Math.max(4, (row.score / max) * 100).toFixed(0) + "%";
      bar.append(fill);
      const sc = el("span", "trace-score", row.score.toFixed(2));
      line.append(t, bar, sc);
      box.append(line);
    }
  }
  const tr = $("transform");
  tr.replaceChildren();
  tr.hidden = !r.queryTransform;
  if (r.queryTransform) {
    tr.append(
      el(
        "p",
        "",
        `Your words found nothing directly, so the search also tried: “${r.queryTransform.expanded}”.`,
      ),
    );
  }
}

function renderSignals(r) {
  $("signals-slot").replaceChildren();
  const groups = r.context?.groups ?? {};
  const names = {
    changes: "Changes mentioned",
    open: "Still open",
    conditions: "Conditions",
    decisions: "Decision statements (not verified approvals)",
  };
  const total = Object.values(groups).reduce((n, g) => n + g.length, 0);
  if (!total) return;
  const d = el("details", "more");
  d.id = "review-signals";
  d.append(
    el(
      "summary",
      "",
      `Other points to reconcile across your documents (${total})`,
    ),
  );
  for (const [k, items] of Object.entries(groups)) {
    if (!items.length) continue;
    d.append(el("h4", "", names[k] ?? k));
    const ul = el("ul", "signals");
    for (const c of items) {
      const li = el("li");
      li.append(
        el("span", "signal-quote", c.quote),
        el("span", "signal-src", ` ${c.title}, line ${c.firstLine}`),
      );
      ul.append(li);
    }
    d.append(ul);
  }
  d.append(
    el(
      "p",
      "more-note",
      (r.context.notice ?? "") +
        " These come from all documents, not only this answer.",
    ),
  );
  $("signals-slot").append(d);
}

function renderHistory() {
  $("history").hidden = history.length < 2;
  $("history-list").replaceChildren(
    ...history.slice(1, 8).map((h) => {
      const li = el("li");
      const b = el("button", "history-q", h.question);
      b.type = "button";
      b.onclick = () => {
        $("question").value = h.question;
        $("question").focus();
      };
      li.append(b, el("p", "history-a", h.verdict));
      return li;
    }),
  );
}

$("ask").onsubmit = async (e) => {
  e.preventDefault();
  const question = $("question").value.trim();
  if (!question) return;
  draftAllowed = false;
  busy(true);
  status("Searching only this session’s documents…");
  $("draft-panel").hidden = true;
  try {
    const r = await api("query", { question });
    // "Partial" in the engine means two different things: a claim whose
    // status is proposed/pending (answer is a "Record status"), or merely
    // that SOME document in the session mentions an open item. Only the
    // first changes the verdict; the second stays as a notice below.
    const claimStatus = /^Record status:/.test(r.answer);
    const engineState = r.unresolved
      ? "unresolved"
      : r.refused
        ? "refused"
        : r.partial && claimStatus
          ? "partial"
          : "positive";
    // The lead is the same verified sentence a voice call would speak; when
    // present, its own verdict and citations describe the answer.
    const lead = LEAD_VERDICT[r.lead?.verdict] ? r.lead : null;
    const state = lead ? LEAD_VERDICT[lead.verdict][0] : engineState;
    const [cls, label] = lead
      ? LEAD_VERDICT[lead.verdict].slice(1)
      : VERDICT[state];
    $("empty").hidden = true;
    $("output").hidden = false;
    $("output").dataset.state = state;
    $("verdict").className = "verdict " + cls;
    $("verdict").textContent = label;
    $("answer").textContent = lead?.text ?? r.answer;
    $("full-record").hidden = !lead;
    $("full-record").open = false;
    $("full-answer").textContent = lead ? r.answer : "";
    $("record-status").hidden = !r.partialNotice || !!lead;
    $("record-status").textContent = claimStatus
      ? (r.partialNotice ?? "")
      : "Other passages in your documents mention open, conditional or differing points. Check them before treating this as settled.";
    const cites = lead?.citations?.length
      ? lead.citations
      : r.unresolved
        ? r.reviewEvidence
        : r.refused
          ? (r.reviewEvidence ?? [])
          : r.evidence;
    $("evidence").replaceChildren(...(cites ?? []).map(renderCitation));
    $("evidence").previousElementSibling.hidden = !cites?.length;
    $("evidence").previousElementSibling.textContent = lead
      ? "Inspect the originals"
      : state === "refused"
        ? "Closest passages (they don't answer this)"
        : state === "unresolved"
          ? "Passages to reconcile"
          : "Inspect the originals";
    renderTrace(r);
    renderSignals(r);
    $("timing").textContent = `Found in ${r.latencyMs} ms`;
    draftAllowed = r.supported === true && !r.refused;
    history.unshift({ question, verdict: label });
    renderHistory();
    // Lab-result answers come from typed observations, not the keyword stage,
    // so their status follows the shown answer; everything else keeps the
    // engine's verdict (it also gates drafting).
    const clinicalLead =
      /^(COMPARED|LATEST|SINGLE|NOT_COMPARABLE|AMBIGUOUS_PATIENT)$/.test(
        lead?.verdict ?? "",
      );
    const statusState = clinicalLead ? state : engineState;
    status(
      statusState === "unresolved"
        ? "Relevant passages need review. The question is unresolved; drafting is disabled."
        : statusState === "refused" && !(clinicalLead && cites?.length)
          ? "No supporting evidence found. Try naming the thing you're looking for."
          : "Evidence ready. Open an original passage to inspect it.",
    );
    const first = cites?.[0];
    if ((state === "refused" && !lead) || !first?.location) closeSource();
    else if (matchMedia("(min-width: 1180px)").matches)
      openSource({
        documentId: first.documentId,
        title: first.title,
        evidence: first,
        quiet: true,
      });
  } catch (err) {
    status(err.message, true);
  } finally {
    busy(false);
    $("draft").disabled = !draftAllowed || !$("evidence").children.length;
  }
};
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("ask").requestSubmit();
  }
});

$("draft").onclick = async () => {
  busy(true);
  try {
    const d = await api("draft", {});
    $("subject").value = d.subject;
    $("body").value = d.body;
    $("draft-panel").hidden = false;
    $("draft-panel").scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
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

// Voice turn citations (rendered by app.js) open the matching document.
$("voice-turn-evidence").addEventListener("click", (e) => {
  const sum = e.target.closest?.("summary");
  if (!sum) return;
  const title = sum.textContent.split(" · ")[0];
  const doc = library.find((d) => d.filename === title || d.title === title);
  const quote = sum.parentElement.querySelector("pre")?.textContent;
  if (doc)
    openSource({ documentId: doc.id, title, quoteText: quote, quiet: true });
});

refreshLibrary().then((docs) => {
  if (docs?.some((d) => STAGE_TEXT[d.status])) pollLibrary();
  else if (docs?.length) announceLibrary();
});
