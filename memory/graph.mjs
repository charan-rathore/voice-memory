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
    for (const c of list) {
      const id = valueId(f, c.value);
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
      node({ id: "topic:lab", kind: "topic", label: "Lab results" });
      docNode(src);
      edge({ from: `doc:${src.id}`, to: "topic:lab", kind: "records" });
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
