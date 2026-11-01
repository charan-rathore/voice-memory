// Dictation for the ask bar: press, speak naturally, release.
//
// What makes capture feel right (the Wispr Flow / Granola lesson): you see
// your words while you speak, you never lose a take, the transcript is
// cleaned the way you meant it ("ferritin, no sorry, creatinine" ->
// "creatinine"), and the recogniser knows the words on screen (test names,
// patient IDs) so it spells them right.
//
//   live words      the browser's speech recognition, interim results shown as you talk
//   the clean take  every clip is also recorded; when the server offers it (and you
//                   agreed), Gemini transcribes the clip with this case's vocabulary,
//                   in English, Hindi or Hinglish as spoken
//   cleanup         fillers dropped, self-corrections applied, IDs normalised
//   end of turn     press again, Enter, or ~1.4 s of silence after speech; 45 s cap
//
// Never always-on: the microphone opens on a press, shows that it is on, and
// is released the moment the take ends. Escape discards the take.
(() => {
  "use strict";
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const CONSENT_KEY = "vm_dictation_consent_v1";

  // ------------------------------------------------------------ cleanup
  const FILLERS = /\b(um+|uh+|erm+|hmm+|uhh+|umm+|you know|i mean,?\s*like|haan+ ?toh|matlab|basically)\b[,.]?\s*/gi;
  // "X, no I mean Y" / "X sorry Y" / "X nahi nahi Y": keep what came after
  const CORRECTION =
    /^(.*?)(?:,?\s*\b(?:no+,?\s*(?:wait,?\s*)?i mean|no+,?\s*sorry|sorry,?\s*i mean|i mean|actually,?\s*no|scratch that|nahi nahi|nahin nahin|matlab nahi|मतलब नहीं|नहीं नहीं)\b,?\s*)(.+)$/i;
  function clean(raw) {
    let t = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    // spoken IDs: "syn zero zero zero one" / "s y n 0001" -> SYN-0001
    t = t.replace(/\b(?:s\s*y\s*n|sin|syn|sin)\s*[- ]?\s*((?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|\d)\s*){3,4})\b/gi, (m, d) => {
      const map = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
      const digits = d.trim().split(/\s+/).map((x) => (x in map ? map[x.toLowerCase()] : x)).join("");
      return /^\d{3,4}$/.test(digits) ? `SYN-${digits.padStart(4, "0")} ` : m;
    });
    t = t.replace(/\s+/g, " ").trim();
    // Apply the last self-correction: the replacement takes the place of the
    // same kind of phrase it corrects (a test name, a number, an ID).
    for (let i = 0; i < 3; i++) {
      const m = CORRECTION.exec(t);
      if (!m) break;
      const [, before, after] = m;
      const aw = after.split(" ");
      const bw = before.replace(/[,.]$/, "").split(" ").filter(Boolean);
      // short correction ("the ferritin, no I mean creatinine result"): the
      // first corrected word replaces the last word said before it
      // A correction that restates a kind of thing already said (an ID, a
      // number, the same word) replaces it from there on.
      const kind = (w) =>
        /^syn[- ]?\d/i.test(w) ? "id" : /^\$?\d/.test(w) ? "num" : w.toLowerCase();
      const j = bw.map(kind).lastIndexOf(kind(aw[0]));
      if (j >= 0 && kind(aw[0]) !== aw[0].toLowerCase()) t = [...bw.slice(0, j), ...aw].join(" ");
      else if (aw.length <= 3 && bw.length > 1) {
        bw.splice(bw.length - 1, 1, ...aw);
        t = bw.join(" ");
      } else t = after;
    }
    t = t.replace(FILLERS, "");
    // stutters: "the the", "what what"
    t = t.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");
    t = t.replace(/\s+([?.!,])/g, "$1").trim();
    if (
      t &&
      !/[?.!।]$/.test(t) &&
      (/^(what|why|how|is|are|did|does|do|has|have|was|were|when|which|who|can)\b/i.test(t) ||
        /\b(kya|kyun|kyu|kitna|kitni|kab|kaun|kaise)\b|क्या|क्यों|कितना|कितनी/i.test(t))
    )
      t += "?";
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // ------------------------------------------------------------ mic choice
  async function pickMic() {
    try {
      const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
      const virtual = /blackhole|virtual|loopback|soundflower|teams|zoom|obs|aggregate|vb-audio|cable/i;
      const real = mics.filter((d) => !virtual.test(d.label));
      return (
        real.find((d) => d.deviceId === "default") ??
        real.find((d) => /built-in|internal|microphone|mic/i.test(d.label)) ??
        real[0] ??
        null
      );
    } catch {
      return null;
    }
  }

  /**
   * @param {object} o
   * @param {HTMLInputElement} o.input
   * @param {HTMLButtonElement} o.button
   * @param {HTMLElement} o.status
   * @param {(text:string)=>void} o.onText final, cleaned transcript
   * @param {()=>string} o.lang "en" | "hi" | "hinglish"
   * @param {()=>string} o.caseId
   * @param {()=>boolean} o.serverTranscribe does the server offer transcription?
   */
  function init(o) {
    if (!SR && !canRecord) {
      o.button.hidden = true;
      return null;
    }
    let take = null;
    const say = (html, cls = "") => {
      o.status.className = `dict-status ${cls}`;
      o.status.innerHTML = html;
    };
    const setState = (s) => {
      o.button.dataset.state = s;
      o.button.setAttribute("aria-pressed", String(s === "listening"));
      o.button.setAttribute(
        "aria-label",
        s === "listening" ? "Stop dictating" : s === "working" ? "Transcribing" : "Dictate your question",
      );
      document.documentElement.classList.toggle("dictating", s === "listening");
    };
    setState("idle");

    function consent() {
      try {
        if (localStorage.getItem(CONSENT_KEY) === "yes") return Promise.resolve(true);
      } catch {}
      return new Promise((resolve) => {
        const d = document.createElement("div");
        d.className = "dict-consent";
        d.setAttribute("role", "dialog");
        d.setAttribute("aria-label", "Use your microphone");
        d.innerHTML = `<p><b>Dictate with your microphone?</b> The mic is on only while the button is red. Your words are turned into text by your browser's speech service${o.serverTranscribe() ? " and, for accuracy, the clip is sent to Google Gemini through Voice Memory's server" : ""}. Clips are not stored. Please don't dictate real medical or personal details in this demo.</p><div><button type="button" data-yes>Use the microphone</button><button type="button" data-no>Not now</button></div>`;
        o.button.closest("form").after(d);
        const done = (v) => {
          d.remove();
          if (v)
            try {
              localStorage.setItem(CONSENT_KEY, "yes");
            } catch {}
          resolve(v);
        };
        d.querySelector("[data-yes]").addEventListener("click", () => done(true));
        d.querySelector("[data-no]").addEventListener("click", () => done(false));
        d.querySelector("[data-yes]").focus();
      });
    }

    async function start() {
      if (!(await consent())) return;
      const lang = o.lang();
      const t = {
        lang,
        finalText: "",
        interim: "",
        chunks: [],
        startedAt: performance.now(),
        lastVoice: 0,
        heard: false,
        cancelled: false,
      };
      take = t;
      setState("listening");
      say(`<i class="dict-dot"></i>Listening… speak naturally. Press again or pause to finish.`, "on");
      o.input.value = "";
      o.input.placeholder = "Listening…";
      try {
        const mic = await pickMic();
        t.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(mic ? { deviceId: { ideal: mic.deviceId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
      } catch {
        setState("idle");
        say("Microphone blocked. Allow it in the address bar, or type your question.", "err");
        o.input.placeholder = "Type your question";
        take = null;
        return;
      }
      if (take !== t) return t.stream.getTracks().forEach((x) => x.stop());

      // Level meter + end-of-turn detection on the same stream.
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        const src = ac.createMediaStreamSource(t.stream);
        const an = ac.createAnalyser();
        an.fftSize = 1024;
        src.connect(an);
        const buf = new Float32Array(an.fftSize);
        t.ac = ac;
        let noise = 0.008;
        const loop = () => {
          if (take !== t || t.stopping) return;
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          const rms = Math.sqrt(sum / buf.length);
          const now = performance.now();
          // adaptive floor: what the room sounds like before you speak
          if (!t.heard) noise = noise * 0.95 + rms * 0.05;
          const voiced = rms > Math.max(0.015, noise * 2.6);
          if (voiced) {
            t.lastVoice = now;
            t.heard = true;
          }
          o.button.style.setProperty("--lvl", Math.min(1, rms * 9).toFixed(3));
          if (t.heard && now - t.lastVoice > 1400 && now - t.startedAt > 1200) return stop();
          if (now - t.startedAt > 45000) return stop();
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      } catch {
        /* meter is a nicety; recognition still works */
      }

      if (canRecord) {
        const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"].find(
          (m) => MediaRecorder.isTypeSupported?.(m),
        );
        try {
          t.rec = new MediaRecorder(t.stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : {});
          t.rec.ondataavailable = (e) => e.data.size && t.chunks.push(e.data);
          t.rec.start(250);
        } catch {
          t.rec = null;
        }
      }
      if (SR) {
        const r = new SR();
        r.lang = lang === "hi" ? "hi-IN" : "en-IN";
        r.continuous = true;
        r.interimResults = true;
        r.maxAlternatives = 1;
        r.onresult = (e) => {
          let fin = "",
            mid = "";
          for (let i = 0; i < e.results.length; i++) {
            const x = e.results[i];
            if (x.isFinal) fin += x[0].transcript + " ";
            else mid += x[0].transcript + " ";
          }
          t.finalText = fin;
          t.interim = mid;
          t.heard = true;
          t.lastVoice = performance.now();
          o.input.value = (fin + mid).replace(/\s+/g, " ").trim();
        };
        r.onerror = (e) => {
          if (e.error === "not-allowed" || e.error === "service-not-allowed") t.srBlocked = true;
        };
        r.onend = () => {
          if (take === t && !t.stopping) {
            // Chrome ends recognition on its own after a pause; keep listening
            // until the take ends.
            try {
              r.start();
            } catch {}
          }
        };
        try {
          r.start();
          t.sr = r;
        } catch {
          t.sr = null;
        }
      }
    }

    function release(t) {
      try {
        t.sr?.stop();
      } catch {}
      try {
        if (t.rec?.state === "recording") t.rec.stop();
      } catch {}
      t.stream?.getTracks().forEach((x) => x.stop());
      t.ac?.close?.().catch(() => {});
      o.button.style.removeProperty("--lvl");
    }

    async function stop({ cancel = false } = {}) {
      const t = take;
      if (!t || t.stopping) return;
      t.stopping = true;
      const recDone = t.rec
        ? new Promise((r) => {
            t.rec.onstop = r;
            setTimeout(r, 800);
          })
        : Promise.resolve();
      release(t);
      if (cancel) {
        take = null;
        setState("idle");
        o.input.value = "";
        o.input.placeholder = "Type your question";
        say("Discarded.", "");
        return;
      }
      setState("working");
      const browserText = (t.finalText + " " + t.interim).trim();
      let text = browserText;
      let via = "browser";
      await recDone;
      const blob = t.chunks.length ? new Blob(t.chunks, { type: t.rec?.mimeType || "audio/webm" }) : null;
      if (blob && blob.size > 1500 && o.serverTranscribe()) {
        say(`<i class="dict-dot"></i>Polishing the transcript…`, "on");
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 14000);
          const r = await fetch("/api/public/transcribe", {
            method: "POST",
            headers: {
              "content-type": blob.type.split(";")[0] || "audio/webm",
              "x-vm-consent": "audio",
              "x-vm-lang": t.lang,
              "x-vm-case": o.caseId(),
            },
            body: blob,
            signal: ctl.signal,
          });
          clearTimeout(timer);
          const b = await r.json().catch(() => ({}));
          if (r.ok && typeof b.text === "string" && b.text.trim()) {
            text = b.text;
            via = "server";
          }
        } catch {
          /* keep the browser's take */
        }
      }
      take = null;
      setState("idle");
      o.input.placeholder = "Type your question";
      const out = clean(text);
      if (!out) {
        say(
          t.srBlocked && !o.serverTranscribe()
            ? "This browser's speech recognition is blocked. Type your question instead."
            : "I didn't catch anything. Try again, a little closer to the mic.",
          "err",
        );
        o.input.value = "";
        return;
      }
      o.input.value = out;
      say(via === "server" ? "Transcribed. Asking…" : "Asking…", "");
      o.onText(out, { via });
      setTimeout(() => say("", ""), 2500);
    }

    o.button.addEventListener("click", (e) => {
      e.preventDefault();
      if (take) stop();
      else start();
    });
    document.addEventListener("keydown", (e) => {
      if (!take) return;
      if (e.key === "Escape") {
        e.preventDefault();
        stop({ cancel: true });
      } else if (e.key === "Enter") {
        e.preventDefault();
        stop();
      }
    });
    return { start, stop, clean };
  }

  window.VMDictate = { init, clean };
})();
