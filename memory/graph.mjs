// Knowledge graph: a VIEW over semantic memory (claims, lab observations) and
// episodic memory (what was asked and cited). It is rebuilt from those on
// every request, so it can never drift from the evidence, and it grows as
// questions are answered (each answered turn adds a question node and
// strengthens the edges to what it cited).
//
// Four levels, each one click deeper:
//   overview     topics, documents, recent questions
//   topic:<f>    the values on record for that topic, their status, which
//                document holds each, what supersedes or competes with what
//   value:<id>   the exact sentences that state the value (evidence nodes)
//                and the questions that cited them
//   doc:<id>     everything that document records, by topic
//   q:<id>       what one answered question cited
// Every evidence edge carries an exact source span, so a click can open the
// original passage.
import { extractClaims, resolveClaims } from "../dist/engine.mjs";
import { liveEpisodes } from "./memory.mjs";
import { subjectOf } from "../clinical/observations.mjs";

const FIELDS = [
  "fee",
  "paymentSplit",
  "deadline",
  "scope",
  "signoffWho",
  "signedAgreement",
  "launchApproval",
  "reporting",
];
const TOPIC_LABEL = {
  fee: "Fee",
  paymentSplit: "Payment split",
  deadline: "Deadline / go-live",
  scope: "Scope",
  signoffWho: "Sign-off",
  signedAgreement: "Signed agreement",
  launchApproval: "Launch approval",
  reporting: "Reporting",
};
const RANK = {
  approved: 5,
  requested: 3,
  proposed: 2,
  "internal-target": 2,
  discussed: 1,
  unresolved: 0,
};

const shortTitle = (t) =>
  t
    .replace(/\.(md|markdown|txt|pdf|docx|png|jpe?g)$/i, "")
    .replace(/^\d+[_\s-]*/, "")
    .replace(/[_-]+/g, " ")
    .trim();
const canon = (v) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, " ")
    .trim();
const valueId = (field, v) => `value:${field}:${canon(v).replace(/\s+/g, "-")}`;
const span = (c) => ({
  sourceId: c.sourceId,
  start: c.start,
  end: c.end,
  title: c.title,
  quote: c.quote,
});

/**
 * Who approved, from the approving sentence itself: only the words BEFORE
 * the approval verb count ("Farah (finance approver): INTERNAL finance
 * APPROVES ..." -> "internal finance"), so "TWO SITES APPROVED, ... CLIENT
 * UNSIGNED" never names the client as approver. Null when not stated.
 */
export function approvalAuthority(quote) {
  const q = String(quote ?? "");
  const verb = /\bapprov(?:es|ed|e|al|ing)\b/i.exec(q);
  if (!verb) return null;
  const before = q.slice(0, verb.index);
  const internal = /\binternal(?:ly)?\b/i.test(before);
  const body =
    /\b(steering(?:\s+committee)?|finance|committee|board|client|customer|legal)\b/i.exec(
      before,
    )?.[1];
  const who = body
    ? /^steering/i.test(body)
      ? "steering committee"
      : body.toLowerCase()
    : null;
  if (!who && !internal) return null;
  return [internal ? "internal" : null, who].filter(Boolean).join(" ");
}

// A "signed agreement" record that says there is NO signed record.
const NO_SIGNED_RE =
  /\bno\b[^.;]{0,40}\b(?:signed|executed|signature)\b|\bnot\b[^.;]{0,25}\b(?:signed|executed)\b|\bdoes not constitute\b[^.;]{0,40}\bsignature\b/i;

/**
 * Which engagement each claim belongs to, for value-node identity: the same
 * figure in two unrelated engagements ("$42,000" proposed for Alder, approved
 * for Birch) is two values, never one approved node. Claims of one field and
 * amount share a node only when their engine scope entities overlap. A claim
 * with no scope entity joins the only engagement there is, else stays apart.
 * Returns "" (the plain id) when the amount has a single engagement, so ids in
 * one-engagement corpora are unchanged.
 */
