// Voice lab scoring: shared by the browser (live measurement panel) and Node
// (evaluation/voice-lab-score.mjs). Pure functions, no I/O.
//
// What it measures from ONE real call:
//  - transcription: word error rate of what Bolna's recogniser delivered to
//    our endpoint vs the script line the caller read, and CRITICAL-ENTITY
//    errors (amounts, dates, percentages/splits, negations). A wrong "not" or
//    "forty"->"fourteen" is a meaning change; WER alone hides it.
//  - latency, split by stage, from three clocks aligned to the browser:
//      speech end (local VAD) -> turn received by our endpoint   = ASR + endpointing + network
//      turn received -> first byte sent                          = our engine
//      first byte -> agent audio audible in the browser           = LLM relay + TTS + network
//      speech end -> agent audio audible                          = what the caller feels
//
// Nothing here can make a call or invent a number: an unmeasured stage is null.

const NUMW = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

export function tokens(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[$€£₹]/g, " ")
    .replace(/(\d),(\d{3})/g, "$1$2")
    .replace(/[^\p{L}\p{N}\s/%-]/gu, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
}

/** Levenshtein over word tokens: substitutions + deletions + insertions / ref length. */
export function wer(ref, hyp) {
  const r = tokens(ref);
  const h = tokens(hyp);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++)
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[h.length] / r.length;
}

/** Collapse number words so "forty two thousand" and "42,000" compare equal. */
function numbersOf(s) {
  const out = [];
  const toks = tokens(s);
  let cur = null;
  let total = 0;
  const flush = () => {
    if (cur !== null || total) out.push(String(total + (cur ?? 0)));
    cur = null;
    total = 0;
  };
  for (const t of toks) {
    if (/^\d+(?:\.\d+)?$/.test(t)) {
      flush();
      out.push(String(Number(t)));
    } else if (t in NUMW) {
      cur = (cur ?? 0) + NUMW[t];
    } else if (t === "hundred" && cur !== null) {
      cur *= 100;
    } else if (t === "thousand" && (cur !== null || total)) {
      total += (cur ?? 1) * 1000;
      cur = null;
    } else flush();
  }
  flush();
  return out.filter((n) => n !== "0" || /\bzero\b|\b0\b/.test(s));
}

const NEG =
  /\b(not|no|never|isn't|wasn't|aren't|weren't|didn't|doesn't|don't|hasn't|haven't|nothing|none)\b/gi;
const MONTH =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi;

/** Meaning-bearing entities: numbers, months, negation count. */
export function criticalEntities(s) {
  return {
    numbers: numbersOf(s).sort(),
    months: (String(s).match(MONTH) ?? []).map((m) => m.toLowerCase()).sort(),
    negations: (String(s).match(NEG) ?? []).length,
  };
}

/** List of entity errors (empty = every critical entity survived). */
export function entityErrors(ref, hyp) {
  const a = criticalEntities(ref);
  const b = criticalEntities(hyp);
  const errs = [];
  const diff = (x, y, label) => {
    const left = [...y];
    for (const v of x) {
      const i = left.indexOf(v);
      if (i >= 0) left.splice(i, 1);
      else errs.push(`${label} "${v}" lost`);
    }
    for (const v of left) errs.push(`${label} "${v}" inserted`);
  };
  diff(a.numbers, b.numbers, "number");
  diff(a.months, b.months, "month");
  if (a.negations !== b.negations)
    errs.push(`negation count ${a.negations} -> ${b.negations}`);
  return errs;
}

export function percentile(xs, p) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/**
 * Align a server timestamp to the browser clock. Each poll gives
 * (t0 sent, serverNow, t1 received); offset = serverNow - (t0+t1)/2. Keep the
 * sample with the smallest round trip (least uncertainty), report its error.
 */
export function clockOffset(samples) {
  const best = [...samples].sort((a, b) => a.t1 - a.t0 - (b.t1 - b.t0))[0];
  if (!best) return null;
  return {
    offset: best.serverNow - (best.t0 + best.t1) / 2,
    errorMs: (best.t1 - best.t0) / 2,
  };
}

/**
 * Score one measured call.
 * @param {{script:string[], turns:Array<{transcript:string, receivedAt:number, firstByteAt:number|null}>,
 *          speechEnds:number[], agentAudioStarts:number[], clock:{offset:number,errorMs:number}|null}} call
 */
export function scoreCall(call) {
  const off = call.clock?.offset ?? null;
  const toLocal = (t) => (off === null || t == null ? null : t - off);
  const rows = call.turns.map((t, i) => {
    const received = toLocal(t.receivedAt);
    const firstByte = toLocal(t.firstByteAt);
    // The caller's speech end is the last local speech end before the
    // server received the turn; the agent audio is the first onset after
    // the first byte left the server.
    const speechEnd =
      received === null
        ? null
        : ([...call.speechEnds].filter((x) => x <= received).pop() ?? null);
    const audio =
      firstByte === null
        ? null
        : (call.agentAudioStarts.find((x) => x >= firstByte) ?? null);
    const ref = call.script?.[i] ?? null;
    return {
      i,
      script: ref,
      transcript: t.transcript,
      wer: ref ? +wer(ref, t.transcript).toFixed(3) : null,
      entityErrors: ref ? entityErrors(ref, t.transcript) : null,
      ms: {
        asrAndNetwork:
          speechEnd !== null && received !== null
            ? Math.round(received - speechEnd)
            : null,
        engine:
          received !== null && firstByte !== null
            ? Math.round(firstByte - received)
            : null,
        ttsAndNetwork:
          firstByte !== null && audio !== null
            ? Math.round(audio - firstByte)
            : null,
        speechToAnswer:
          speechEnd !== null && audio !== null
            ? Math.round(audio - speechEnd)
            : null,
      },
    };
  });
  const s2a = rows.map((r) => r.ms.speechToAnswer);
  const scored = rows.filter((r) => r.wer !== null);
  return {
    turns: rows.length,
    clockErrorMs: call.clock?.errorMs ?? null,
    speechToAnswerMs: {
      p50: percentile(s2a, 0.5),
      p95: percentile(s2a, 0.95),
      n: s2a.filter(Number.isFinite).length,
    },
    meanWer: scored.length
      ? +(scored.reduce((a, r) => a + r.wer, 0) / scored.length).toFixed(3)
      : null,
    turnsWithEntityErrors: scored.filter((r) => r.entityErrors.length).length,
    rows,
  };
}
