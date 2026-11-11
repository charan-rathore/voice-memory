// Two calls, one memory: the caller-memory demo page.
// Server-owned call (HttpOnly cookie); this page never sends identity claims,
// history or assistant text. Turns within a call are sent in order and never
// dropped: a line typed while an answer is coming is queued behind it.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const state = { persona: "asha", onCall: false, recalled: 0, chain: Promise.resolve(), calls: { asha: 0, ravi: 0 } };

  async function api(path, body) {
    const r = await fetch("/api/public/caller" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "Request failed."), { status: r.status, code: j.code });
    return j;
  }

  // ------------------------------------------------------------ transcript
  const tx = $("#transcript");
  function line(kind, html) {
    const li = document.createElement("li");
    li.className = "msg " + kind;
    li.innerHTML = html;
    tx.append(li);
    tx.scrollTop = tx.scrollHeight;
    return li;
  }
  const vmHtml = (text) => `<span class="who">Voice Memory</span>${esc(text)}`;

  // ------------------------------------------------------------ the three sections
  const verdictChip = (v) => {
    const map = {
      CONFIRMED: ["ok", "Approved on record"],
      LATEST: ["ok", "Latest on record"],
      PROPOSED: ["warn", "Proposed, not approved"],
      OPEN: ["warn", "Still open"],
      UNKNOWN: ["no", "Not established"],
    };
    const [c, l] = map[v] ?? ["warn", v ? String(v).toLowerCase() : "Answer"];
    return `<span class="chipv ${c}">${esc(l)}</span>`;
  };
  function flash(id) {
    const el = $(id);
    el.classList.add("fresh");
    setTimeout(() => el.classList.remove("fresh"), 900);
  }
  function renderRemembered(items) {
    $("#remembered").innerHTML = items.length
      ? `<ul class="items">${items
          .map(
            (x) =>
              `<li><span class="k">${esc(x.k)}</span><span class="v">${esc(x.v)}</span>${x.act ? `<span class="act">${x.act}</span>` : ""}</li>`,
          )
          .join("")}</ul>`
      : `<p class="empty">Nothing remembered for this caller.</p>`;
    flash("#sec-remembered");
  }
  function renderVerified(v, note) {
    if (!v) {
      $("#verified").innerHTML = `<p class="empty">No document answer for that line.</p>`;
      return;
    }
    const cites = (v.citations ?? []).slice(0, 3);
    $("#verified").innerHTML = `
      <p class="answer">${verdictChip(v.verdict)}${esc(v.text ?? "These documents don't establish that.")}</p>
      ${
        cites.length
          ? `<ul class="cites">${cites
              .map((c) => `<li><span class="t">${esc((c.title ?? "").replace(/\.md$/, "").replace(/^\d+_/, "").replace(/_/g, " "))}</span>${esc(c.quote)}</li>`)
              .join("")}</ul>`
          : ""
      }
      <p class="meta">Source version <b>${esc((v.scope?.version ?? "").slice(0, 8) || "unknown")}</b>${note ? ` · ${esc(note)}` : ""}</p>`;
    flash("#sec-verified");
  }
  function renderUnresolved(items) {
    $("#unresolved").innerHTML = items.length
      ? `<ul class="items">${items.map((x) => `<li><span class="k">${esc(x.label)}</span><span class="v">${esc(x.detail ?? "")}</span></li>`).join("")}</ul>`
      : `<p class="empty">Nothing open for this answer.</p>`;
    flash("#sec-unresolved");
  }
  const langName = (v) => ({ en: "English", hi: "Hindi", hinglish: "Hinglish" })[v] ?? v;
  function rememberedFrom(memory, extra = []) {
    const out = [];
    const p = memory?.preferences ?? {};
    if (p.language)
      out.push({
        k: "Language",
        v: `${langName(p.language.value)} · you asked on ${new Date(p.language.at).toLocaleDateString()}`,
        act: `<button class="link" data-say="Please switch my language to ${p.language.value === "en" ? "Hinglish" : "English"}">Change</button><button class="link" data-say="Forget my language preference">Forget</button>`,
      });
    if (p.answerLength) out.push({ k: "Answer length", v: p.answerLength.value });
    if (!extra.length)
      for (const r of memory?.referents ?? []) out.push({ k: "Discussed", v: `${r.label} (${new Date(r.at).toLocaleString()})` });
    if (memory?.consent?.conversation) out.push({ k: "Consent", v: "Remember our calls · say “forget this conversation” to stop" });
    return [...extra, ...out];
  }
  async function refreshLedger() {
    try {
      const { memory } = await api("/memory");
      const n =
        Object.keys(memory.preferences).length + memory.episodes.length + memory.referents.length + memory.requests.length;
      $("#ledger-count").textContent = `(${n} item${n === 1 ? "" : "s"}${memory.durable ? ", encrypted on disk" : ", this process only"})`;
      $("#ledger-body").innerHTML = `<pre>${esc(
        JSON.stringify(
          {
            preferences: Object.fromEntries(Object.entries(memory.preferences).map(([k, v]) => [k, v.value])),
            conversationConsent: !!memory.consent.conversation,
            episodes: memory.episodes.map((e) => ({ at: e.at, question: e.question, verdict: e.outcome.verdict, sourceVersion: e.scope.version.slice(0, 8) })),
            openRequests: memory.requests.filter((r) => r.status === "open").map((r) => r.text),
          },
          null,
          2,
        ),
      )}</pre>`;
      $("#forget-all").hidden = n === 0;
      return memory;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ script
  function renderScript(memory) {
    const lines = !state.onCall
      ? []
      : state.persona === "ravi"
        ? ["Was the revised fee approved?", "What do you remember about me?"]
        : state.recalled
          ? ["Let me know when the fee is approved", "Please switch my language to English", "Forget my language preference", "Forget everything"]
          : memory && Object.keys(memory.preferences ?? {}).length
            ? ["Was the revised fee approved?", "Remember that the fee was approved."]
            : ["Please remember that I prefer Hinglish, and remember this conversation for next time.", "Was the revised fee approved?"];
    $("#script").innerHTML = lines.map((l) => `<button class="chip" type="button" data-say="${esc(l)}">${esc(l)}</button>`).join("");
    document.querySelectorAll(".steps li").forEach((li) => li.classList.remove("on"));
    const step = state.persona === "ravi" || state.changed ? 3 : state.recalled || (!state.onCall && state.calls.asha) ? 2 : 1;
    $("#say").placeholder = state.onCall ? "Say something…" : "Start a call, then say something…";
    document.querySelector(`.steps li[data-step="${step}"]`)?.classList.add("on");
  }

  // ------------------------------------------------------------ actions
  async function start() {
    const btn = $("#start");
    btn.setAttribute("aria-busy", "true");
    // A new call never shows the previous call's lines or answers.
    tx.innerHTML = "";
    line("sys", "Connecting and verifying…");
    for (const id of ["#remembered", "#verified", "#unresolved"]) $(id).innerHTML = `<p class="empty">…</p>`;
    try {
      const { assertion } = await api("/demo-assertion", { persona: state.persona });
      const s = await api("/start", { assertion, case: "deal" });
      state.onCall = true;
      state.calls[state.persona]++;
      state.recalled = s.rechecked.length;
      state.changed = false;
      tx.innerHTML = "";
      line("sys", `Simulated call started · ${esc(s.caller.displayName)} · verified (${esc(s.caller.method)})`);
      line("vm", vmHtml(s.say));
      $("#status").innerHTML = `On a call as <b>${esc(s.caller.displayName)}</b>. Verified by a signed test identity at ${new Date(s.caller.verifiedAt).toLocaleTimeString()}.`;
      $("#start").hidden = true;
      $("#end").hidden = false;
      const memory = await refreshLedger();
      const r = s.rechecked[0];
      renderRemembered(
        rememberedFrom(memory, r ? [{ k: "Last time", v: `You asked “${r.previously.question}” · then: ${String(r.previously.verdict).toLowerCase()}` }] : []),
      );
      if (r) renderVerified(r.verified, r.sourceChanged ? "documents changed since your last call" : "unchanged since your last call");
      else $("#verified").innerHTML = `<p class="empty">Ask something. The answer comes from the documents, with the line it rests on.</p>`;
      renderUnresolved(
        [
          ...(r && /PROPOSED|OPEN/.test(r.verified?.verdict ?? "") ? [{ label: "Status", detail: "Still not approved on record." }] : []),
          ...(s.openRequests ?? []).map((q) => ({ label: "Your open request", detail: q.text })),
        ],
      );
      renderScript(memory);
      $("#say").focus();
    } catch (e) {
      line("sys", esc(e.status === 404 ? "Caller memory isn't switched on for this server." : e.message));
    } finally {
      btn.removeAttribute("aria-busy");
    }
  }
  async function end() {
    try {
      await api("/end", {});
    } catch {}
    state.onCall = false;
    line("sys", "Simulated call ended. Start again to call back.");
    $("#start").hidden = false;
    $("#end").hidden = true;
    $("#status").textContent = "Not on a call.";
    renderScript(null);
  }
  function say(text) {
    text = String(text ?? "").trim();
    if (!text) return;
    if (!state.onCall) {
      line("sys", "Start a call first.");
      return;
    }
    line("caller", esc(text));
    const pending = line("vm pending", vmHtml("…"));
    state.chain = state.chain.then(async () => {
      try {
        const r = await api("/turn", { utterance: text });
        pending.classList.remove("pending");
        pending.innerHTML = vmHtml(r.say);
        const memory = await refreshLedger();
        if (r.kind === "answer") {
          renderRemembered(rememberedFrom(memory, r.sections.remembered.filter((x) => x.kind !== "preference").map((x) => ({ k: x.label, v: x.detail }))));
          renderVerified(r.sections.verified, null);
          renderUnresolved(r.sections.unresolved);
        } else {
          if (/^(correct|forget)/.test(r.op)) state.changed = true;
          renderRemembered(rememberedFrom(memory));
          if (r.op === "refused") renderUnresolved([{ label: "Not saved", detail: r.say }]);
          if (r.op === "forget_all") {
            $("#verified").innerHTML = `<p class="empty">Answers come from the documents, with the line they rest on.</p>`;
            renderUnresolved([]);
          }
        }
        renderScript(memory);
      } catch (e) {
        pending.classList.remove("pending");
        pending.classList.add("err");
        pending.innerHTML = vmHtml(e.status === 401 ? "This call has ended. Start a new call." : e.message);
        if (e.status === 401) {
          state.onCall = false;
          $("#start").hidden = false;
          $("#end").hidden = true;
        }
      }
    });
  }

  // ------------------------------------------------------------ wiring
  document.querySelectorAll(".seg button").forEach((b) =>
    b.addEventListener("click", async () => {
      if (b.dataset.persona === state.persona) return;
      if (state.onCall) await end();
      state.persona = b.dataset.persona;
      document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      $("#status").textContent = `Not on a call. Selected ${b.textContent} (fictional).`;
    }),
  );
  $("#start").addEventListener("click", start);
  $("#end").addEventListener("click", end);
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("#say").value;
    $("#say").value = "";
    say(v);
  });
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-say]");
    if (t) say(t.dataset.say);
  });
  $("#forget-all").addEventListener("click", () => say("Forget everything"));
  renderScript(null);
})();