function engagementKeys(list) {
  const out = new Map();
  const byValue = new Map();
  for (const c of list) {
    const k = canon(c.value);
    byValue.set(k, [...(byValue.get(k) ?? []), c]);
  }
  for (const group of byValue.values()) {
    const clusters = [];
    const unscoped = [];
    for (const c of group) {
      const ents = new Set(c.scopeEntities ?? []);
      if (!ents.size) {
        unscoped.push(c);
        continue;
      }
      const hits = clusters.filter((k) => [...ents].some((e) => k.ents.has(e)));
      const into = hits[0] ?? { ents: new Set(), claims: [] };
      if (!hits.length) clusters.push(into);
      for (const other of hits.slice(1)) {
        for (const e of other.ents) into.ents.add(e);
        into.claims.push(...other.claims);
        clusters.splice(clusters.indexOf(other), 1);
      }
      for (const e of ents) into.ents.add(e);
      into.claims.push(c);
    }
    if (clusters.length <= 1) {
      for (const c of group) out.set(c, "");
      continue;
    }
    for (const k of clusters) {
      const name = [...k.ents].sort((a, b) => b.length - a.length)[0];
      for (const c of k.claims)
        out.set(c, "@" + canon(name).replace(/\s+/g, "-"));
    }
    for (const c of unscoped) out.set(c, "@unscoped");
  }
  return out;
}

