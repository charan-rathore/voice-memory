// Voice lab: measures a REAL Bolna call from the browser. It never starts,
// stops or speaks on the call. Three clocks, aligned to this browser:
//   - caller speech end: a local voice-activity detector on a second,
//     read-only microphone stream;
//   - turn received / first byte sent: the server's own timestamps
//     (/api/voice/turns), aligned by a round-trip-minimised clock offset;
//   - agent audio start: the SDK's remote "volume-level" crossing a threshold.
// The transcript scored is what Bolna's recogniser actually delivered.
import { clockOffset, scoreCall } from "/voicelab-score.mjs";

const SCRIPT = [
  "What fee did we finally agree on?",
  "Was it forty eight thousand before?",
  "Is the fifty fifty split agreed?",
  "Is there a signed contract?",
  "What's still open?",
];
const $ = (id) => document.getElementById(id);
const now = () => performance.timeOrigin + performance.now();

let run = null;

function render() {
  const list = $("voicelab-script");
  if (!list) return;
  list.replaceChildren(
    ...SCRIPT.map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }),
  );
}

async function startVad(r) {
  try {
    r.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    r.note =
      "Microphone timing unavailable (permission); stage times that need it stay empty.";
    return;
  }
  r.ctx = new AudioContext();
  const an = r.ctx.createAnalyser();
  an.fftSize = 1024;
  r.ctx.createMediaStreamSource(r.stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  let floor = 0.01;
  let speaking = false;
  let lastVoice = 0;
  // 20 ms frames; speech = RMS above an adaptive noise floor; end of speech
  // = 350 ms of silence (the recorded end is the LAST voiced frame).
  r.vadTimer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    if (!speaking) floor = floor * 0.95 + rms * 0.05;
    const voiced = rms > Math.max(0.02, floor * 3);
    const t = now();
    if (voiced) {
      speaking = true;
      lastVoice = t;
    } else if (speaking && t - lastVoice > 350) {
      speaking = false;
      r.speechEnds.push(lastVoice);
    }
  }, 20);
}

async function poll(r) {
  const t0 = now();
  try {
    const j = await fetch("/api/voice/turns", { cache: "no-store" }).then((x) =>
      x.json(),
    );
    const t1 = now();
    r.clockSamples.push({ t0, serverNow: j.serverNow, t1 });
    r.turns = (j.turns ?? []).filter(
      (t) => t.receivedAt >= r.startedServer - 5000,
    );
    status(
      `Measuring: ${r.turns.filter((t) => t.outcome === "answered").length} turn(s) so far.`,
    );
  } catch {
    /* next tick */
  }
}

function status(t) {
  const el = $("voicelab-status");
  if (el) el.textContent = t;
}

function finish(r) {
  clearInterval(r.vadTimer);
  clearInterval(r.pollTimer);
  r.stream?.getTracks().forEach((t) => t.stop());
  r.ctx?.close().catch(() => {});
  poll(r).then(() => {
    const answered = r.turns.filter((t) => t.outcome === "answered");
    const report = {
      kind: "voice-memory.voicelab/1",
      measuredAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      note: r.note ?? null,
      interruptions: r.turns.filter((t) => t.outcome !== "answered").length,
      raw: {
        script: SCRIPT,
        speechEnds: r.speechEnds,
        agentAudioStarts: r.agentStarts,
        turns: answered,
        clockSamples: r.clockSamples,
      },
      score: scoreCall({
        script: SCRIPT,
        speechEnds: r.speechEnds,
        agentAudioStarts: r.agentStarts,
        turns: answered,
        clock: clockOffset(r.clockSamples),
      }),
    };
    const s = report.score;
    status(
      answered.length
        ? `${answered.length} turn(s). Speech to answer: median ${s.speechToAnswerMs.p50 ?? "n/a"} ms (n=${s.speechToAnswerMs.n}). Mean WER ${s.meanWer ?? "n/a"}; ${s.turnsWithEntityErrors} turn(s) with a changed number, month or negation.`
        : "No answered turns were recorded in this call.",
    );
    const btn = $("voicelab-download");
    btn.hidden = !answered.length;
    btn.onclick = () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 1)], {
          type: "application/json",
        }),
      );
      a.download = `voicelab-${report.measuredAt.replace(/[:.]/g, "-")}.json`;
      a.click();
    };
  });
}

window.addEventListener("vm:call", (e) => {
  if (!$("voicelab-on")?.checked) return;
  const c = e.detail.call;
  const r = (run = {
    speechEnds: [],
    agentStarts: [],
    clockSamples: [],
    turns: [],
    startedServer: Date.now(),
  });
  let loud = false;
  c.on("volume-level", (level) => {
    if (run !== r) return;
    if (!loud && level > 0.04) {
      loud = true;
      r.agentStarts.push(now());
    } else if (loud && level < 0.015) loud = false;
  });
  c.on("call-start", () => {
    if (run !== r) return;
    startVad(r);
    r.pollTimer = setInterval(() => poll(r), 1000);
    status("Measuring this call.");
  });
  c.on("call-end", () => run === r && finish(r));
  c.on("error", () => run === r && finish(r));
});

render();
