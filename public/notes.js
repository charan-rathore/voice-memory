// Conversational voice notes.
//
// Record several notes in a row; each is acknowledged at once (numbered card,
// soft chime, screen-reader announcement), sent immediately, and answered in
// parallel. Answers are SPOKEN in note order: a later answer that arrives
// first waits, and its card says so. Starting a new recording interrupts
// speech (barge-in) and the interrupted card offers a replay.
//
// Speech-to-text uses the browser's SpeechRecognition (Chrome/Edge); speech
// output uses speechSynthesis in the answer's language. Without either, notes
// still work as text and say so.
import { $, api } from "./app.js";
import { springIn, Spring, loop, prefersReducedMotion } from "./motion.js";
import { openSource } from "./viewer.js";

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;
const FOLLOW_UP =
  /^\s*(so|but|and|then|also|what about|toh|to|par|aur|lekin|फिर|तो|और|लेकिन)\b/i;

let seq = 0;
let nextToSpeak = 1;
let speaking = null; // note currently speaking
let lastField = null;
const notes = new Map(); // id -> note

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const langOf = (text) => (/[ऀ-ॿ]/.test(text) ? "hi-IN" : "en-IN");

// Soft two-tone acknowledgement (major third, 90 ms each, quiet).
let audio;
function chime() {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const [i, f] of [523.25, 659.25].entries()) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.09);
      g.gain.linearRampToValueAtTime(0.05, t + i * 0.09 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.16);
      o.connect(g).connect(audio.destination);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.18);
    }
  } catch {
    /* audio unavailable: visual + aria acknowledgement still happen */
  }
}

function setState(n, state, text) {
  n.state = state;
  n.card.dataset.state = state;
  n.stateEl.textContent = text;
}

