// Shows the pilot form only when the server has a recipient configured.
(async () => {
  const $ = (s) => document.querySelector(s);
  let status;
  try {
    status = await fetch("/api/public/pilot-contact", { credentials: "same-origin" }).then((r) => r.json());
  } catch {
    return;
  }
  if (!status?.open) return;
  $("#contact").hidden = false;
  $("#contact-closed").hidden = true;
  const form = $("#pilot-form");
  const out = $("#pilot-status");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const btn = form.querySelector("button");
    btn.setAttribute("aria-busy", "true");
    out.textContent = "Sending…";
    try {
      const r = await fetch("/api/public/pilot-contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ...d, consent: d.consent === "on", ticket: status.ticket }),
      });
      const j = await r.json().catch(() => ({}));
      out.textContent = r.status === 202 ? "Thanks. Your message was delivered; we'll reply by email." : (j.error ?? "Something went wrong.");
      if (r.status === 202) form.reset();
    } catch {
      out.textContent = "Couldn't reach the server. Nothing was sent.";
    } finally {
      btn.removeAttribute("aria-busy");
    }
  });
})();
