export const $ = (id) => document.getElementById(id);
let csrf;
// True when the server placed this browser in the open public demo
// (VM_PUBLIC_DEMO): a fresh session over the fictional Northstar corpus.
// Uploads, mutations and voice calls stay owner-only there (403), so the
// page hides every control that would only fail for the visitor.
export let demoMode = false;
export const ready = fetch("/api/session")
  .then((r) => r.json())
  .then((s) => {
    csrf = s.csrf;
    demoMode = s.demo === true;
    if (demoMode) {
      document.body.classList.add("public-demo");
      const banner = document.createElement("p");
      banner.className = "demo-banner";
      banner.textContent =
        "Public demo: you are looking at a fictional Northstar workspace. " +
        "Ask questions and open the cited passages - uploading, editing " +
        "and voice calls are off in this shared demo.";
      $("column")?.prepend(banner);
    }
    // Hero talk CTA is a shortcut to the real call control; it never
    // appears for demo visitors (CSS gate) and just forwards the click.
    $("hero-talk")?.addEventListener("click", () => $("call-start")?.click());
  });
export function status(text, error = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", error);
}
// Owner evidence feed for the live voice call: poll the server-side record
// of the last verified voice turn and show exactly what was spoken plus its
// citations. Single-call correlation only; silent on transient errors.
let voicePoll = null;
async function renderVoiceTurn(final = false) {
  try {
    const r = await fetch("/api/voice/last").then((x) => x.json());
    const st = r.turn?.spokenTurn;
    if (!st) {
      if (final && !$("voice-turn").hidden) {
        $("voice-turn").textContent =
          "No verified voice turn in the last call.";
        $("voice-turn-evidence").replaceChildren();
      }
      return;
    }
    // The turn's own server-side timestamp: never presented as "just now",
    // and a turn from an earlier call keeps its real time.
    const when = new Date(st.at ?? Date.now()).toLocaleTimeString();
    $("voice-turn").hidden = false;
    $("voice-turn").textContent = `${
      final ? "Final verified turn of the last call" : "Last verified turn"
    } (${st.verdict}, ${when}): ${st.spoken}`;
    $("voice-turn-evidence").replaceChildren(
      ...(st.citations ?? []).map((c) => {
        const d = document.createElement("details"),
          s = document.createElement("summary"),
          p = document.createElement("pre");
        s.textContent = `${c.title} · lines ${c.firstLine}-${c.lastLine}`;
        p.textContent = c.quote;
        d.append(s, p);
        return d;
      }),
    );
  } catch {
    /* transient during call setup/teardown */
  }
}
function startVoicePoll() {
  stopVoicePoll();
  // New call, new sequence: the panel waits for THIS call's first verified
  // turn instead of showing the previous call's last one.
  $("voice-turn").hidden = false;
  $("voice-turn").textContent =
    "Listening for the first verified turn of this call\u2026";
  $("voice-turn-evidence").replaceChildren();
  const tick = () => {
    renderVoiceTurn().finally(() => {
      if (voicePoll) voicePoll = setTimeout(tick, 3000);
    });
  };
  voicePoll = setTimeout(tick, 3000);
  renderVoiceTurn();
}
function stopVoicePoll() {
  if (voicePoll) clearTimeout(voicePoll);
  voicePoll = null;
}

