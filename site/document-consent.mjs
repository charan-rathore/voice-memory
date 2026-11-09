// Loaded only when the server advertises document reading.
export function createReaderConsent(state, $) {
  $("#askbar").insertAdjacentHTML(
    "beforebegin",
    `<section id="document-consent" class="document-consent" aria-label="Cloud document reading" hidden>
              <label><input type="checkbox" id="document-ai-consent" /> <b>Use cloud reading for this document set</b></label>
              <p id="document-consent-detail"></p>
              <p class="dim">Off uses source lookup only. Cloud answers can be wrong; check the citations. This does not enable phone calls, audio uploads or spoken playback.</p>
              <p id="document-consent-state" role="status"></p>
            </section>`,
  );
  const style = document.createElement("style");
  style.textContent =
    "\n.document-consent {\n  padding: 1rem;\n  margin: 1rem 0;\n  border: 1px solid var(--line, #777);\n  border-radius: 12px;\n  font-size: 0.9rem;\n  overflow-wrap: anywhere;\n}\n.document-consent label {\n  display: flex;\n  align-items: flex-start;\n  gap: 0.6rem;\n  cursor: pointer;\n}\n.document-consent input {\n  flex: 0 0 auto;\n  margin-top: 0.25rem;\n  width: 1.15rem;\n  height: 1.15rem;\n}\n.document-consent p {\n  margin: 0.6rem 0 0;\n  line-height: 1.5;\n}\n";
  document.head.append(style);
  function readerScope() {
    return JSON.stringify([
      state.ws,
      state.bundleGeneration,
      state.semantic?.documentReader?.provider,
      state.semantic?.model,
    ]);
  }
  function resetReaderConsent() {
    if (state.aiConsent) {
      state.askSeq++;
      const btn = $(".ask-go");
      if (btn) btn.disabled = false;
    }
    state.aiConsent = false;
    state.aiConsentScope = null;
    const checkbox = $("#document-ai-consent");
    if (checkbox) checkbox.checked = false;
  }
  function syncReaderConsent() {
    const box = $("#document-consent"),
      checkbox = $("#document-ai-consent");
    if (!box || !checkbox) return;
    const advertised = state.semantic?.documentReader?.enabled === true;
    const ready =
      !!state.ws &&
      state.bundleGeneration !== null &&
      !!state.cases.own?.ready &&
      state.wsDocs.every((d) =>
        ["ready", "needs_review", "failed"].includes(d.status),
      );
    if (!advertised || !ready || state.aiConsentScope !== readerScope())
      resetReaderConsent();
    box.hidden = state.case !== "own" || !advertised;
    checkbox.disabled = !ready;
    checkbox.checked = state.aiConsent;
    $("#document-consent-detail").textContent =
      `Your question and the complete text of this document set (or the selected record) will be sent to ${state.semantic?.documentReader?.provider ?? "the model provider"} using ${state.semantic?.model ?? "the configured model"}, for an answer and a separate check. Permission lasts only in this tab for this unchanged set.`;
    $("#document-consent-state").textContent = !ready
      ? "Wait for these uploads to finish before choosing cloud reading."
      : state.aiConsent
        ? "Cloud reading allowed for typed questions on this document set. Uncheck to stop future requests."
        : "Cloud reading is off. No document text is sent to the model for typed questions.";
  }
  $("#document-ai-consent")?.addEventListener("change", (e) => {
    if (e.target.checked && !e.target.disabled) {
      state.aiConsent = true;
      state.aiConsentScope = readerScope();
    } else resetReaderConsent();
    // A response started under the previous permission state must not
    // replace the current answer after the visitor changes their choice.
    state.askSeq++;
    $(".ask-go").disabled = false;
    syncReaderConsent();
  });

  return {
    request() {
      const allowed = state.aiConsent && state.aiConsentScope === readerScope();
      return {
        semantic: !!allowed,
        documentConsent: allowed
          ? {
              generation: state.bundleGeneration,
              provider: state.semantic?.documentReader?.provider,
              model: state.semantic?.model ?? null,
            }
          : undefined,
      };
    },
    reset: resetReaderConsent,
    sync: syncReaderConsent,
  };
}