export function semanticOf(bundle) {
  const claims = extractClaims(bundle, FIELDS).filter((c) => c.value);
  const byField = new Map();
  for (const f of FIELDS) {
    const list = claims.filter((c) => c.field === f);
    if (!list.length) continue;
    const r = resolveClaims(list);
    const active = new Set(r.active.get(f) ?? []);
    const superseded = new Set(r.superseded);
    const approved = new Set(r.approved.get(f) ?? []);
    const values = new Map();
    const engagementOf = engagementKeys(list);
    for (const c of list) {
      const id = valueId(f, c.value) + engagementOf.get(c);
      const v = values.get(id) ?? {
        id,
        field: f,
        label: String(c.value).replace(/(\S)\(/, "$1 ("),
        claims: [],
        status: "unresolved",
        current: false,
        superseded: true,
      };
      v.claims.push(c);
      if (RANK[c.status] > RANK[v.status]) v.status = c.status;
      if (approved.has(c)) v.status = "approved";
      if (active.has(c)) v.current = true;
      if (!superseded.has(c)) v.superseded = false;
      values.set(id, v);
    }
    const vals = [...values.values()];
    for (const v of vals) {
      if (v.status === "approved") {
        const who = [
          ...new Set(
            v.claims
              .filter((c) => c.status === "approved" || approved.has(c))
              .map((c) => approvalAuthority(c.quote))
              .filter(Boolean),
          ),
        ];
        v.authority = who.length ? who.join(", ") : null;
      }
      if (f === "signedAgreement")
        v.noSignedRecord = v.claims.every((c) => NO_SIGNED_RE.test(c.quote));
    }
    const currentVals = vals.filter((v) => v.current);
    for (const v of vals)
      v.competing =
        currentVals.length > 1 &&
        v.current &&
        !vals.some((x) => x.status === "approved");
    byField.set(f, vals);
  }
  return byField;
}

export function buildGraph(bundle, mem, focus = "overview") {
  if (!bundle) return { focus, nodes: [], edges: [], crumbs: [] };
  const sem = semanticOf(bundle);
  const eps = liveEpisodes(mem, bundle);
  const docs = new Map(bundle.sources.map((s) => [s.id, s]));
  // Usage: how often each source span / document was cited by an answer.
  const docUse = new Map();
  const valueUse = new Map();
  const claimKey = (c) => `${c.sourceId}:${c.start}`;
  const lineCites = new Map();
  for (const e of eps)
    for (const c of e.cited) {
      docUse.set(c.sourceId, (docUse.get(c.sourceId) ?? 0) + 1);
      const k = `${c.sourceId}:${c.start}`;
      lineCites.set(k, [...(lineCites.get(k) ?? []), e.id]);
    }
  for (const vals of sem.values())
    for (const v of vals)
      valueUse.set(
        v.id,
        v.claims.reduce(
          (n, c) =>
            n +
            eps.filter((e) =>
              e.cited.some(
                (x) =>
                  x.sourceId === c.sourceId &&
                  x.start <= c.end &&
                  x.end >= c.start,
              ),
            ).length,
          0,
        ),
      );

  const nodes = new Map();
  const edges = [];
  const node = (n) => nodes.set(n.id, { weight: 0, ...nodes.get(n.id), ...n });
  const edge = (e) =>
    edges.push({ id: `${e.from}->${e.to}:${e.kind}`, weight: 1, ...e });
  const docNode = (src) =>
    node({
      id: `doc:${src.id}`,
      kind: "document",
      label: shortTitle(src.title),
      date: (src.text.match(/Date:\s*(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null,
      weight: docUse.get(src.id) ?? 0,
    });
  const topicNode = (f) =>
    node({
      id: `topic:${f}`,
      kind: "topic",
      label: TOPIC_LABEL[f] ?? f,
      weight: (sem.get(f) ?? []).reduce(
        (n, v) => n + (valueUse.get(v.id) ?? 0),
        0,
      ),
    });
  const valueNode = (v) =>
    node({
      id: v.id,
      kind: "value",
      label: v.label,
      status: v.competing ? "open" : v.superseded ? "superseded" : v.status,
      domain: "record",
      ...(v.status === "approved" ? { authority: v.authority ?? null } : {}),
      ...(v.noSignedRecord ? { noSignedRecord: true } : {}),
      field: v.field,
      weight: valueUse.get(v.id) ?? 0,
    });
  const qNode = (e) =>
    node({
      id: `q:${e.id}`,
      kind: "question",
      label: e.question,
      verdict: e.verdict,
      at: e.at,
      spoken: e.spoken,
    });

  const crumbs = [{ id: "overview", label: "All records" }];
  const [level, ...rest] = focus.split(":");
  const key = rest.join(":");

  if (level === "overview" || !level) {
    for (const [f, vals] of sem) {
      topicNode(f);
      for (const src of new Set(
        vals.flatMap((v) => v.claims.map((c) => docs.get(c.sourceId))),
      )) {
        docNode(src);
        edge({ from: `doc:${src.id}`, to: `topic:${f}`, kind: "records" });
      }
    }
    for (const src of bundle.sources) docNode(src);
    for (const lab of bundle.clinical ?? []) {
      const src = docs.get(lab.sourceId);
      if (!src) continue;
      // One topic per person: two people's reports never share a node. The
      // stable patient ID is the key (two people can share a name); a report
      // with NO verified identity gets its own per-report topic, never a
      // shared "unidentified" bucket that would imply one person.
      // Same subject rule as the evidence engine (subjectOf): ID, else
      // printed name, else this report alone. Masked fields count as absent.
      const subject = subjectOf({ ...lab, sourceId: lab.sourceId });
      const pid = subject.startsWith("doc:") ? "" : subject;
      const who = pid
        ? String(
            lab.meta?.patient?.name || lab.meta?.patient?.id || pid,
          ).replace(/\s*\(synthetic\)/i, "")
        : "";
      const tid = pid ? `topic:lab:${pid}` : `topic:lab:unverified:${src.id}`;
      node({
        id: tid,
        kind: "topic",
        label: who
          ? `Lab results - ${who}`
          : "Lab results (identity unverified)",
      });
      docNode(src);
      edge({ from: `doc:${src.id}`, to: tid, kind: "records" });
    }
    for (const e of eps.slice(-8)) {
      qNode(e);
      for (const sid of new Set(e.cited.map((c) => c.sourceId)))
        if (docs.has(sid))
          edge({ from: `q:${e.id}`, to: `doc:${sid}`, kind: "cited" });
      if (e.field && nodes.has(`topic:${e.field}`))
        edge({ from: `q:${e.id}`, to: `topic:${e.field}`, kind: "asked" });
    }
  } else if (level === "topic") {
    const vals = sem.get(key) ?? [];
    topicNode(key);
    crumbs.push({ id: focus, label: TOPIC_LABEL[key] ?? key });
    for (const v of vals) {
      valueNode(v);
      edge({
        from: `topic:${key}`,
        to: v.id,
        kind:
          v.status === "approved"
            ? "agreed"
            : v.superseded
              ? "earlier"
              : "on record",
      });
      for (const c of v.claims) {
        const src = docs.get(c.sourceId);
        docNode(src);
        edge({
          from: `doc:${src.id}`,
          to: v.id,
          kind: c.status,
          evidence: span(c),
        });
      }
    }
    const current = vals.filter((v) => v.current);
    for (const v of vals.filter((x) => x.superseded))
      for (const c of current)
        edge({ from: c.id, to: v.id, kind: "supersedes" });
    for (let i = 0; i < current.length; i++)
      for (let j = i + 1; j < current.length; j++)
        if (current[i].competing)
          edge({
            from: current[i].id,
            to: current[j].id,
            kind: "competes with",
          });
  } else if (level === "value") {
    const field = key.split(":")[0];
    const v = (sem.get(field) ?? []).find((x) => x.id === focus);
    crumbs.push(
      { id: `topic:${field}`, label: TOPIC_LABEL[field] ?? field },
      { id: focus, label: v?.label ?? key },
    );
    if (v) {
      valueNode(v);
      for (const c of v.claims) {
        const src = docs.get(c.sourceId);
        const evId = `evidence:${claimKey(c)}`;
        node({
          id: evId,
          kind: "evidence",
          label: c.quote.replace(/^\s*\d+\.\s*/, ""),
          status: c.status,
          evidence: span(c),
          weight: (lineCites.get(claimKey(c)) ?? []).length,
        });
        edge({ from: v.id, to: evId, kind: c.status, evidence: span(c) });
        docNode(src);
        edge({ from: evId, to: `doc:${src.id}`, kind: "in" });
        for (const e of eps.filter((e) =>
          e.cited.some(
            (x) =>
              x.sourceId === c.sourceId && x.start <= c.end && x.end >= c.start,
          ),
        )) {
          qNode(e);
          edge({ from: `q:${e.id}`, to: evId, kind: "cited" });
        }
      }
    }
  } else if (level === "doc") {
    const src = docs.get(key);
    if (src) {
      docNode(src);
      crumbs.push({ id: focus, label: shortTitle(src.title) });
      for (const [f, vals] of sem)
        for (const v of vals)
          for (const c of v.claims.filter((c) => c.sourceId === key)) {
            topicNode(f);
            valueNode(v);
            edge({ from: `topic:${f}`, to: v.id, kind: "value" });
            edge({
              from: `doc:${key}`,
              to: v.id,
              kind: c.status,
              evidence: span(c),
            });
          }
    }
  } else if (level === "q") {
    const e = eps.find((x) => x.id === key);
    if (e) {
      qNode(e);
      crumbs.push({ id: focus, label: e.question.slice(0, 40) });
      for (const c of e.cited) {
        const src = docs.get(c.sourceId);
        if (!src) continue;
        const evId = `evidence:${c.sourceId}:${c.start}`;
        node({
          id: evId,
          kind: "evidence",
          label: c.quote.replace(/^\s*\d+\.\s*/, "").slice(0, 220),
          evidence: c,
        });
        edge({ from: `q:${e.id}`, to: evId, kind: "cited", evidence: c });
        docNode(src);
        edge({ from: evId, to: `doc:${src.id}`, kind: "in" });
      }
    }
  }
  // Edge weight: how often the two ends were cited together.
  for (const ed of edges)
    ed.weight =
      1 +
      Math.min(
        4,
        (nodes.get(ed.from)?.weight ?? 0) + (nodes.get(ed.to)?.weight ?? 0),
      ) /
        2;
  const seen = new Set();
  return {
    focus,
    crumbs,
    episodes: eps.length,
    nodes: [...nodes.values()],
    edges: edges.filter(
      (e) =>
        nodes.has(e.from) &&
        nodes.has(e.to) &&
        !seen.has(e.id) &&
        seen.add(e.id),
    ),
  };
}