// Bolna web-call SDK error codes (v3.0.1) mapped to what the person can do.
const CALL_ERRORS = {
  microphone_denied:
    "Call error: microphone access is blocked. Allow the microphone in your browser's address bar, then start the call again.",
  mint_failed:
    "Call error: the server couldn't open a call session. Try again in a moment.",
  at_capacity:
    "Call error: the voice service is busy right now. Try again in a minute.",
  connect_failed:
    "Call error: the call couldn't connect. Check your connection and try again.",
  call_rejected: "Call error: the voice service declined the call. Try again.",
  autoplay_blocked:
    "Call error: the browser blocked audio playback. Click the page once, then start the call again.",
  already_active: "Call error: a call is already running in this tab.",
};
export function callErrorText(e) {
  return (
    CALL_ERRORS[e?.code] ??
    "Call error: " +
      (e?.message || "unknown") +
      ". Check microphone permission and try again."
  );
}
export async function api(path, data) {
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
    ? "Ask out loud. Your browser will ask for the microphone. Each verified answer appears here with the passages it used."
    : "Live calling isn't set up on this server (BOLNA_API_KEY and BOLNA_AGENT_ID are unset). Typed questions still work.";
  $("call-start").disabled = !configured;
  const setCall = (t) => {
    $("call-status").textContent = t;
    // Visual state for the talk pill, derived from what the SDK reported.
    const state = /in progress/i.test(t)
      ? "live"
      : /preparing/i.test(t)
        ? "connecting"
        : /error|timed out|could not|failed|denied|not configured|retired|expired/i.test(
              t,
            )
          ? "error"
          : "idle";
    $("live-call").setAttribute("data-state", state);
  };
  $("talk-more").onclick = () => {
    const open = $("live-call").getAttribute?.("data-open") === "true";
    $("live-call").setAttribute("data-open", String(!open));
    $("talk-more").setAttribute("aria-expanded", String(!open));
  };
  // Readiness is a read-only snapshot for the operator (morning demo,
  // cold-start recovery): it reports state, it never changes it.
  const renderReadiness = (r) => {
    const missing = [];
    if (!r.corpusLoaded) missing.push("load the demo documents");
    if (!r.voice.bound)
      missing.push(
        r.voice.fixedCapability
          ? "start a live call once to bind the voice credential"
          : "start voice",
      );
    if (r.voice.fixedCapability && r.voice.secondsRemaining === 0)
      missing.push("the voice credential has reached its fixed expiry");
    if (r.voice.fixedCapability && !r.voice.bolnaConfigured)
      missing.push("Bolna calling is not configured on this server");
    const expiry = r.voice.hardExpiresAt
      ? ` Voice credential valid until ${new Date(r.voice.hardExpiresAt).toLocaleString()}.`
      : "";
    $("readiness-status").textContent = r.ready
      ? r.corpusKind === "pinned-demo"
        ? `Voice demo ready: Northstar (${r.documents} fictional documents) pinned for the call; ${
            r.sessionDocuments
              ? `${r.sessionDocuments} typed document(s) loaded for on-screen Q&A - the call still answers the pinned corpus.`
              : "no typed documents loaded."
          }${expiry}`
        : `Ready: ${r.documents} documents loaded, voice bound.${expiry}`
      : r.corpusKind === "pinned-demo"
        ? `Voice demo not ready: ${missing.join("; ")}.`
        : `Not ready: ${missing.join("; ")}.`;
  };
  const checkReadiness = async () => {
    // A failed probe MUST invalidate any earlier ready line: after a redeploy
    // or session wipe the old green text would silently lie about the state
    // of a fresh process. Only a fresh 200 renders readiness.
    try {
      const r = await fetch("/api/readiness");
      if (r.ok) {
        renderReadiness(await r.json());
        return;
      }
      $("readiness-status").textContent =
        r.status === 401 || r.status === 403
          ? "Voice demo readiness is not verified: your owner session has ended. Sign in again at /owner-signin, then re-check before the call."
          : `Voice demo readiness is not verified (server answered ${r.status}). Do not rely on an earlier ready state - wait a moment and re-check.`;
    } catch {
      $("readiness-status").textContent =
        "Voice demo readiness is not verified: the server did not answer (it may be waking from sleep). Do not rely on an earlier ready state - re-check in about a minute.";
    }
  };
  $("readiness-check").onclick = checkReadiness;
  checkReadiness();
  let call = null;
  let setupTimer = null;
  // Attempt generation: incremented on timeout or manual end. Any SDK event
  // or start() settlement arriving for an older generation is stale and
  // ignored - a late SDK resolution must never reopen a timed-out call.
  let attemptId = 0;
  const SETUP_TIMEOUT_MS = 45000;
  const clearSetup = () => {
    if (setupTimer) clearTimeout(setupTimer);
    setupTimer = null;
  };
  $("call-start").onclick = async () => {
    // One attempt at a time (also covers a double click).
    if (setupTimer || call) return;
    $("call-start").disabled = true;
    setCall("Preparing call…");
    const id = ++attemptId;
    const current = () => id === attemptId;
    // App-owned setup deadline, independent of any SDK-internal timeout:
    // getUserMedia can pend forever and a mint can stall, so the UI must
    // recover on its own clock.
    setupTimer = setTimeout(() => {
      if (!current()) return;
      attemptId++;
      const stale = call;
      call = null;
      setupTimer = null;
      try {
        stale?.stop?.();
      } catch {}
      $("call-end").hidden = true;
      $("call-start").disabled = false;
      setCall(
        "Call setup timed out. If the browser is still asking for microphone permission, allow it and try again.",
      );
    }, SETUP_TIMEOUT_MS);
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
      if (!current()) return;
      const c = new BolnaWebCall({ sessionUrl: "/api/bolna-session" });
      call = c;
      // Voice lab (public/voicelab.js) measures the live call from the same
      // SDK object; it only listens, never controls the call.
      try {
        globalThis.dispatchEvent?.(
          new CustomEvent("vm:call", { detail: { call: c } }),
        );
      } catch {
        /* no DOM events (tests): measurement is optional */
      }
      c.on("call-start", () => {
        if (!current() || call !== c) return;
        clearSetup();
        setCall("Live call in progress.");
        $("call-end").hidden = false;
        startVoicePoll();
      });
      c.on("call-end", () => {
        if (call !== c) return;
        call = null;
        stopVoicePoll();
        renderVoiceTurn(true);
        setCall("Call ended.");
        $("call-end").hidden = true;
        $("call-start").disabled = false;
      });
      c.on("error", (e) => {
        if (call !== c) return;
        clearSetup();
        call = null;
        setCall(callErrorText(e));
        $("call-end").hidden = true;
        $("call-start").disabled = false;
      });
      await c.start().catch((e) => {
        // A rejection for an already-invalidated attempt (timeout/End) is
        // expected SDK noise, not a new error.
        if (!current() || call !== c) return;
        throw e;
      });
      if (!current() || call !== c) {
        // Resolved after the attempt was invalidated: close the stale call
        // so the SDK cannot keep a live session behind the UI's back.
        try {
          c.stop?.();
        } catch {}
        return;
      }
      clearSetup();
    } catch (e) {
      if (!current()) return;
      clearSetup();
      call = null;
      setCall(e.message || "Could not start the call.");
      $("call-start").disabled = false;
    }
  };
  $("call-end").onclick = () => {
    attemptId++;
    clearSetup();
    stopVoicePoll();
    const stale = call;
    call = null;
    try {
      stale?.stop?.();
    } catch {}
    $("call-end").hidden = true;
    $("call-start").disabled = false;
    setCall("Call ended.");
    renderVoiceTurn(true);
  };
});
