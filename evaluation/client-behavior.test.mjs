// Client behavior harness: runs the REAL public/app.js call wiring against a
// stubbed DOM and a stubbed Bolna SDK. These are behavior tests, not source
// assertions: the reviewer asked for stubbed-SDK rejection, never-settling
// start, watchdog timeout and late-completion cleanup to be exercised for
// real. The 45s watchdog is driven with node:test mock timers.
import test, { mock } from "node:test";
import assert from "node:assert/strict";

const elements = new Map();
const el = (id) => {
  if (!elements.has(id)) {
    const target = {
      id,
      textContent: "",
      disabled: false,
      hidden: true,
      classList: { toggle() {}, add() {}, remove() {} },
      style: {},
      replaceChildren() {},
      append() {},
      appendChild() {},
      addEventListener() {},
      setAttribute() {},
      click() {},
      focus() {},
      remove() {},
    };
    elements.set(id, target);
  }
  return elements.get(id);
};

let sdkInstances = [];
let sdkStartImpl = async () => {};
class StubCall {
  constructor(opts) {
    this.opts = opts;
    this.handlers = {};
    this.stopped = false;
    sdkInstances.push(this);
  }
  on(e, f) {
    this.handlers[e] = f;
  }
  emit(e, arg) {
    this.handlers[e]?.(arg);
  }
  start() {
    return sdkStartImpl(this);
  }
  stop() {
    this.stopped = true;
  }
}

const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

let voiceLast = null;

async function boot() {
  elements.clear();
  sdkInstances = [];
  sdkStartImpl = async () => {};
  voiceLast = null;
  globalThis.window = globalThis;
  globalThis.BolnaWebCall = StubCall;
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.document = {
    getElementById: el,
    querySelectorAll: () => [],
    createElement: () => el("anon-" + Math.random()),
    createTextNode: (t) => t,
    addEventListener() {},
    head: { append() {} },
    body: { append() {} },
    hidden: false,
  };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u === "/api/session")
      return { ok: true, json: async () => ({ csrf: "t" }) };
    if (u === "/api/bolna-config")
      return { ok: true, json: async () => ({ configured: true }) };
    if (u === "/api/voice/start") return { ok: true, json: async () => ({}) };
    if (u === "/api/voice/last")
      return { ok: true, json: async () => ({ turn: voiceLast }) };
    return { ok: true, json: async () => ({ documents: [], turns: [] }) };
  };
  await import("../public/app.js?boot=" + Math.random());
  await flush();
  return {
    start: el("call-start"),
    end: el("call-end"),
    status: el("call-status"),
  };
}

test("mint failure (SDK start rejects, e.g. HTTP 503) surfaces and re-enables", async () => {
  const ui = await boot();
  sdkStartImpl = async () => {
    throw Error("Session mint failed: HTTP 503");
  };
  await ui.start.onclick();
  await flush();
  assert.match(ui.status.textContent, /503/);
  assert.equal(ui.start.disabled, false);
  assert.equal(sdkInstances.length, 1);
});

test("never-settling start() is bounded by the 45s app watchdog", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const ui = await boot();
    sdkStartImpl = () => new Promise(() => {}); // never settles (hung getUserMedia)
    ui.start.onclick(); // never settles by design; the watchdog recovers the UI
    await flush();
    assert.equal(ui.start.disabled, true); // still preparing
    mock.timers.tick(45000);
    await flush();
    assert.match(ui.status.textContent, /timed out/i);
    assert.equal(ui.start.disabled, false);
    assert.equal(sdkInstances[0].stopped, true); // stale call closed
  } finally {
    mock.timers.reset();
  }
});

test("late resolution after timeout cannot reopen the call", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const ui = await boot();
    let resolveStart;
    sdkStartImpl = () => new Promise((r) => (resolveStart = r));
    ui.start.onclick();
    await flush();
    mock.timers.tick(45000);
    await flush();
    assert.match(ui.status.textContent, /timed out/i);
    const stale = sdkInstances[0];
    resolveStart(); // SDK finally resolves AFTER the attempt was invalidated
    await flush();
    assert.equal(stale.stopped, true);
    assert.match(ui.status.textContent, /timed out/i); // unchanged
    assert.equal(ui.start.disabled, false);
    assert.equal(ui.end.hidden, true);
  } finally {
    mock.timers.reset();
  }
});

test("double click during setup starts exactly one attempt", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const ui = await boot();
    sdkStartImpl = () => new Promise(() => {});
    ui.start.onclick();
    ui.start.onclick(); // must no-op
    await flush();
    assert.equal(sdkInstances.length, 1);
    mock.timers.tick(45000); // drain the watchdog so no real timer lingers
    await flush();
  } finally {
    mock.timers.reset();
  }
});

test("successful call-start cancels the watchdog", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const ui = await boot();
    sdkStartImpl = async function () {
      // SDK fires call-start shortly after start() is invoked.
      sdkInstances[0].emit("call-start");
    };
    await ui.start.onclick();
    await flush();
    assert.match(ui.status.textContent, /Live call in progress/);
    assert.equal(ui.end.hidden, false);
    mock.timers.tick(120000); // long after the deadline: no timeout fires
    await flush();
    assert.match(ui.status.textContent, /Live call in progress/);
  } finally {
    mock.timers.reset();
  }
});

test("live call polls the owner feed over GET and marks the final render as last call", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const ui = await boot();
    sdkStartImpl = async function () {
      sdkInstances[0].emit("call-start");
    };
    await ui.start.onclick();
    await flush();
    // New call: pending state, never the previous call's turn.
    assert.equal(el("voice-turn").hidden, false);
    assert.match(el("voice-turn").textContent, /first verified turn of this call/i);
    // A verified turn lands server-side; the 3s poll renders it with its
    // verdict and the turn's own timestamp - never "just now".
    voiceLast = {
      spokenTurn: {
        verdict: "PROPOSED",
        spoken: "$42,000 is the latest proposal, and it is not approved.",
        at: 1730000000000,
        citations: [],
      },
    };
    mock.timers.tick(3000);
    await flush();
    assert.match(el("voice-turn").textContent, /^Last verified turn \(PROPOSED, /);
    assert.match(el("voice-turn").textContent, /\$42,000 is the latest proposal/);
    assert.doesNotMatch(el("voice-turn").textContent, /just now/i);
    // Call end: one final render, explicitly marked as the last call's.
    sdkInstances[0].emit("call-end");
    await flush();
    assert.match(el("voice-turn").textContent, /^Final verified turn of the last call/);
    // Owner-initiated End takes its own path (the SDK handler is skipped by
    // design); it must still land the same final, marked render.
    sdkStartImpl = async function () {
      sdkInstances[sdkInstances.length - 1].emit("call-start");
    };
    await ui.start.onclick();
    await flush();
    mock.timers.tick(3000);
    await flush();
    ui.end.onclick();
    await flush();
    assert.match(el("voice-turn").textContent, /^Final verified turn of the last call/);
  } finally {
    mock.timers.reset();
  }
});