function render(n) {
  const card = el("li", "note");
  card.dataset.state = "received";
  const head = el("div", "note-head");
  const badge = el("span", "note-n", String(n.id));
  badge.setAttribute("aria-hidden", "true");
  const tick = el("span", "note-tick");
  tick.setAttribute("aria-hidden", "true");
  const q = el("p", "note-q", n.text);
  head.append(badge, q, tick);
  const stateEl = el("p", "note-state");
  const body = el("div", "note-a");
  card.append(head, stateEl, body);
  $("notes").append(card);
  $("convo").hidden = false;
  n.card = card;
  n.stateEl = stateEl;
  n.body = body;
  springIn(card);
  // The acknowledgement tick pops with a slightly underdamped spring.
  if (!prefersReducedMotion()) {
    const s = new Spring({ frequency: 4, damping: 0.55, value: 0 }).set(1);
    const l = loop((dt) => {
      tick.style.transform = `scale(${s.step(dt).toFixed(3)})`;
      return !s.settled;
    });
    l.wake();
  }
  card.scrollIntoView({
    block: "nearest",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
}

export async function addNote(text, { spoken = true } = {}) {
  text = String(text ?? "").trim();
  if (!text) return null;
  const n = { id: ++seq, text, spoken, state: "received", answer: null };
  notes.set(n.id, n);
  render(n);
  chime();
  setState(n, "received", `Got it, note ${n.id}.`);
  $("note-live").textContent = `Note ${n.id} received.`;
  // Follow-ups carry the field of the latest answer; standalone notes don't.
  const context = FOLLOW_UP.test(text) && lastField ? lastField : null;
  setState(n, "thinking", "Finding it in your documents…");
  try {
    const r = await api("query", { question: text, context });
    n.answer = r;
    if (r.lead?.field) lastField = r.lead.field;
    const say =
      r.lead?.text ??
      (r.refused
        ? "I don't see that in these documents."
        : "I found the closest passages; they're on screen.");
    n.say = say;
    const p = el("p", "note-text", say);
    n.body.replaceChildren(p);
    const cite = r.lead?.citations?.[0] ?? r.evidence?.[0];
    if (cite?.documentId) {
      const b = el("button", "link note-src", "Show the source");
      b.type = "button";
      b.onclick = () =>
        openSource({
          documentId: cite.documentId,
          title: cite.title,
          evidence: cite,
        });
      n.body.append(b);
    }
    document.dispatchEvent(
      new CustomEvent("vm:answer", { detail: { question: text, result: r } }),
    );
    setState(
      n,
      "ready",
      n.id === nextToSpeak
        ? "Answer ready."
        : `Answer ready; it will play after note ${nextToSpeak}.`,
    );
  } catch (e) {
    n.say = null;
    setState(n, "failed", `Couldn't answer this one: ${e.message}`);
  }
  pump();
  return n;
}

function speak(n) {
  return new Promise((resolve) => {
    const voices = synth?.getVoices?.() ?? [];
    const lang = langOf(n.say);
    const voice =
      voices.find((v) => v.lang === lang) ??
      voices.find((v) => v.lang?.startsWith(lang.slice(0, 2)));
    if (!synth || !n.spoken || !voice) {
      setState(
        n,
        "done",
        !synth || !voices.length
          ? "Shown as text (no voice available in this browser)."
          : lang.startsWith("hi")
            ? "Shown as text (no Hindi voice on this device)."
            : "Shown as text.",
      );
      resolve();
      return;
    }
    const u = new SpeechSynthesisUtterance(n.say);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 1;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speaking = n;
    setState(n, "speaking", "Speaking…");
    synth.speak(u);
  });
}

async function pump() {
  if (speaking) return;
  for (;;) {
    const n = notes.get(nextToSpeak);
    if (!n || n.state === "received" || n.state === "thinking") return; // wait in order
    if (n.state === "failed" || !n.say) {
      nextToSpeak++;
      continue;
    }
    // Later answers that are already ready show they are queued.
    for (const m of notes.values())
      if (m.id > n.id && m.state === "ready")
        m.stateEl.textContent = `Answer ready; it will play after note ${n.id}.`;
    await speak(n);
    // Barge-in already advanced the queue and restarted it; this loop is stale.
    if (n.state === "interrupted") return;
    if (n.state === "speaking") setState(n, "done", "Spoken.");
    speaking = null;
    nextToSpeak++;
  }
}

let replaying = null;
function interrupt() {
  if (!speaking) return;
  const n = speaking;
  if (n === replaying) {
    // A replay is not part of the queue: just stop it.
    synth?.cancel();
    speaking = replaying = null;
    setState(n, "done", "Stopped.");
    return;
  }
  synth?.cancel();
  speaking = null;
  setState(n, "interrupted", "Stopped so you could talk.");
  const b = el("button", "link", "Play it again");
  b.type = "button";
  b.onclick = () => {
    b.remove();
    interrupt();
    replaying = n;
    speak(n).then(() => {
      if (n.state === "speaking") setState(n, "done", "Spoken.");
      if (speaking === n) speaking = null;
      replaying = null;
      pump();
    });
  };
  n.body.append(b);
  nextToSpeak = n.id + 1;
  queueMicrotask(pump);
}

// ---------------------------------------------------------------- recording
let rec = null;
function startRecording() {
  interrupt();
  if (!SR) return;
  rec = new SR();
  rec.lang = $("note-lang").value;
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    $("note-interim").textContent = interim || finalText;
  };
  rec.onerror = (e) => {
    $("note-interim").textContent =
      e.error === "not-allowed"
        ? "Microphone blocked. Allow it in the address bar to record notes."
        : "";
  };
  rec.onend = () => {
    $("note-rec").dataset.recording = "false";
    $("note-rec").setAttribute("aria-pressed", "false");
    $("note-interim").textContent = "";
    rec = null;
    if (finalText.trim()) addNote(finalText);
  };
  $("note-rec").dataset.recording = "true";
  $("note-rec").setAttribute("aria-pressed", "true");
  $("note-interim").textContent = "Listening…";
  rec.start();
}

$("note-rec").onclick = () => {
  if (rec) rec.stop();
  else startRecording();
};
if (!SR) {
  $("note-rec").disabled = true;
  $("note-rec").title =
    "Voice notes need Chrome or Edge. You can still type questions.";
}
$("note-lang").value = (navigator.language || "en-IN")
  .toLowerCase()
  .startsWith("hi")
  ? "hi-IN"
  : "en-IN";
// Prime the voice list (Chrome loads it asynchronously).
synth?.getVoices?.();

// Typed notes go through the same queue (used by tests and keyboard users).
window.vmNotes = {
  add: (text, opts) => addNote(text, opts),
  size: () => notes.size,
};
document.addEventListener("vm:reset", () => {
  notes.clear();
  seq = 0;
  nextToSpeak = 1;
  lastField = null;
  synth?.cancel();
  $("notes").replaceChildren();
  $("convo").hidden = true;
});
