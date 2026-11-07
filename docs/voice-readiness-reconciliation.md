# Public demo voice readiness

After the initial connection, returning to a visible tab makes one uncached
`GET /api/public/status` request. Hidden events do nothing; visible events during
an in-flight refresh are ignored. The existing connection loop still owns cold
startup. No retry, interval, or polling timer is added by this reconciliation.

A boolean `voice.ready` updates the stored voice status and the existing
`syncVoiceClasses()` path. The existing CSS then hides the off notice and shows
call entry points when ready, or reverses both when not ready. Existing
bring-your-own-call-key behavior is preserved. Network/HTTP failures and missing
or invalid readiness leave the last known UI state unchanged. The request uses
the existing API helper's 8-second abort timeout and releases the in-flight guard
on success or failure.

The refresh does not start or stop calls, request microphone access, create
sessions, or invoke any paid action.

Run the focused regression using the repo's Playwright browser-test approach:

```sh
node tests/voice-readiness-ui-check.mjs
```

Requires the declared `playwright` dev dependency and Chromium (or `CHROME_PATH`).
It loads the real landing HTML/JS/CSS, intercepts all requests without starting an
engine, and covers both gate transitions, network/HTTP/malformed-status failures
in both UI states, hidden events, duplicate in-flight events, recovery, and the
absence of call/session/microphone side effects.

An owned SDK call keeps its existing stop controls visible if the refreshed
admission gate closes. Ending that call or expiring its setup deadline then
reconciles the classes again, so new-call controls do not remain enabled.
The active-call regression uses SDK/session/microphone stubs, verifies a reachable
Hang up control and one stop invocation, and checks that the preflight track was
released. It also covers readiness closing while SDK startup is pending and its
setup deadline expires. This is not proof of actual vendor media termination.
