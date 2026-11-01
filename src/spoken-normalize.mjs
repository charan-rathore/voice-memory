// Speech-to-text normalization for the voice path.
//
// Speech recognisers return what was said, not how documents write it:
// "forty two thousand", "ninety five hundred", "fifty fifty", "november
// third", "um so". The evidence engine matches the documents' own notation
// ("$42,000", "50/50", "3 November"), so a correct spoken question used to
// miss and abstain. This layer rewrites ONLY notation (numbers, ordinals,
// fillers, "go live"); it never adds a fact, a field or a value the caller did
// not say. The original utterance is kept for display.
const UNITS = {
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
};
const TENS = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const ORD = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
};
const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december";
const NUMWORD = new RegExp(
  `\\b(?:${[...Object.keys(UNITS), ...Object.keys(TENS), "hundred", "thousand", "lakh", "million", "and", "a"].join("|")})(?:[\\s-]+(?:${[...Object.keys(UNITS), ...Object.keys(TENS), "hundred", "thousand", "lakh", "million", "and"].join("|")}))*\\b`,
  "gi",
);

/** Parse a run of number words. Returns null when it is not a number. */
export function wordsToNumber(text) {
  const toks = text
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((t) => t && t !== "and");
  if (!toks.length || (toks.length === 1 && toks[0] === "a")) return null;
  let total = 0;
  let cur = 0;
  let seen = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === "a" && i === 0) {
      cur = 1;
      continue;
    }
    if (t in UNITS) {
      cur += UNITS[t];
      seen = true;
    } else if (t in TENS) {
      cur += TENS[t];
      seen = true;
    } else if (t === "hundred") {
      cur = (cur || 1) * 100;
      seen = true;
    } else if (t === "thousand") {
      total += (cur || 1) * 1000;
      cur = 0;
      seen = true;
    } else if (t === "lakh") {
      total += (cur || 1) * 100000;
      cur = 0;
      seen = true;
    } else if (t === "million") {
      total += (cur || 1) * 1000000;
      cur = 0;
      seen = true;
    } else return null;
  }
  return seen ? total + cur : null;
}

const group = (n) => n.toLocaleString("en-US");

/**
 * "ninety five hundred" is 9,500 in speech ("X hundred" with X >= 10), while
 * "nine hundred" is 900. wordsToNumber gets both right because cur*100 keeps
 * the tens: 95 * 100.
 */
