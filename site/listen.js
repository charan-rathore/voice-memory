// Listen: the answer, spoken by the server's neural voice (Sarvam Bulbul or
// ElevenLabs), one sentence at a time with the next prefetched, and each word
// lit as it is said. Loaded by site.js on the first Listen press.
//
// The client sends the question, never the text: the server re-resolves the
// answer and speaks its own opener + sentence (POST /api/public/speak). There
// is no browser-voice fallback: if the voice is down the button says so and
// the answer stays on screen to read.
(() => {
  "use strict";
  let talking = null; // {btn, audio, raf, release, stopped}
  let ctx = null; // {api, apiCase, esc, state, $$}

  function stop() {
    if (!talking) return;
    const t = talking;
    talking = null;
    t.stopped = true;
    t.audio?.pause();
    t.release?.();
    cancelAnimationFrame(t.raf);
    ctx?.$$(".a-lead .w.say, .a-lead .w.said").forEach((w) => w.classList.remove("say", "said"));
    t.btn.classList.remove("on");
    t.btn.setAttribute("aria-pressed", "false");
    t.btn.querySelector("span").textContent = "Listen";
  }

  const b64ToBlob = (b64, mime) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  };
  // Proportional word timings when the provider sent none (Sarvam): the
  // same weighting as estimateTimings() in src/voice-providers.mjs.
  const estimate = (text, ms) => {
    const ws = text.trim().split(/\s+/).filter(Boolean);
    const wt = ws.map((w) => Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, "").length) + 1);
    const tot = wt.reduce((a, b) => a + b, 0) || 1;
    let at = 0;
    return wt.map((x) => [at, (at += (ms * x) / tot)]);
  };

  async function play(btn, c) {
    ctx = c;
    const { api, apiCase, state, $$ } = c;
    if (talking) {
      const same = talking.btn === btn;
      stop();
      if (same) return;
    }
    const r = state.current;
    if (!r?.lead?.text) return;
    const caseId = state.currentCase ?? state.case;
    const t = { btn, audio: null, stopped: false };
    talking = t;
    btn.classList.add("on");
    btn.setAttribute("aria-pressed", "true");
    btn.querySelector("span").textContent = "Stop";
    const words = $$(".a-lead .w");
    const get = (index) =>
      api("/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          case: apiCase(caseId),
          question: r.question,
          context: state.context[caseId] || undefined,
          semantic: caseId === "own" ? !!state.aiConsent : undefined,
          consent: caseId === "own" ? !!state.voiceConsent : undefined,
          index,
        }),
      });
    let offset = 0;
    let next = get(0);
    for (let i = 0; ; i++) {
      let part;
      try {
        part = await next;
      } catch (e) {
        if (t.stopped) return;
        stop();
        if (e.status === 403 && caseId === "own") return askConsent(btn);
        btn.querySelector("span").textContent = e.status === 429 ? "Voice limit today" : "Voice unavailable · retry";
        return;
      }
      if (t.stopped) return;
      const more = i + 1 < part.sentences.length;
      next = more ? get(i + 1) : null;
      next?.catch(() => {});
      const url = URL.createObjectURL(b64ToBlob(part.audio, part.mime));
      const audio = new Audio(url);
      t.audio = audio;
      btn.title = `Voice: ${part.provider}`;
      const n = part.text.split(/\s+/).filter(Boolean).length;
      const mine = words.slice(offset, offset + n);
      await new Promise((done) => {
        t.release = done;
        audio.onended = audio.onerror = done;
        audio.onloadedmetadata = () => {
          const times = part.words ?? estimate(part.text, audio.duration * 1000);
          const tick = () => {
            if (t.stopped) return;
            const ms = audio.currentTime * 1000;
            mine.forEach((w, k) => {
              const [a, b] = times[k] ?? [Infinity, Infinity];
              w.classList.toggle("say", ms >= a && ms < b + 40);
              w.classList.toggle("said", ms >= b + 40);
            });
            t.raf = requestAnimationFrame(tick);
          };
          tick();
        };
        audio.play().catch(done);
      });
      cancelAnimationFrame(t.raf);
      mine.forEach((w) => (w.classList.remove("say"), w.classList.add("said")));
      URL.revokeObjectURL(url);
      offset += n;
      if (t.stopped) return;
      if (!more) break;
    }
    stop();
  }

  // A visitor's own documents: the answer's text goes to the voice provider
  // only after they say yes, once per tab.
  function askConsent(btn) {
    const { esc, state } = ctx;
    const tools = btn.closest(".a-tools");
    if (!tools || tools.querySelector(".voice-consent")) return;
    const names = (state.voiceOut?.providers ?? []).map(
      (p) => ({ sarvam: "Sarvam AI", elevenlabs: "ElevenLabs" })[p] ?? p,
    );
    tools.insertAdjacentHTML(
      "beforeend",
      `<span class="voice-consent">Listening sends this answer's text to ${esc(names[0] ?? "the voice provider")} to be spoken. <button type="button" class="tool" data-voice-yes>Allow and listen</button></span>`,
    );
    tools.querySelector("[data-voice-yes]").addEventListener("click", () => {
      state.voiceConsent = true;
      tools.querySelector(".voice-consent")?.remove();
      play(btn, ctx);
    });
  }

  window.VMListen = { play, stop };
})();
