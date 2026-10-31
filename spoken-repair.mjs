// Repairs what a phone-grade recogniser does to lab questions before the
// deterministic engine sees them, so callers don't have to phrase things
// exactly. Seen on real Bolna calls (Deepgram nova-3):
//   "syn zero zero one sparitine result"      -> "SYN-0001 ferritin result"
//   "same zero zero one's fareitine"          -> "SYN-0001's ferritin"
//   "can you tell me the what is the s y n" + "zero zero zero one"
// It only rewrites patient IDs and lab-test names that the loaded reports
// actually contain; everything else is left for the engine to judge.

const VOWELS = /[aeiouyhw]/g;
const skeleton = (w) =>
  w
    .toLowerCase()
    .replace(/ph/g, "f")
    .replace(/[^a-z]/g, "")
    .replace(/^(.)(.*)$/, (m, a, rest) => a + rest.replace(VOWELS, ""))
    .replace(/[aeiouyhw]/g, "")
    .replace(/(.)\1+/g, "$1");

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length][b.length];
}

// Ordinary words whose consonant skeleton sits next to a test name.
const NOT_TESTS = new Set(
  "certain curtain protein written britain pretend partner fortune frighten portion parting printing pertain fattening threatening creating created reading heading ferry forty fourteen thirty thirteen finalized finalised thousand fortnight".split(
    " ",
  ),
);

/** Test names (and aliases) present in the loaded reports. */
export function labVocabulary(reports, aliasesFor = () => []) {
  const names = new Map();
  for (const r of reports ?? [])
    for (const o of r.observations ?? []) {
      names.set(o.test.toLowerCase(), o.test);
      for (const a of aliasesFor(o.key) ?? [])
        if (/^[a-z][a-z0-9 ]{3,}$/i.test(a)) names.set(a.toLowerCase(), o.test);
    }
  return names;
}

const NUM = {
  zero: "0",
  oh: "0",
  o: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/** Patient ids as spoken: "s y n zero zero zero one", "sin 001", "zero zero one". */
export function repairPatientIds(text, ids = []) {
  if (!ids.length) return text;
  const wanted = new Set(ids.map((x) => x.toUpperCase()));
  const toId = (digits) => {
    const n = digits.replace(/\D/g, "").replace(/^0+/, "");
    if (!n) return null;
    const id = "SYN-" + n.padStart(4, "0");
    return wanted.has(id) ? id : null;
  };
  const digitWords =
    "(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine|\\d)";
  const spoken = (s) =>
    s
      .split(/[\s-]+/)
      .map((w) => NUM[w.toLowerCase()] ?? w)
      .join("");
  let out = text.replace(
    new RegExp(
      `\\b(?:s\\s*y\\s*n|syn|sin|sign|sync|same|seen|scene|cin|s\\.y\\.n\\.?)(?:\\s*-\\s*|\\s+)((?:${digitWords}[\\s-]*){1,4})`,
      "gi",
    ),
    (m, digits) => {
      const id = toId(spoken(digits));
      return id ? id + " " : m;
    },
  );
  // A bare "zero zero zero one" / "0001" right after a patient-shaped ask.
  out = out.replace(
    new RegExp(
      `\\b((?:zero|oh)[\\s-]+(?:(?:zero|oh)[\\s-]+){0,2}(?:one|three))\\b`,
      "gi",
    ),
    (m, digits) => toId(spoken(digits)) ?? m,
  );
  out = out.replace(/\b0{2,3}([1-9])\b/g, (m, d) => toId(d) ?? m);
  return out.replace(/\s{2,}/g, " ").trim();
}

/** Misheard test names: "sparitine", "fareitine" -> "ferritin". */
export function repairTestNames(text, vocab) {
  if (!vocab?.size) return text;
  const entries = [...vocab.entries()]
    .filter(([n]) => !n.includes(" "))
    .map(([n, canon]) => ({ n, canon, sk: skeleton(n) }));
  return text.replace(/[A-Za-z][A-Za-z']{4,}/g, (w) => {
    const base = w.toLowerCase().replace(/'s$/, "");
    if (NOT_TESTS.has(base) || vocab.has(base)) return w;
    const sk = skeleton(base);
    if (sk.length < 4) return w;
    let best = null;
    for (const e of entries) {
      if (e.sk.length < 4) continue;
      const d = lev(sk, e.sk);
      const tol = sk.length >= 5 && e.sk.length >= 4 ? 2 : 1;
      if (d > tol) continue;
      const raw = lev(base, e.n);
      if (!best || d < best.d || (d === best.d && raw < best.raw))
        best = { d, raw, canon: e.canon };
    }
    return best ? best.canon + (/'s$/i.test(w) ? "'s" : "") : w;
  });
}

const FILLER =
  /\b(hey|hi|hello|ok(ay)?|so|um+|uh+|actually|please|can you|could you|tell me|i wanted to ask|i want to know|what exactly)\b/gi;

/** True when an utterance is a fragment the recogniser cut off mid-question. */
export function isFragment(text) {
  const words =
    String(text)
      .replace(FILLER, " ")
      .toLowerCase()
      .match(/[a-z0-9$]+/g) ?? [];
  const content = words.filter(
    (w) =>
      !/^(the|a|an|is|was|of|about|it|me|what|more|for|to|my|on|in|and|or|that|this|its)$/.test(
        w,
      ),
  );
  return (
    content.length <= 1 ||
    /\b(the|a|an|of|about|is|for|what is)\s*$/i.test(String(text).trim())
  );
}

/**
 * The question to answer for this turn: the repaired latest utterance, and —
 * when that is a fragment or has lost its subject — the caller's own recent
 * utterances joined to it (never another caller's: only this request's
 * message history is used).
 */
export function voiceQuestions(messages, { reports, ids, aliasesFor, text }) {
  const vocab = labVocabulary(reports, aliasesFor);
  const fix = (s) => repairTestNames(repairPatientIds(s, ids), vocab);
  const users = [];
  for (let i = messages.length - 1; i >= 0 && users.length < 4; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      const t = text(m.content).trim();
      if (t) users.unshift(t);
    }
  }
  const current = users.at(-1) ?? "";
  const out = [fix(current)];
  if (users.length > 1) {
    out.push(fix(users.slice(-2).join(" ")));
    if (users.length > 2) out.push(fix(users.slice(-3).join(" ")));
  }
  return [...new Set(out)];
}

export const FRAGMENT_REPLY =
  "Sorry, I only caught part of that. You can ask, for example: what is S Y N zero zero zero one's ferritin result, has creatinine gone up, or was the forty two thousand dollar revision finalized?";
