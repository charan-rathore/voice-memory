// Private pilot enquiries. OFF unless the owner configures a recipient:
//
//   VM_PILOT_WEBHOOK_URL   https URL that receives the enquiry as JSON
//                          (e.g. an email-forwarding or CRM webhook the owner
//                          controls). Never a public issue tracker.
//   VM_PILOT_WEBHOOK_TOKEN optional bearer sent to that URL
//
// GET  /api/public/pilot-contact        -> { open: boolean }  (the page shows
//                                          the form only when open)
// POST /api/public/pilot-contact        -> 202 delivered | 4xx | 503
//
// Minimal collection: name, work email, company, message (capped). No IP,
// user agent or cookies are forwarded or stored; nothing is logged except
// the outcome. Spam protection: a honeypot field, a minimum fill time
// signed by the server, same-origin writes, and a per-IP rate limit kept
// in memory as a hash only.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const MAX = { name: 80, email: 120, company: 120, message: 1000 };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,24}$/;

export function createPilotContact({
  webhookUrl = null,
  webhookToken = null,
  now = Date.now,
  fetchImpl = globalThis.fetch,
  minFillMs = 3000,
  perHour = 5,
} = {}) {
  const open = typeof webhookUrl === "string" && /^https:\/\//.test(webhookUrl);
  const key = randomBytes(32);
  const hits = new Map(); // sha(ip) -> [timestamps]
  const ticket = () => {
    const t = String(now());
    return `${t}.${createHmac("sha256", key).update(t).digest("base64url")}`;
  };
  const ticketAge = (s) => {
    const [t, sig] = String(s ?? "").split(".");
    if (!t || !sig) return null;
    const want = Buffer.from(
      createHmac("sha256", key).update(t).digest("base64url"),
    );
    const got = Buffer.from(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    return now() - Number(t);
  };
  const send = (res, status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
  };
  return async function handle(req, res, { ip, sameOrigin }) {
    if (req.method === "GET")
      return send(
        res,
        200,
        open ? { open: true, ticket: ticket() } : { open: false },
      );
    if (req.method !== "POST")
      return send(res, 405, { error: "Method not allowed." });
    if (!open)
      return send(res, 404, { error: "Pilot enquiries are not open yet." });
    if (!sameOrigin)
      return send(res, 403, { error: "Same-origin requests only." });
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > 8 * 1024) return send(res, 413, { error: "Too large." });
      chunks.push(c);
    }
    let d;
    try {
      d = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(res, 400, { error: "Send JSON." });
    }
    // Honeypot and fill time: accepted silently so bots learn nothing.
    const age = ticketAge(d.ticket);
    if (d.website || age === null || age < minFillMs || age > 3600_000)
      return send(res, 202, { delivered: true });
    const ipKey = createHash("sha256")
      .update(String(ip ?? ""))
      .digest("hex");
    const recent = (hits.get(ipKey) ?? []).filter((t) => now() - t < 3600_000);
    if (recent.length >= perHour)
      return send(res, 429, { error: "Too many enquiries. Try again later." });
    const f = {};
    for (const k of Object.keys(MAX))
      f[k] = typeof d[k] === "string" ? d[k].trim().slice(0, MAX[k]) : "";
    if (!f.name || !EMAIL.test(f.email) || !f.message)
      return send(res, 400, {
        error: "Name, a valid work email and a message are required.",
      });
    if (d.consent !== true)
      return send(res, 400, {
        error: "Please confirm you've read the privacy notice.",
      });
    recent.push(now());
    hits.set(ipKey, recent);
    if (hits.size > 10000) hits.delete(hits.keys().next().value);
    try {
      const r = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(webhookToken ? { authorization: `Bearer ${webhookToken}` } : {}),
        },
        body: JSON.stringify({
          kind: "voice-memory-pilot-enquiry",
          at: new Date(now()).toISOString(),
          ...f,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw Error(`recipient ${r.status}`);
    } catch {
      console.warn("pilot contact: delivery failed"); // never the content
      return send(res, 503, {
        error:
          "We couldn't deliver that right now. Nothing was stored; please try again later.",
      });
    }
    return send(res, 202, { delivered: true });
  };
}