export function normalizeSpoken(raw) {
  let s = String(raw ?? "");
  // Fillers and hesitation tokens that carry no meaning.
  s = s.replace(
    /\b(?:um+|uh+|erm+|hmm+|uh-huh|you know|i mean|like,)\s*/gi,
    "",
  );
  s = s.replace(/^\s*(?:so|okay|ok|right|and|but|well|hey)\b[,\s]+/i, "");
  // "go live" / "going live" / "golive" -> the documents' "go-live".
  s = s.replace(/\bgo(?:ing)?[\s-]?live\b/gi, (m) =>
    /going/i.test(m) ? "going live (go-live)" : "go-live",
  );
  // Ordinal dates: "november third" / "third of november" -> "3 November".
  s = s.replace(
    new RegExp(
      `\\b(${MONTHS})\\s+((?:twenty|thirty)[\\s-])?(${Object.keys(ORD).join("|")})\\b`,
      "gi",
    ),
    (_, mon, tens, ord) =>
      `${(tens ? TENS[tens.trim().toLowerCase()] : 0) + ORD[ord.toLowerCase()]} ${cap(mon)}`,
  );
  s = s.replace(
    new RegExp(
      `\\b(?:the\\s+)?((?:twenty|thirty)[\\s-])?(${Object.keys(ORD).join("|")})\\s+of\\s+(${MONTHS})\\b`,
      "gi",
    ),
    (_, tens, ord, mon) =>
      `${(tens ? TENS[tens.trim().toLowerCase()] : 0) + ORD[ord.toLowerCase()]} ${cap(mon)}`,
  );
  // "november 22" / "november 22nd" -> "22 November".
  s = s.replace(
    new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi"),
    (_, mon, d) => `${Number(d)} ${cap(mon)}`,
  );
  s = s.replace(
    /\b(\d{1,2})(?:st|nd|rd|th)\s+(?:of\s+)?([a-z]+)\b/gi,
    (m, d, mon) =>
      new RegExp(`^(${MONTHS})$`, "i").test(mon)
        ? `${Number(d)} ${cap(mon)}`
        : m,
  );
  // Recognisers drop "-ed" before a noun: "a sign contract" is "a signed
  // contract" (no other reading is grammatical).
  s = s.replace(
    /\bsign (contract|agreement|copy|deal|statement of work)\b/gi,
    "signed $1",
  );
  // Bare digit runs: "48000" -> "48,000" (years 19xx/20xx untouched; four
  // digits only next to a money word).
  s = s.replace(/(?<![\d,.$])\b(\d{4,7})\b(?![\d,.])/g, (m, n, off, str) => {
    const v = Number(n);
    if (n.length === 4) {
      if (/^(19|20)\d\d$/.test(n)) return m;
      const ctx = str.slice(Math.max(0, off - 30), off + 40);
      if (!/fee|retainer|price|cost|amount|budget|dollar|\$/i.test(ctx))
        return m;
    }
    return v.toLocaleString("en-US");
  });
  // Payment splits said as words: "fifty fifty", "forty sixty" (two tens
  // summing to 100) -> "50/50", "40/60".
  s = s.replace(
    /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty)[\s-]+(twenty|thirty|forty|fifty|sixty|seventy|eighty)\b/gi,
    (m, a, b) => {
      const x = TENS[a.toLowerCase()];
      const y = TENS[b.toLowerCase()];
      return x + y === 100 ? `${x}/${y}` : m;
    },
  );
  // Number words -> digits (money gets a $ when "dollars" follows).
  s = s.replace(NUMWORD, (m) =>
    segments(m)
      .map((seg) => {
        const n = wordsToNumber(seg);
        // Lone small words stay words: "which one", "two regions" already
        // match the documents; only real figures are rewritten.
        if (n === null || (n < 100 && !/[\s-]/.test(seg.trim()))) return seg;
        if (n < 100 && seg.trim().split(/[\s-]+/).length > 2) return seg;
        return n >= 1000 ? group(n) : String(n);
      })
      .join(" "),
  );
  s = s.replace(/\b([\d,]+)\s+dollars?\b/gi, (_, n) => `$${n}`);
  s = s.replace(/\b(\d{1,3}(?:,\d{3})+)\s+dollar\b/gi, (_, n) => `$${n}`);
  // Payment splits said as "fifty fifty" / "40 60" / "forty sixty".
  s = s.replace(
    /\b(\d{1,2})\s+(\d{1,2})\b(?=\s*(?:split|payment|schedule|\b))/gi,
    (m, a, b) => (Number(a) + Number(b) === 100 ? `${a}/${b}` : m),
  );
  // Bare thousands said without a currency word, next to a money noun.
  s = s.replace(/\b(\d{1,3},\d{3})\b(?!\s*\/)/g, (m, n, off, str) => {
    if (str[off - 1] === "$") return m;
    const ctx = str.slice(Math.max(0, off - 30), off + m.length + 30);
    return /fee|retainer|price|cost|rate|amount|revision|budget|approve|dollar|\$|thousand/i.test(
      ctx,
    )
      ? `$${n}`
      : m;
  });
  return s.replace(/\s{2,}/g, " ").trim();
}

// Split a run of number words into separately spoken numbers: "fifty fifty"
// is two numbers, "forty two" is one. A tens word after a tens/unit word, or a
// unit after a unit, starts a new number unless a multiplier joined them.
function segments(run) {
  const toks = run.trim().split(/[\s-]+/);
  const out = [];
  let cur = [];
  let last = null; // "unit" | "tens" | "mult"
  for (const t of toks) {
    const k = t.toLowerCase();
    const kind =
      k in UNITS
        ? "unit"
        : k in TENS
          ? "tens"
          : /^(hundred|thousand|lakh|million)$/.test(k)
            ? "mult"
            : "other";
    const breaks =
      (kind === "tens" && (last === "tens" || last === "unit")) ||
      (kind === "unit" && last === "unit");
    if (breaks && cur.length) {
      out.push(cur.join(" "));
      cur = [];
    }
    cur.push(t);
    if (kind !== "other") last = kind;
  }
  if (cur.length) out.push(cur.join(" "));
  return out;
}

const cap = (w) => w[0].toUpperCase() + w.slice(1).toLowerCase();
