# Temporary public-source final-audit check

This is a proposed limited review route, not deployment approval. Do not merge PR76 or change production to use it. No private upload service or arbitrary public funded inference is included.

## What it checks

The fixed public Constitution and unchanged question use saved actual Gemini interpretation/read/reconstruction responses. Exactly one new Gemini final audit can be requested. This tests the new per-requirement uncertainty path, current dedicated-key health, and the hosted request/answer path. It is not a new five-call reader run or general semantic qualification. A rejected audit remains a valid failed check, never an excuse to retry.

## Default protection

`IS_PULL_REQUEST=true` routes the deployment entrypoint to an isolated server instead of importing production server/voice paths. Missing dedicated password or expiry returns503. Paid activation is off by default. Inherited production provider, Bolna and speech credentials are never consumed. Only public health and the login page are accessible without authentication. No upload, general ask, voice, speech or search route exists. A fixed empty run body is required; private text is rejected before any provider request.

## Activation checklist, only after scoped approval

1. Verify exact-head tests and review the startup diff. Keep production branch/settings unchanged. Verify Render Free compute and included usage, with no payment-method/overage exposure. Use manual PR preview only for the selected draft PR; do not enable automatic previews.
2. Build preview without a dedicated provider key or paid activation. Confirm its new URL and `/healthz` report `isolated-public-review`, no active inference. Never assume a frontend preview uses the new backend: existing Vercel rewrite targets production.
3. Set a dedicated password through secure secret handling, and a review deadline25minutes ahead. Test actual hosted sign-in boundary, unauthenticated denial, same-origin checks, fixed-body rejection and ordinary API/voice/upload denial while paid activation remains off. Preserve visual evidence.
4. Before creating any short-lived key, arrange the exact deadline cleanup. Create a dedicated non-resetting lifetime-limit key, at most$0.0495 and with provider backup expiry at most one hour after creation. The page and inference window still end25minutes after activation; disable the key immediately after the one attempt. Verify actual source evidence of approval first. Never reuse the main key or expired demo key. No top-ups or card changes.
5. Install only that key as `VM_REVIEW_API_KEY`; explicitly activate `VM_REVIEW_PAID=one-final-audit` only after hosted protection passes. The app checks key metadata before inference: non-resetting lifetime cap<=0.0495, remaining>=0.0476289, valid backup expiry at most one hour after server startup. Requests pin `google-ai-studio`, no fallback, model `google/gemini-3.8-flash`, JSON schema, max2500 output, no tools/search and maximum43232 prompt UTF-8 bytes plus1000 schema bytes. Reserve45232 input tokens including schema/framing, at$0.825/$4.125 perM input/output: ceiling$0.0476289. Provider lifetime cap is the hard restart-proof spend backstop. Refresh rates before execution; a changed rate/request or unverifiable cap blocks, not a reason to relax limits.
6. Request the fixed check once. A request is consumed before health/inference begins; concurrency shares one result; errors/timeout/rejection never retry. Save exact receipt/usage, source hash, status and actual pixels. Earlier responses remain explicitly labeled replayed.
7. Disable the dedicated key immediately after the single attempt and verify disabled state. Keep only the inert cached result for the remaining approved review window if useful. At the25-minute deadline, verify page denial and key disabled state, remove the selected preview label/instance and restore manual-preview setting to its prior state if no other work depends on it. Confirm production remains unchanged. Delete the cleanup wake only after confirming cleanup.

## Evidence so far

Offline five guard tests and actual mobile sign-in/run/display with mocked key/audit pass. No real key, hosted preview, final audit or live health is qualified by those mocks. A browser check found no-referrer policy suppressed login Origin; policy was fixed to same-origin and the actual browser path re-tested. Fixed source SHA256:4828afac3b1dc6e0a6f694259834ef774f16e926e86cafebdca374d3efaeb80b.

Sources checked9November2026:
- https://www.archives.gov/founding-docs/constitution-transcript
- https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://render.com/docs/service-previews#pull-request-previews-git-backed
- https://render.com/docs/free

Provider UI expiry adjustment: normal OpenRouter key UI has a one-hour minimum. No account-wide management key is created to work around it. The internal proposal was narrowed to a25-minute app window plus immediate disable after the single attempt and one-hour provider backup expiry; lifetime spend cap and user-approved audience/disclosure remain unchanged.
