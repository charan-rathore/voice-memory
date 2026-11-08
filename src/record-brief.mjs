// Questions about a whole set of records, not one value in them.
//
// record-facts.mjs answers "what does the most authoritative record say
// about X". People also ask across records:
//   - "summarise everything"            -> the encounter, start to finish
//   - "which of these are drafts?"      -> each record with its status
//   - "what happened on 23 October?"    -> every dated event on that day
//   - "what medicines is she on?"       -> every medication line, ranked
//   - "was she charged twice?"          -> repeated line items on the bill
//   - "why was she admitted?"           -> the reason printed at intake
//   - "does she have a thyroid problem?" -> the signed diagnosis status
// Every sentence is built from a table fact or a printed sentence, each with
// its exact span, and the most authoritative record speaks first. Records
// about a different person (a namesake on a misfiled page) are named and
// left out. Text inside a record that tries to instruct an automated reader
// ("ignore newer amendments ...") is reported as a finding, never followed.

const RANK = { authoritative: 2, unknown: 1, provisional: 0 };
const MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
const ID_RE = /\b([A-Z]{2,5}-[A-Z]?\d{3,6})\b/;
// A line written to steer an automated reader rather than to record a fact.
export const INJECTION_RE =
  /\b(ignore|disregard|forget|override)\b[^.]{0,80}\b(amend\w*|newer|previous|prior|above|instructions?|corrections?|records?)\b|\bfor the (automated|ai) (summary|reader|assistant)\b|\b(as an ai|system prompt)\b/i;

