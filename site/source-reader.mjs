// Opening any document opens the whole case as one reader: every page of
// every document, in order, with a page strip to jump between them. The
// chosen document scrolls into view; a cited line is marked on its page.
// The cited line itself is marked, never the whole document: a small
// document is one retrieval chunk, so its "focus" can be every line. The
// quote the answer rests on is found in the text (whitespace-tolerant);
// focus lines are used only when they overlap that quote.

// Loaded only when a source is opened, keeping first-paint weight unchanged.
export function textRenderer({ esc, prettyQuote }) {
  const words = (x) =>
    String(x ?? "")
      .toLowerCase()
      .match(/[\p{L}\p{N}$%.,/-]+/gu) ?? [];
  const overlap = (a, b) => {
    const B = new Set(words(b));
    const A = words(a);
    return A.length ? A.filter((w) => B.has(w)).length / A.length : 0;
  };
  const findSpan = (html, quote) => {
    const q = esc(
      String(quote ?? "")
        .trim()
        .replace(/^\d+\.\s*/, ""),
    );
    if (q.length < 8 || q.length > 600) return null;
    const re = new RegExp(
      q
        .split(/\s+/)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+"),
    );
    const m = re.exec(html);
    return m ? [m.index, m.index + m[0].length] : null;
  };
  const markText = (text, cites) => {
    let html = esc(text);
    const spans = [];
    for (const c of cites) {
      const quote = prettyQuote(c.quote);
      const exact = findSpan(html, quote) ?? findSpan(html, c.quote);
      if (exact) {
        spans.push(exact);
        continue;
      }
      const lines = (c.location?.focus?.text ?? [])
        .map((x) => String(x).trim())
        .filter((x) => x.length > 10)
        .filter((x, _, all) => all.length <= 2 || overlap(x, quote) >= 0.5);
      for (const l of lines) {
        const sp = findSpan(html, l);
        if (sp) spans.push(sp);
      }
    }
    // apply from the end so earlier offsets stay valid; skip overlaps
    spans.sort((a, b) => b[0] - a[0]);
    let last = Infinity;
    for (const [a, b] of spans) {
      if (b > last) continue;
      html = `${html.slice(0, a)}<mark>${html.slice(a, b)}</mark>${html.slice(b)}`;
      last = a;
    }
    return html.replace(/^# (.*)$/m, '<span class="h">$1</span>');
  };
  // Long text documents are set as pages (~42 lines), like a printout.
  const textPages = (html) => {
    const lines = html.split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i += 42)
      out.push(lines.slice(i, i + 42).join("\n"));
    return out.length ? out : [html];
  };
  return { markText, textPages };
}

export async function historicalSourceNote({
  api,
  workspace,
  primary,
  documents,
  esc,
}) {
  let current = null;
  try {
    current = await api(`/workspace/${workspace}`);
  } catch {
    /* unavailable */
  }
  const same =
    primary.hash &&
    current?.corpus?.sources?.some(
      (src) =>
        src.documentId === primary.documentId && src.hash === primary.hash,
    ) &&
    documents().some((d) => d.id === primary.documentId);
  if (same) return null;
  return `<p class="corpus-notice">Original source unavailable or not verified. This is the quote saved with that answer, not a same-title replacement.</p><p class="corpus-quote">${esc(primary.quote ?? "")}</p><details class="corpus-details"><summary>Source version details</summary><p style="overflow-wrap:anywhere">Source: ${esc(primary.sourceId ?? "unknown")}. Content hash: ${esc(primary.hash ?? "not recorded")}.</p></details>`;
}

const answeredVersions = new Map();
// The seen-history is a COUNT-bounded replay horizon: the last 64 committed
// versions per key. It is not a time bound - if 64 genuine version changes
// happen inside a cached entry's lifetime, the stale version is evicted and
// a later replay of it is indistinguishable from a genuine update: it would
// be mislabeled "updated" and re-committed. That residual risk is accepted
// (bounded memory over perfect staleness detection); the common stale-while
// -revalidate replay within a few versions is always caught.
const SEEN_HORIZON = 64;
export function renderCorpusNotice(answer, r, key) {
  const version = r.corpus.version;
  const entry = answeredVersions.get(key) ?? { latest: null, seen: [] };
  // A CDN edge can hand back a cached older answer after a newer one was
  // already shown (GET /answer is served stale-while-revalidate for a day).
  // A version this view already superseded is a replay, not an update: it
  // must never be called "updated documents", and it must never roll the
  // committed version back (which would re-announce the same change on the
  // next live answer). A live answer's own changedSinceLastAnswer still
  // wins: a genuine revert to identical content IS an update.
  const replay =
    entry.latest !== null &&
    version !== entry.latest &&
    entry.seen.includes(version);
  const changed =
    r.corpus.changedSinceLastAnswer === true ||
    (!replay && entry.latest !== null && entry.latest !== version);
  const committed = !replay || r.corpus.changedSinceLastAnswer === true;
  if (committed) {
    entry.seen.push(version);
    if (entry.seen.length > SEEN_HORIZON) entry.seen.shift();
    entry.latest = version;
    answeredVersions.delete(key);
    answeredVersions.set(key, entry);
    while (answeredVersions.size > 64)
      answeredVersions.delete(answeredVersions.keys().next().value);
  }
  const block = document.createElement("div");
  block.className = "corpus-version";
  block.dataset.corpusVersion = version;
  const notice = document.createElement("p");
  notice.className = "corpus-notice";
  notice.textContent = changed
    ? "Documents updated since the previous answer. This answer uses the updated documents."
    : "This answer uses the document versions read by Voice Memory.";
  const note = document.createElement("p");
  note.textContent = "External file edits aren't checked automatically.";
  const details = document.createElement("details");
  details.className = "corpus-details";
  const summary = document.createElement("summary");
  summary.textContent = "Document version details";
  const hash = document.createElement("p");
  hash.textContent = version;
  details.append(summary, hash);
  block.append(notice, note, details);
  // Hierarchy: a version change is material (amber callout, as before). An
  // unchanged version is provenance: one quiet line, limitation kept, so it
  // never competes with the answer or a real caveat. CSSOM, not markup, so
  // the landing page's first-load CSS does not grow.
  block.classList.toggle("is-changed", changed);
  if (!changed) {
    Object.assign(block.style, {
      borderLeft: "0",
      background: "none",
      padding: "0",
      margin: "8px 0",
      fontSize: "12.5px",
    });
    Object.assign(notice.style, { font: "inherit", color: "inherit", margin: "0", display: "inline" });
    Object.assign(note.style, { display: "inline", margin: "0 0 0 4px" });
  }
  answer.querySelector(".a-q").after(block);
  // The caller (site.js) advances its cache-busting key ONLY on versions
  // this history actually commits: a replayed stale answer must never roll
  // the key back, and a flagged genuine revert (replay by hash, but a real
  // change) must still advance it. `committed` is the single source of truth
  // for both.
  return { version, replay, changed, committed };
}
