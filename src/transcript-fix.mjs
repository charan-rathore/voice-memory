// Transcript repair against the caller's own documents.
//
// A speech recogniser does not know the words that matter in a lab report:
// "creating in" for creatinine, "tea s h" for TSH, "h b a one c" for HbA1c,
// "s y n zero zero zero one" for SYN-0001. The same idea as a dictation
// app's custom dictionary (OpenWhispr feeds one to its speech model as
// hints): build the vocabulary from the indexed documents, then
//   - repairRecordTerms() fixes a finished transcript before it is answered
//     (Bolna's recogniser cannot take hints), and
//   - dictionaryOf() exports the same vocabulary, one term per line, for a
//     dictation app's custom dictionary, so the words arrive right.
//
// Rules: only names are repaired (tests, patient ids). A number the caller
// said is never changed. A phrase is only replaced when it is close to one
// vocabulary term and no ordinary word; every repair is reported, so the
// screen can show "heard ... understood as ...".
import { GLOSSARY } from "../clinical/explain.mjs";

const DIGIT = {
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
// Words a recogniser hears for a spoken letter.
const LETTER = {
  ay: "a",
  bee: "b",
  be: "b",
  see: "c",
  sea: "c",
  dee: "d",
  ee: "e",
  ef: "f",
  gee: "g",
  aitch: "h",
  eitch: "h",
  jay: "j",
  kay: "k",
  el: "l",
  em: "m",
  en: "n",
  pee: "p",
  cue: "q",
  queue: "q",
  ar: "r",
  are: "r",
  es: "s",
  ess: "s",
  tea: "t",
  tee: "t",
  you: "u",
  vee: "v",
  ex: "x",
  why: "y",
  wye: "y",
  zed: "z",
  zee: "z",
};
// Ordinary words never rewritten into a term, however close they sound.
const COMMON = new Set(
  (
    "a an and are as at be been being but by can could did do does doing " +
    "for from had has have he her his how i if in into is it its me more my " +
    "no not now of on or our out over she so some than that the their them " +
    "then there these they this to too up us very was we were what when " +
    "where which while who why will with would you your report reports result " +
    "results test tests value values level levels range normal high low " +
    "creating create created treating heating eating rating sitting " +
    "changed change since last first later earlier ask doctor"
  ).split(" "),
);

const key = (s) =>
  String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");

function distance(a, b) {
  if (a === b) return 0;
  const m = a.length,
    n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[n];
}

/**
 * Vocabulary of a bundle (or of clinical reports directly): test names as
 * printed, their canonical aliases, and patient ids.
 * @returns {{terms: {text:string, key:string}[], ids: {text:string, key:string}[]}}
 */
export function vocabularyOf(source) {
  const reports = Array.isArray(source)
    ? source
    : (source?.clinical?.reports ?? source?.clinical ?? []);
  const terms = new Map();
  const ids = new Map();
  const addTerm = (t) => {
    const k = key(t);
    if (k.length >= 3 && !terms.has(k)) terms.set(k, { text: t, key: k });
  };
  for (const r of Array.isArray(reports) ? reports : []) {
    const pid = r?.meta?.patient?.id;
    if (pid) ids.set(key(pid), { text: pid, key: key(pid) });
    for (const o of r?.observations ?? []) {
      addTerm(o.test);
      const g = GLOSSARY[o.canon ?? o.key];
      for (const a of g?.aliases ?? []) addTerm(a);
    }
  }
  return { terms: [...terms.values()], ids: [...ids.values()] };
}

/** One term per line, for a dictation app's custom dictionary. */
export function dictionaryOf(vocab) {
  return [...vocab.ids.map((x) => x.text), ...vocab.terms.map((x) => x.text)]
    .filter((t, i, all) => all.indexOf(t) === i)
    .join("\n");
}

/**
 * Repair names in a transcript using the documents' own vocabulary.
 * @returns {{text: string, fixes: {heard: string, as: string}[]}}
 */
export function repairRecordTerms(text, vocab) {
  const src = String(text ?? "");
  if (!src.trim() || !vocab || (!vocab.terms.length && !vocab.ids.length))
    return { text: src, fixes: [] };
  const tokens = [...src.matchAll(/[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ0-9]*|\d+/g)].map(
    (m) => ({
      t: m[0],
      lo: m[0].toLowerCase(),
      at: m.index,
      end: m.index + m[0].length,
    }),
  );
  const fixes = [];
  const edits = [];
  // A token as a spelled character: a letter word, a single letter, a digit.
  // A letter after an apostrophe is a possessive or contraction ("SYN-0001's"),
  // never a spelled character.
  const charOf = (tk) =>
    /['’]$/.test(src.slice(0, tk.at))
      ? null
      : (LETTER[tk.lo] ??
        DIGIT[tk.lo] ??
        (/^[a-z]$/i.test(tk.t) || /^\d+$/.test(tk.t) ? tk.lo : null));
  let i = 0;
  while (i < tokens.length) {
    // the "s" of a possessive or the "t" of a contraction is never a name
    if (/['’]$/.test(src.slice(0, tokens[i].at))) {
      i++;
      continue;
    }
    let done = false;
    // 1) Patient ids spoken letter by letter or with a word prefix:
    //    "s y n zero zero zero one", "syn double zero zero one".
    for (let n = Math.min(10, tokens.length - i); n >= 2 && !done; n--) {
      const win = tokens.slice(i, i + n);
      let joined = "";
      let ok = true;
      for (let k = 0; k < win.length; k++) {
        const tk = win[k];
        if (tk.lo === "double" && k + 1 < win.length) {
          const c = charOf(win[k + 1]);
          if (!c) {
            ok = false;
            break;
          }
          joined += c + c;
          k++;
          continue;
        }
        const c =
          charOf(tk) ?? (k === 0 && /^[a-z]{2,4}$/.test(tk.lo) ? tk.lo : null);
        if (!c) {
          ok = false;
          break;
        }
        joined += c;
      }
      if (!ok || !/\d/.test(joined)) continue;
      // An owner is an opaque identifier, not a fuzzy vocabulary term.
      // Decode spelling only when the complete letters and digits match.
      // Never turn an unknown or another exact owner into a nearby owner.
      const matches = vocab.ids.filter((x) => x.key === joined);
      const id = matches.length === 1 ? matches[0] : null;
      if (id) {
        if (src.slice(win[0].at, win.at(-1).end) !== id.text) {
          edits.push({ at: win[0].at, end: win.at(-1).end, to: id.text });
          fixes.push({
            heard: src.slice(win[0].at, win.at(-1).end),
            as: id.text,
          });
        }
        i += n;
        done = true;
      }
    }
    if (done) continue;
    // 2) Test names: one to three words, or a spelled acronym ("t s h").
    // Shortest window first, so a correct word is never swallowed into a
    // longer near-match ("has hemoglobin").
    for (let n = 1; n <= Math.min(5, tokens.length - i) && !done; n++) {
      const win = tokens.slice(i, i + n);
      if (n === 1 && /^\d+$/.test(win[0].t)) break; // never touch a number
      const spelled = n > 1 && win.every((tk) => charOf(tk) != null);
      const k = spelled
        ? win.map(charOf).join("")
        : key(win.map((tk) => tk.t).join(""));
      if (k.length < 3) continue;
      // already a term as written: keep it; a term split into words by
      // the recogniser ("hemo globin") is joined back
      const exact = !spelled && vocab.terms.find((x) => x.key === k);
      if (exact) {
        if (n > 1) {
          edits.push({ at: win[0].at, end: win.at(-1).end, to: exact.text });
          fixes.push({
            heard: src.slice(win[0].at, win.at(-1).end),
            as: exact.text,
          });
        }
        i += n;
        done = true;
        break;
      }
      if (n === 1 && COMMON.has(win[0].lo)) continue;
      // Phrases of ordinary words only match long terms ("creating in").
      const allCommon = !spelled && win.every((tk) => COMMON.has(tk.lo));
      // "has hemoglobin": an ordinary word at the edge of a phrase is its own
      // word, not part of a term.
      if (
        !spelled &&
        !allCommon &&
        n > 1 &&
        (COMMON.has(win[0].lo) || COMMON.has(win.at(-1).lo))
      )
        continue;
      let best = null;
      for (const term of vocab.terms) {
        if (allCommon && term.key.length < 8) continue;
        const allow = spelled
          ? 0
          : term.key.length >= 8
            ? 2
            : term.key.length >= 5
              ? 1
              : 0;
        if (Math.abs(term.key.length - k.length) > allow) continue;
        const d = distance(k, term.key);
        if (d <= allow && (!best || d < best.d)) best = { d, term };
      }
      if (best) {
        edits.push({ at: win[0].at, end: win.at(-1).end, to: best.term.text });
        fixes.push({
          heard: src.slice(win[0].at, win.at(-1).end),
          as: best.term.text,
        });
        i += n;
        done = true;
      }
    }
    if (!done) i++;
  }
  let out = src;
  for (const e of edits.sort((a, b) => b.at - a.at))
    out = out.slice(0, e.at) + e.to + out.slice(e.end);
  return { text: out, fixes };
}