const INTENTS = {
  summary:
    /\b(summari[sz]\w*|(?<!discharge )summary(?! (said|says|say))|overview|brief me|whole story|everything|what happened (to|with) (her|him|them|me)|walk me through|explain (the|these|this|her|his) (records?|reports?|file|documents?|stay))\b/i,
  status:
    /\b(drafts?|unsigned|not final|preliminary|provisional|which (of these )?(records|documents|reports|pages|files)|what (records|documents|is in (this|the) file)|list (the |all )?(records|documents)|authoritative|can i trust)\b/i,
  medication:
    /\b(medicines?|medications?|meds|drugs?|tablets?|pills?|prescri\w*|supplements?|on any|taking)\b/i,
  duplicate:
    /\b(twice|double|duplicate\w*|two times|charged again|same (charge|code|item)|overcharg\w*|billed two)\b/i,
  reason:
    /\b(why (was|did|is) (she|he|they|i|the patient)\b.*\b(admit\w*|come|came|hospital|in)|reason for|what brought|came in (for|with)|admitted for|symptoms?|complaint)\b/i,
  diagnosis:
    /\b(diagnos\w*|disorder|disease|condition|does (she|he|they|it) have|do i have|is (she|he) (sick|ill)|what('s| is) wrong with)\b|^\s*(is|does|has|kya)\b.*\b(anae?mi[ac]|diabet(es|ic)|hypo\w*thyroid\w*|hyper\w*thyroid\w*|bimari|beemari)\b/i,
  stay: /\bhow long\b.*\b(hospital|stay|admitted|there|in)\b|\blength of (the )?stay\b|\bhow many (days|nights)\b/i,
  billChange:
    /\b(bill|charges?|estimate|total|amount)\b.*\b(go|went|gone|changed?|differ\w*|drop\w*|reduc\w*|lower|less|more|higher)\b|\bwhy\b.*\b\d[\d,]{2,}\b.*\b(to|vs|and)\b.*\b\d[\d,]{2,}\b/i,
  mistakes:
    /\b(mistakes?|errors?|wrong (in|on|with) (the|these|this) (report|records?|bill)|went wrong|corrections?|got (anything|something) wrong|any (fixes|changes) (to|in) the records?)\b/i,
  recordAbout:
    /\bwhat (did|does|do) (the |that |this )?([a-z' -]{3,40}?) (say|said|state|mention|write|wrote|note|show)s? about ([^?]{2,60})/i,
  page: /\b(page|p\.)\s*(\d{1,3})\b/i,
  clinician:
    /\b(which|what|who('s| is| was)?)\s+(doctor|physician|consultant|specialist)\b|\bwho (is|was) (dr\.?|doctor)\s|\bwho (treated|looked after|saw|attended)\b|\bher doctor's name\b|\bdoctor'?s name\b/i,
  followUp:
    /\b(see|visit|meet) (the|a|her|his) doctor again\b|\bnext (visit|review|check|appointment)\b|\bfollow-?up\b|\bcome back\b|\bwhen (should|does|do) (she|he|they|i) (go|come) back\b/i,
  unit: /\b(icu|intensive care|ward|which unit|where was (she|he|they) (admitted|kept|treated))\b/i,
  lineItem: /\b(how much|cost|charged? for|price|amount for)\b/i,
  identity:
    /\b(patient id|patient number|id number|mrn|hospital number|date of birth|dob|birthday|how old|encounter (number|id)|accession|file (number|reference))\b/i,
};

const lower = (s) => s.toLowerCase().replace(/^./, (c) => c.toUpperCase());
const titleOf = (r) =>
  r.title && !/hospita\b|general hospital/i.test(r.title)
    ? lower(r.title)
    : `the record on page ${r.pages?.[0] ?? "?"}`;
const pageOf = (r) => (r.pages?.length ? `p.${r.pages.join("–")}` : null);

/** Sentences of a record's text with their offsets in the source text. */
function sentencesOf(text, start, end) {
  const out = [];
  const body = text.slice(start, end);
  const re = /[^\n.!?]+(?:[.!?]+|$)/g;
  let m;
  while ((m = re.exec(body))) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const s = raw.trim();
    if (s.length < 25 || s.startsWith("|")) continue;
    out.push({
      text: s,
      start: start + m.index + lead,
      end: start + m.index + lead + s.length,
    });
  }
  return out;
}

/** The person the records are about, and the namesake records to set aside. */
function people(entries) {
  const count = new Map();
  for (const e of entries)
    for (const r of e.records)
      if (r.patient) count.set(r.patient, (count.get(r.patient) ?? 0) + 1);
  const ranked = [...count].sort((a, b) => b[1] - a[1]);
  const main = ranked[0]?.[0] ?? null;
  return { main, others: ranked.slice(1).map(([id]) => id) };
}

/** A record's patient, from its header or a "PATIENT: name / ID" fact. */
function patientOf(r) {
  if (r.patient) return r.patient;
  const f = r.facts.find(
    (x) => /^patient\b/i.test(x.label) && ID_RE.test(x.value),
  );
  return f ? ID_RE.exec(f.value)[1] : null;
}

function flatten(entries) {
  const out = [];
  for (const e of entries)
    for (const r of e.records) {
      r.patient = patientOf(r);
      out.push({ e, r });
    }
  return out;
}

const factOf = (rs, labelRe, { concept = null, authority = null } = {}) => {
  const hits = [];
  for (const x of rs)
    for (const f of x.r.facts)
      if (
        (labelRe && labelRe.test(f.label)) ||
        (concept && f.concept === concept)
      )
        if (!authority || x.r.authority === authority) hits.push({ ...x, f });
  return hits.sort((a, b) => RANK[b.r.authority] - RANK[a.r.authority]);
};

const dateIn = (q) => {
  const m =
    new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`,
      "i",
    ).exec(q) ??
    new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i").exec(q);
  if (!m) {
    const bare = /\bthe (\d{1,2})(?:st|nd|rd|th)\b/i.exec(q);
    return bare ? { d: Number(bare[1]), mo: null } : null;
  }
  const d = Number(/^\d/.test(m[1]) ? m[1] : m[2]);
  const mo = MONTHS[(/^\d/.test(m[1]) ? m[2] : m[1]).slice(0, 3).toLowerCase()];
  return { d, mo };
};
const mentionsDay = (s, { d, mo }) => {
  const re = new RegExp(`\\b0?${d}\\s*(?:-\\s*\\d{1,2}\\s*)?${MONTH_RE}`, "gi");
  for (const m of s.matchAll(re))
    if (!mo || MONTHS[m[1].slice(0, 3).toLowerCase()] === mo) return true;
  // "22-24 Oct" covers the 23rd
  for (const m of s.matchAll(
    new RegExp(`\\b(\\d{1,2})\\s*-\\s*(\\d{1,2})\\s+${MONTH_RE}`, "gi"),
  ))
    if (
      d >= Number(m[1]) &&
      d <= Number(m[2]) &&
      (!mo || MONTHS[m[3].slice(0, 3).toLowerCase()] === mo)
    )
      return true;
  if (mo) {
    const iso = `-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (s.includes(iso)) return true;
  }
  return false;
};

/**
 * @param {string} question
 * @param {{records: {source, records}[], sources}} bundle
 * @param {(src, span) => object} cite
 * @param {{labs?: string}} [extra] a one-line lab digest from the clinical layer
 * @returns {null | {spoken, citations, intent}}
 */
export function briefAnswer(question, bundle, cite, extra = {}) {
  const entries = bundle?.records ?? [];
  if (!entries.some((e) => e.records.length)) return null;
  const all = flatten(entries);
  // A single plain record has no story across records: leave it to the
  // lab and fact layers, except for a planted instruction worth reporting.
  const multi = all.length >= 3;
  const identity = people(entries);
  const main = extra.patient ?? (identity.others.length ? null : identity.main);
  const others = identity.others;
  const mine = all.filter((x) => !x.r.patient || !main || x.r.patient === main);
  const otherRecs = all.filter(
    (x) => main && x.r.patient && x.r.patient !== main,
  );
  const spans = [];
  const use = (x, start, end) => {
    spans.push({ sourceId: x.e.source?.id, start, end });
  };
  const useFact = (x) => use(x, x.f.start, x.f.end);
  const say = (text, intent) => {
    const citations = [];
    for (const c of spans) {
      const src = bundle.sources.find((s) => s.id === c.sourceId);
      if (src && c.end <= src.text.length)
        citations.push(cite(src, { start: c.start, end: c.end }));
    }
    return citations.length
      ? { spoken: text.replace(/\s+/g, " ").trim(), citations, intent }
      : null;
  };
  const namesake = () => {
    if (!otherRecs.length) return "";
    const pg = [...new Set(otherRecs.flatMap((x) => x.r.pages ?? []))];
    const id = otherRecs[0].r.patient;
    return ` Page ${pg.join(", ")} is for a different person with the same name (${id}), so I left it out.`;
  };
  const injections = () => {
    const found = [];
    for (const x of all) {
      const text = x.e.source?.text ?? "";
      for (const s of sentencesOf(text, x.r.start, x.r.end))
        if (INJECTION_RE.test(s.text)) found.push({ x, s });
    }
    return found;
  };
  const q = question;
  if (!main && identity.others.length && INTENTS.summary.test(q)) return null;
  // A question about one named lab test ("what was ferritin before the
  // correction?") belongs to the lab layer; only record-level questions that
  // can't be about a single test are answered here.
  const labQ = !!extra.namedTest;

  // ---- what one record says about something ("what did the draft note
  // say about iron?"): that record's facts and sentences on the topic
  const about = INTENTS.recordAbout.exec(q);
  if (about && multi) {
    const which = about[3]
      .toLowerCase()
      .replace(/\b(the|a|an)\b/g, "")
      .trim();
    const topic = (about[5].toLowerCase().match(/[a-z]{3,}/g) ?? []).filter(
      (w) =>
        !["her", "his", "their", "the", "this", "that", "about"].includes(w),
    );
    const wordsOf = (x) =>
      `${x.r.title ?? ""} ${x.r.status ?? ""}`.toLowerCase();
    const recs = all.filter((x) =>
      which
        .split(/\s+/)
        .some((w) => w.length > 3 && wordsOf(x).includes(w.replace(/s$/, ""))),
    );
    if (recs.length && topic.length) {
      const hitsIn = [];
      for (const x of recs) {
        for (const f of x.r.facts)
          if (
            topic.some((t) => `${f.label} ${f.value}`.toLowerCase().includes(t))
          )
            hitsIn.push({
              x,
              text: `${f.label}: ${f.value}`,
              start: f.start,
              end: f.end,
            });
        for (const s2 of sentencesOf(
          x.e.source?.text ?? "",
          x.r.start,
          x.r.end,
        ))
          if (
            topic.some((t) => s2.text.toLowerCase().includes(t)) &&
            !INJECTION_RE.test(s2.text)
          )
            hitsIn.push({ x, text: s2.text, start: s2.start, end: s2.end });
      }
      if (hitsIn.length) {
        const r0 = hitsIn[0].x.r;
        hitsIn.slice(0, 3).forEach((h) => use(h.x, h.start, h.end));
        const later =
          r0.authority === "provisional"
            ? factOf(mine, /prescri|medicat|iron|discharg|diagnos/i, {
                authority: "authoritative",
              }).find((h) =>
                topic.some((t) =>
                  `${h.f.label} ${h.f.value}`.toLowerCase().includes(t),
                ),
              )
            : null;
        if (later) useFact(later);
        return say(
          `The ${titleOf(r0).toLowerCase()} (${pageOf(r0)}, ${r0.status ?? "no status"}) says: ` +
            hitsIn
              .slice(0, 3)
              .map((h) => h.text.replace(/[.]$/, ""))
              .join(". ") +
            "." +
            (later
              ? ` That record is not final; the ${titleOf(later.r).toLowerCase()} (${pageOf(later.r)}, ${later.r.status}) settles it: ${later.f.label}: ${later.f.value}.`
              : ""),
          "RECORD_ABOUT",
        );
      }
    }
  }

  // ---- one page
  const pageAsk = INTENTS.page.exec(q);
  if (
    pageAsk &&
    /\b(tell|what|about|show|explain|who|whose|describe)\b/i.test(q)
  ) {
    const n = Number(pageAsk[2]);
    const recs = all.filter((x) => x.r.pages?.includes(n));
    if (recs.length) {
      const x = recs[0];
      const head = x.r.facts.slice(0, 1);
      head.forEach((f) => use(x, f.start, f.end));
      const lab = (extra.reports ?? []).filter((r) =>
        r.observations?.some((o) => o.source?.page === n),
      );
      const obs = lab.flatMap((r) =>
        r.observations.filter((o) => o.source?.page === n),
      );
      const pid = x.r.patient;
      const dob = x.r.facts.find((f) =>
        /^(dob|date of birth)$/i.test(f.label.trim()),
      )?.value;
      const other = main && pid && pid !== main;
      const warn = sentencesOf(x.e.source?.text ?? "", x.r.start, x.r.end).find(
        (s2) =>
          /belongs to|not the same|different patient|share a printed name/i.test(
            s2.text,
          ),
      );
      if (warn) use(x, warn.start, warn.end);
      return say(
        `Page ${n} is ${x.r.title && !/hospita\b/i.test(x.r.title) ? `the ${titleOf(x.r).toLowerCase()}` : "a scanned record"}` +
          `${pid ? ` for patient ID ${pid}` : ""}${dob ? `, born ${dob}` : ""}` +
          `${x.r.status ? `, marked ${x.r.status}` : ""}.` +
          (other
            ? ` That is a different person from ${main}, the person the rest of the file is about, so I keep it separate.`
            : "") +
          (obs.length
            ? ` It lists ${obs
                .slice(0, 8)
                .map((o) =>
                  o.unreadable
                    ? `${o.test}: too unclear to read safely, check the original scan`
                    : `${o.test} ${o.raw}${o.unit ? " " + o.unit : ""}`,
                )
                .join(
                  ", ",
                )}${obs[0].source?.method === "ocr" ? " (read from the scan)" : ""}.`
            : "") +
          (warn ? ` The page itself says: "${warn.text}"` : ""),
        "PAGE",
      );
    }
  }

  // ---- how long was the stay
  if (INTENTS.stay.test(q)) {
    const inn =
      factOf(mine, /^(admitted|arrival|admission)/i)[0] ??
      factOf(mine, /arrival|admit/i)[0];
    const out =
      factOf(mine, /^discharged?$/i)[0] ??
      factOf(mine, null, { concept: "discharge" }).find((h) =>
        /\d/.test(h.f.value),
      );
    if (inn && out) {
      useFact(inn);
      useFact(out);
      const t = (v) => {
        const m = new RegExp(
          `(\\d{1,2})\\s+${MONTH_RE}\\s+(\\d{4})[, ]*(\\d{1,2}):(\\d{2})?`,
          "i",
        ).exec(v);
        return m
          ? Date.UTC(
              +m[3],
              MONTHS[m[2].slice(0, 3).toLowerCase()] - 1,
              +m[1],
              +(m[4] ?? 0),
              +(m[5] ?? 0),
            )
          : NaN;
      };
      const h = (t(out.f.value) - t(inn.f.value)) / 3600000;
      const span =
        Number.isFinite(h) && h > 0
          ? ` That is about ${Math.round(h)} hours, a little over ${Math.floor(h / 24)} day${Math.floor(h / 24) === 1 ? "" : "s"}.`
          : "";
      return say(
        `Admitted ${inn.f.value.replace(/\s*\(local\)/, "")} (${titleOf(inn.r).toLowerCase()}, ${pageOf(inn.r)}); discharged ${out.f.value} (${titleOf(out.r).toLowerCase()}, ${pageOf(out.r)}, ${out.r.status ?? "no status"}).${span}`,
        "STAY",
      );
    }
  }

  // ---- why the bill changed
  if (INTENTS.billChange.test(q)) {
    const totals = factOf(mine, null, { concept: "total charges" });
    const fin = totals.find((h) => h.r.authority === "authoritative");
    const est = totals.find((h) => h.r.authority === "provisional");
    if (fin && est && fin.r !== est.r) {
      useFact(fin);
      useFact(est);
      const items = (x) => x.r.facts.filter((f) => f.line);
      const stem = (label) =>
        (label.toLowerCase().match(/[a-z]{3,}/g) ?? []).map((w) =>
          w.slice(0, 3),
        );
      const diffs = [];
      for (const a of items(est)) {
        const sa = stem(a.label);
        const bs = items(fin).filter((b) =>
          stem(b.label).some((w) => sa.includes(w)),
        );
        if (!bs.length) continue;
        const amt = (v) =>
          Number(
            (/(\d[\d,]*\.?\d*)/.exec(v.split("·").pop())?.[1] ?? "").replace(
              /,/g,
              "",
            ),
          );
        const before = amt(a.value);
        const after = bs.reduce((x, b) => x + amt(b.value), 0);
        if (
          Number.isFinite(before) &&
          Number.isFinite(after) &&
          Math.abs(before - after) > 0.004
        ) {
          diffs.push(
            `${a.label} ${before.toLocaleString("en-US")} → ${bs.map((b) => b.label).join(" + ")} ${after.toLocaleString("en-US")}`,
          );
          useFact({ ...est, f: a });
          bs.forEach((b) => useFact({ ...fin, f: b }));
        }
      }
      return say(
        `${est.f.value.split("·")[0].trim()} was the ${titleOf(est.r).toLowerCase()} (${pageOf(est.r)}, ${est.r.status}); the ${titleOf(fin.r).toLowerCase()} (${pageOf(fin.r)}, ${fin.r.status}) replaced it with ${fin.f.value.split("·")[0].trim()}.` +
          (diffs.length
            ? ` The line items that differ (USD): ${diffs.join("; ")}.`
            : "") +
          " The records don't give a reason for each difference.",
        "BILL_CHANGE",
      );
    }
  }

  // ---- mistakes and corrections
  if (INTENTS.mistakes.test(q) && multi && !labQ) {
    const found = [];
    for (const x of mine) {
      if (x.r.authority !== "authoritative") continue;
      for (const s2 of sentencesOf(x.e.source?.text ?? "", x.r.start, x.r.end))
        if (
          /transcription error|error affected|did not occur|was not carried|superseded by|correction|amended|duplicate billing|billing error/i.test(
            s2.text,
          ) &&
          !INJECTION_RE.test(s2.text)
        )
          found.push({ x, s: s2 });
    }
    if (found.length) {
      const seen = new Set();
      const pick = found
        .filter(
          (f) =>
            !seen.has(f.x.r.index + f.s.text.slice(0, 30)) &&
            seen.add(f.x.r.index + f.s.text.slice(0, 30)),
        )
        .slice(0, 4);
      pick.forEach((f) => use(f.x, f.s.start, f.s.end));
      return say(
        "Here is what the final records themselves correct or flag: " +
          pick
            .map(
              (f) =>
                `${titleOf(f.x.r)} (${pageOf(f.x.r)}): ${f.s.text.replace(/[.]$/, "")}`,
            )
            .join(". ") +
          ". I only report what the records say; whether anything was a mistake beyond that is for the hospital to answer.",
        "CORRECTIONS",
      );
    }
  }

  // ---- who the records are about: IDs, birth date, encounter
  if (INTENTS.identity.test(q)) {
    const want = /birth|dob|old/i.test(q)
      ? /date of birth|^dob$/i
      : /encounter|accession/i.test(q)
        ? /encounter|accession/i
        : /file/i.test(q)
          ? /file reference/i
          : /^patient id$|^patient \/|mrn|hospital (no|number)/i;
    const hit = mine.flatMap((x) =>
      x.r.facts
        .filter((f) => want.test(f.label.trim()))
        .map((f) => ({ ...x, f })),
    )[0];
    if (hit) {
      useFact(hit);
      return say(
        `${hit.f.label
          .replace(/^./, (c) => c.toUpperCase())
          .toLowerCase()
          .replace(/^./, (c) =>
            c.toUpperCase(),
          )}: ${hit.f.value} (${titleOf(hit.r).toLowerCase()}, ${pageOf(hit.r)}).` +
          (otherRecs.length ? namesake() : ""),
        "IDENTITY",
      );
    }
  }

  // ---- who treated / which doctor
  if (INTENTS.clinician.test(q)) {
    const d = factOf(
      mine,
      /signator|attending|physician|consultant|doctor|ordered by/i,
    ).find(
      (h) =>
        /dr\.?\s|physician|doctor/i.test(h.f.value) ||
        /signator/i.test(h.f.label),
    );
    if (d) {
      useFact(d);
      return say(
        `The ${titleOf(d.r).toLowerCase()} (${pageOf(d.r)}, ${d.r.status ?? "no status"}) names ${d.f.value} (${d.f.label.toLowerCase()}). It's the only clinician named as signing; the records don't list everyone who treated her.`,
        "CLINICIAN",
      );
    }
  }

  // ---- next visit
  if (INTENTS.followUp.test(q)) {
    const f = factOf(mine, null, { concept: "follow-up" })[0];
    if (f) {
      useFact(f);
      return say(
        `${f.f.label}: ${f.f.value} (${titleOf(f.r).toLowerCase()}, ${pageOf(f.r)}, ${f.r.status ?? "no status"}).`,
        "FOLLOW_UP",
      );
    }
  }

  // ---- which unit / ICU
  if (INTENTS.unit.test(q)) {
    const a = factOf(mine, /admitting service|ward|unit|disposition/i);
    if (a.length) {
      a.slice(0, 2).forEach(useFact);
      const icu = a.some((h) => /\bicu\b|intensive/i.test(h.f.value));
      return say(
        (icu
          ? ""
          : /\bicu|intensive/i.test(q)
            ? "The records don't mention intensive care. "
            : "") +
          a
            .slice(0, 2)
            .map(
              (h) =>
                `${h.f.label}: ${h.f.value} (${titleOf(h.r).toLowerCase()}, ${pageOf(h.r)})`,
            )
            .join("; ") +
          ".",
        "UNIT",
      );
    }
  }

  // ---- one line of the bill ("how much was the imaging?")
  if (
    INTENTS.lineItem.test(q) &&
    !INTENTS.billChange.test(q) &&
    // the balance, a payment, insurance or the total are facts of their own
    !/\b(owe|owes|owed|balance|due|paid|pay|pays|insur\w*|total|final bill|whole bill|the bill)\b/i.test(
      q,
    )
  ) {
    const qw = (q.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(
      (w) =>
        ![
          "much",
          "cost",
          "costs",
          "charge",
          "charged",
          "price",
          "amount",
          "what",
          "were",
          "they",
          "that",
          "this",
          "with",
          "from",
          "have",
          "does",
        ].includes(w),
    );
    const lines = [];
    for (const x of mine)
      for (const f of x.r.facts)
        if (
          (f.line ||
            /\b(USD|INR|EUR|GBP|RS\.?)\s?\d|[$₹]\s?\d/i.test(f.value)) &&
          qw.some((w) =>
            `${f.label} ${f.value}`.toLowerCase().includes(w.slice(0, 5)),
          )
        )
          lines.push({ ...x, f });
    if (lines.length) {
      lines.sort((a, b) => RANK[b.r.authority] - RANK[a.r.authority]);
      const top = lines.filter((h) => h.r === lines[0].r);
      const older = lines.filter(
        (h) =>
          h.r !== lines[0].r &&
          RANK[h.r.authority] < RANK[lines[0].r.authority],
      );
      [...top, ...older.slice(0, 1)].forEach(useFact);
      return say(
        `The ${titleOf(top[0].r).toLowerCase()} (${pageOf(top[0].r)}, ${top[0].r.status ?? "no status"}) charges ` +
          top.map((h) => `${h.f.label}: ${h.f.value}`).join("; ") +
          "." +
          (older.length
            ? ` The earlier ${titleOf(older[0].r).toLowerCase()} (${older[0].r.status}) had ${older[0].f.label}: ${older[0].f.value}; the final bill replaces it.`
            : ""),
        "LINE_ITEM",
      );
    }
  }

  // ---- which records are drafts / final
  if (INTENTS.status.test(q) && multi && !labQ) {
    const rows = all.map(({ e, r }) => {
      const x = { e, r };
      const head = r.facts[0];
      if (head) use(x, head.start, head.end);
      const st = r.status
        ? r.status.replace(/ \/ /g, ", ")
        : "no status printed";
      const who =
        main && r.patient && r.patient !== main
          ? ` (a different person, ${r.patient})`
          : "";
      return { r, line: `${pageOf(r)} ${titleOf(r)}: ${st}${who}` };
    });
    const prov = rows.filter((x) => x.r.authority === "provisional");
    const auth = rows.filter((x) => x.r.authority === "authoritative");
    const inj = injections();
    inj.forEach(({ x, s }) => use(x, s.start, s.end));
    return say(
      `This file holds ${rows.length} records. Not final, so I only use them where nothing more authoritative exists: ${prov.map((x) => x.line).join("; ") || "none"}. ` +
        `Final, signed or amended, so they win: ${auth.map((x) => x.line).join("; ") || "none"}.` +
        (rows.length > prov.length + auth.length
          ? ` No status printed: ${rows
              .filter((x) => !prov.includes(x) && !auth.includes(x))
              .map((x) => x.line)
              .join("; ")}.`
          : "") +
        (inj.length
          ? ` One record (${pageOf(inj[0].x.r)}) contains copied text telling an automated summary to ignore newer records; it is not a clinical instruction and I don't follow it.`
          : ""),
      "STATUS",
    );
  }

  // ---- charged twice
  if (INTENTS.duplicate.test(q)) {
    const bills = mine
      .filter((x) => x.r.facts.some((f) => f.line))
      .sort((a, b) => RANK[b.r.authority] - RANK[a.r.authority]);
    for (const b of bills) {
      const byCode = new Map();
      for (const f of b.r.facts) {
        if (!f.line) continue;
        const code =
          /\(([A-Z0-9-]{4,})\)/.exec(f.label)?.[1] ?? f.label.toLowerCase();
        (byCode.get(code) ?? byCode.set(code, []).get(code)).push(f);
      }
      const rep = [...byCode].find(([, fs]) => fs.length > 1);
      if (!rep) continue;
      const [code, fs] = rep;
      fs.forEach((f) => useFact({ ...b, f }));
      const notes = sentencesOf(b.e.source?.text ?? "", b.r.start, b.r.end)
        .filter((s) =>
          /duplicate|same code|billing error|billing.office|refund/i.test(
            s.text,
          ),
        )
        .slice(0, 2);
      notes.forEach((n) => use(b, n.start, n.end));
      const note = notes.length
        ? { text: notes.map((n) => n.text).join(" ") }
        : null;
      return say(
        `The ${titleOf(b.r).toLowerCase()} (${pageOf(b.r)}, ${b.r.status ?? "no status"}) lists ${code} ${fs.length} times: ` +
          fs.map((f) => `${f.label}, ${f.value}`).join("; ") +
          ". " +
          (note
            ? `The statement itself says: "${note.text}"`
            : "The record does not say whether this is a duplicate; the billing office can confirm."),
        "DUPLICATE",
      );
    }
    return null;
  }

  // ---- medicines
  if (INTENTS.medication.test(q) && !/\b(result|level|value)\b/i.test(q)) {
    const hits = factOf(
      mine,
      /prescri|medicat|supplement|\biron\b|drug|tablet|treatment decision/i,
    );
    if (!hits.length) return null;
    const seen = new Set();
    const lines = [];
    for (const h of hits) {
      if (seen.has(h.f.label.toLowerCase())) continue;
      seen.add(h.f.label.toLowerCase());
      useFact(h);
      lines.push(
        `${h.f.label}: ${h.f.value} (${titleOf(h.r).toLowerCase()}, ${pageOf(h.r)}${h.r.status ? `, ${h.r.status}` : ""})`,
      );
      if (lines.length >= 4) break;
    }
    const signed = hits.find((h) => h.r.authority === "authoritative");
    return say(
      (signed
        ? `The signed record decides this. ${lines[0]}.`
        : `Here is what the records say about medicines. ${lines[0]}.`) +
        (lines.length > 1
          ? ` Earlier or less final records: ${lines.slice(1).join("; ")}.`
          : "") +
        " Nothing here is a recommendation to start or stop anything; that's for the prescribing doctor.",
      "MEDICATION",
    );
  }

  // ---- why admitted
  if (INTENTS.reason.test(q)) {
    const r = factOf(mine, /reason for|presenting|complaint|chief|symptom/i)[0];
    if (!r) return null;
    useFact(r);
    const when = factOf(mine, /arrival|admit/i)[0];
    if (when) useFact(when);
    return say(
      `${r.f.label}: ${r.f.value}${when ? `, on ${when.f.value.replace(/\s*\(local\)/, "")}` : ""} (${titleOf(r.r).toLowerCase()}, ${pageOf(r.r)}).`,
      "REASON",
    );
  }

  // ---- diagnosis
  if (INTENTS.diagnosis.test(q)) {
    const d = factOf(mine, null, { concept: "diagnosis" })[0];
    if (!d) return null;
    useFact(d);
    return say(
      `The ${titleOf(d.r).toLowerCase()} (${pageOf(d.r)}, ${d.r.status ?? "no status"}) records: ${d.f.label}: ${d.f.value}.` +
        (extra.clinical
          ? ` ${extra.clinical}`
          : extra.labs
            ? ` ${extra.labs}`
            : "") +
        " A result outside the printed range is not a diagnosis; the doctor decides that.",
      "DIAGNOSIS",
    );
  }

  // ---- what happened on a day
  const day =
    /\b(happen\w*|events?|on that day|what (went on|was done))\b/i.test(q)
      ? dateIn(q)
      : null;
  if (day && multi && !labQ) {
    const events = [];
    for (const x of mine) {
      for (const f of x.r.facts)
        if (
          mentionsDay(f.value, day) &&
          !/^(issued|file reference|sample collected|report issued|note created|estimate prepared)$/i.test(
            f.label.trim(),
          )
        )
          events.push({
            x,
            rank: RANK[x.r.authority],
            text: `${f.label}: ${f.value}`,
            start: f.start,
            end: f.end,
          });
      for (const s of sentencesOf(x.e.source?.text ?? "", x.r.start, x.r.end))
        if (mentionsDay(s.text, day) && !INJECTION_RE.test(s.text))
          events.push({
            x,
            rank: RANK[x.r.authority],
            text: s.text,
            start: s.start,
            end: s.end,
          });
    }
    if (!events.length) return null;
    events.sort((a, b) => b.rank - a.rank);
    const picked = [];
    const perRec = new Map();
    for (const ev of events) {
      const n = perRec.get(ev.x.r.index) ?? 0;
      if (n >= 2) continue;
      perRec.set(ev.x.r.index, n + 1);
      picked.push(ev);
      use(ev.x, ev.start, ev.end);
      if (picked.length >= 5) break;
    }
    return say(
      `On that day, by record (most authoritative first): ` +
        picked
          .map(
            (ev) =>
              `${titleOf(ev.x.r)} (${pageOf(ev.x.r)}): ${ev.text.replace(/[.]$/, "")}`,
          )
          .join(". ") +
        "." +
        namesake(),
      "DATE",
    );
  }

  // ---- the whole encounter
  if (INTENTS.summary.test(q) && multi && !labQ) {
    const parts = [];
    const who = main
      ? (all
          .find((x) => x.r.patient === main)
          ?.r.facts.find((f) => /patient name/i.test(f.label))?.value ?? null)
      : null;
    const reason = factOf(mine, /reason for|presenting|complaint/i)[0];
    const arrive = factOf(mine, /arrival|admitted|admit\b/i)[0];
    if (arrive || reason) {
      if (arrive) useFact(arrive);
      if (reason) useFact(reason);
      parts.push(
        `${who ? `${who}${main ? ` (${main})` : ""}` : "The patient"} came in${arrive ? ` on ${arrive.f.value.replace(/\s*\(local\)/, "").replace(/,? \d{2}:\d{2}.*/, "")}` : ""}${reason ? ` with ${reason.f.value.replace(/ reported$/i, "").toLowerCase()}` : ""}.`,
      );
    }
    const dis = factOf(mine, null, { concept: "discharge" }).filter((h) =>
      /\d/.test(h.f.value),
    )[0];
    if (dis) {
      useFact(dis);
      parts.push(
        `She was discharged on ${dis.f.value.replace(/^Discharged from observation on /i, "")} (${titleOf(dis.r).toLowerCase()}, ${dis.r.status ?? "no status"}).`,
      );
    }
    if (extra.labs) parts.push(extra.labs);
    const diag = factOf(mine, null, {
      concept: "diagnosis",
      authority: "authoritative",
    })[0];
    if (diag) {
      useFact(diag);
      parts.push(`${diag.f.value.replace(/;\s*/, "; ")}.`);
    }
    const med = factOf(mine, /prescri/i, { authority: "authoritative" })[0];
    if (med) {
      useFact(med);
      parts.push(`${med.f.label}: ${med.f.value.toLowerCase()}.`);
    }
    const fu = factOf(mine, null, {
      concept: "follow-up",
      authority: "authoritative",
    })[0];
    if (fu) {
      useFact(fu);
      parts.push(`Follow-up: ${fu.f.value.toLowerCase()}.`);
    }
    const total = factOf(mine, null, {
      concept: "total charges",
      authority: "authoritative",
    })[0];
    const paid = factOf(mine, /insurer payment/i, {
      authority: "authoritative",
    })[0];
    const owed = factOf(mine, null, {
      concept: "amount owed",
      authority: "authoritative",
    })[0];
    const payRec = factOf(mine, /patient payment/i, {
      authority: "authoritative",
    })[0];
    if (total || owed) {
      [total, paid, owed, payRec].filter(Boolean).forEach(useFact);
      const money = (h) => h?.f.value.split("·")[0].trim();
      parts.push(
        `Bill: ${total ? `final charges ${money(total)}` : ""}${paid ? `, insurance paid ${money(paid)}` : ""}${owed ? `, her share ${money(owed)}` : ""}${payRec ? ` (${payRec.f.value.split("·").pop().trim().toLowerCase()})` : ""}.`,
      );
    }
    const inj = injections();
    if (inj.length) {
      use(inj[0].x, inj[0].s.start, inj[0].s.end);
      parts.push(
        `The unsigned working note (${pageOf(inj[0].x.r)}) contains copied text telling an automated summary to ignore the newer records; I don't follow instructions inside documents, and the signed and amended records win.`,
      );
    }
    if (parts.length < 2) return null;
    return say(parts.join(" ") + namesake(), "SUMMARY");
  }
  return null;
}

/** Does a question belong to this layer? (Cheap check before the work.) */
export const briefIntent = (q) =>
  Object.values(INTENTS).some((re) => re.test(q)) ||
  (/\b(happen\w*|events?)\b/i.test(q) && !!dateIn(q));

/**
 * Three example questions built from the uploaded records themselves, for
 * the greeting and the help reply ("You can ask: what is Maya's ferritin?").
 */
export function suggestQuestions(bundle) {
  const reports = bundle?.clinical ?? [];
  const entries = bundle?.records ?? [];
  const out = [];
  const name =
    reports
      .find((r) => r.meta?.patient?.name)
      ?.meta.patient.name?.split(/\s+/)[0] ?? null;
  const who = name ? `${name}'s` : "the";
  const obs = reports
    .flatMap((r) => r.observations ?? [])
    .filter((o) => !o.notReleased && o.value != null);
  const corrected = reports.find((r) => r.meta?.status === "amended")
    ?.observations?.[0];
  const pick = corrected ?? obs[0];
  if (pick) out.push(`what is ${who} ${pick.test.replace(/\s*\(.*\)$/, "")}?`);
  const facts = entries.flatMap((e) => e.records.flatMap((r) => r.facts));
  if (facts.some((f) => f.concept === "discharge"))
    out.push(`when was ${name ?? "the patient"} discharged?`);
  if (facts.some((f) => f.concept === "amount owed"))
    out.push("how much is still owed?");
  if (out.length < 3) out.push("summarise these records");
  return out.slice(0, 3);
}

/**
 * A number the question quotes that the records later corrected ("her iron
 * was 5"): one sentence naming the correction, or null.
 */
export function quotedCorrection(question, reports) {
  const said = [
    ...String(question).matchAll(/(?<![\d.])(\d+(?:\.\d+)?)(?![\d.])/g),
  ].map((m) => m[1]);
  if (!said.length) return null;
  for (const r of reports ?? []) {
    if (!/preliminary/.test(r.meta?.status ?? "")) continue;
    for (const o of r.observations ?? []) {
      if (!said.includes(String(o.raw))) continue;
      const fixed = (reports ?? []).find(
        (x) =>
          x !== r &&
          x.meta?.status === "amended" &&
          x.meta?.collected === r.meta?.collected &&
          x.observations?.some(
            (y) => y.key === o.key && String(y.raw) !== String(o.raw),
          ),
      );
      const y = fixed?.observations.find((z) => z.key === o.key);
      if (y)
        return `One thing to bring to that conversation: the ${o.test} of ${o.raw}${o.unit ? " " + o.unit : ""} was a preliminary value, corrected to ${y.raw}${y.unit ? " " + y.unit : ""} in the amended report.`;
    }
  }
  return null;
}
