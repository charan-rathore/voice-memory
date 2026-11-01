// Browser check for conversational voice notes.
//
// Speech in and out is replaced with deterministic fakes (headless Chromium
// has no microphone and no voices), and /api/query is delayed per question so
// the SECOND note's answer arrives FIRST. The check proves:
//   1. every note is acknowledged immediately, before its answer exists;
//   2. answers are computed in parallel (both requests in flight at once);
//   3. playback is still in note order, and the early answer says it is queued;
//   4. starting a new recording interrupts speech and offers a replay;
//   5. with no voices at all, the answer is shown as text and says why.
import { chromium } from "playwright";
import { server } from "../src/server.mjs";

await new Promise((r) => server.listen(4318, "127.0.0.1", r));
const fail = (m) => {
  throw Error(m);
};
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    args: ["--no-sandbox"],
  });

  async function open({ voices }) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
    });
    await page.addInitScript((voices) => {
      window.__spoken = [];
      // Every state transition of every note card, in order.
      window.__log = [];
      new MutationObserver((ms) => {
        for (const m of ms) {
          const li = m.target;
          const last = window.__log.at(-1);
          const n = [...(li.parentNode?.children ?? [])].indexOf(li) + 1;
          if (last && last[0] === n && last[1] === li.dataset.state) continue;
          if (li.matches?.("#notes > li"))
            window.__log.push([
              [...li.parentNode.children].indexOf(li) + 1,
              li.dataset.state,
            ]);
        }
      }).observe(document, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-state"],
      });
      window.__cancelled = 0;
      let current = null;
      class U {
        constructor(text) {
          this.text = text;
        }
      }
      const synth = {
        getVoices: () => voices.map((lang) => ({ lang, name: "fake " + lang })),
        speak(u) {
          current = u;
          window.__spoken.push({ text: u.text, lang: u.lang });
          u._t = setTimeout(() => {
            if (current === u) current = null;
            u.onend?.();
          }, window.__speechMs ?? 400);
        },
        cancel() {
          window.__cancelled++;
          if (current) {
            clearTimeout(current._t);
            const u = current;
            current = null;
            u.onerror?.({ error: "interrupted" });
          }
        },
      };
      Object.defineProperty(window, "speechSynthesis", {
        value: synth,
        configurable: true,
      });
      window.SpeechSynthesisUtterance = U;
      // A fake recognizer: start() then stop() yields the text in __nextSpeech.
      class FakeSR {
        start() {
          window.__rec = this;
        }
        stop() {
          const t = window.__nextSpeech ?? "";
          this.onresult?.({
            resultIndex: 0,
            results: [Object.assign([{ transcript: t }], { isFinal: true })],
          });
          this.onend?.();
        }
      }
      window.SpeechRecognition = FakeSR;
    }, voices);
    let inflight = 0;
    let peak = 0;
    await page.route("**/api/query", async (route) => {
      const q = JSON.parse(route.request().postData()).question;
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, /owns/i.test(q) ? 900 : 50));
      const res = await route.fetch();
      inflight--;
      await route.fulfill({ response: res });
    });
    page.on("pageerror", (e) => console.error("pageerror:", e.message));
    await page.goto("http://127.0.0.1:4318/");
    await page
      .getByRole("button", { name: "Try a clearly fictional project" })
      .click();
    await page.getByText("Documents ready. Ask a question above.").waitFor();
    const until = (n, ...states) =>
      page.waitForFunction(
        ([n, states]) =>
          window.__log.some(([i, st]) => i === n && states.includes(st)),
        [n, states],
        { timeout: 10000 },
      );
    return { page, peak: () => peak, until };
  }

  // --- 1-4: ordering, parallelism, acknowledgement, barge-in
  {
    const { page, peak, until } = await open({ voices: ["en-IN", "hi-IN"] });
    await page.evaluate(() => {
      window.vmNotes.add("Who owns the security review?"); // slow (900 ms)
      window.vmNotes.add("Was the budget approved?"); // fast
    });
    // Acknowledged at once, before any answer can exist.
    const cards = page.locator("#notes > li");
    if ((await cards.count()) !== 2)
      fail("expected two note cards immediately");
    for (const i of [0, 1]) {
      const s = await cards.nth(i).getAttribute("data-state");
      if (!["received", "thinking"].includes(s))
        fail(`note ${i + 1} not acknowledged first: ${s}`);
    }
    // Note 2's answer arrives first and says it is waiting for note 1.
    await until(2, "ready");
    const waiting = await cards.nth(1).locator(".note-state").textContent();
    if (!/after note 1/.test(waiting))
      fail("early answer did not say it is queued: " + waiting);
    if ((await page.evaluate(() => window.__spoken.length)) !== 0)
      fail("spoke note 2 before note 1");
    // Note 1 speaks, then note 2.
    await until(1, "speaking");
    await page.evaluate(() => (window.__speechMs = 60000)); // note 2 talks until interrupted
    await until(2, "speaking");
    const log = await page.evaluate(() =>
      window.__log.filter(([, st]) => st === "speaking").map(([i]) => i),
    );
    if (log.join() !== "1,2")
      fail(
        "speaking order " +
          JSON.stringify(await page.evaluate(() => window.__log)),
      );
    if (peak() < 2)
      fail("the two questions were not in flight at the same time");
    // Barge-in: recording while note 2 speaks stops it and offers a replay.
    await page.evaluate(
      () => (window.__nextSpeech = "And is the pilot launch approved?"),
    );
    await page.getByRole("button", { name: "Voice note" }).click();
    await until(2, "interrupted");
    await cards.nth(1).getByRole("button", { name: "Play it again" }).waitFor();
    await page.evaluate(() => (window.__speechMs = 400));
    await page.getByRole("button", { name: "Voice note" }).click(); // stop -> note 3
    await until(3, "done", "speaking");
    const order = await page.evaluate(() => window.__spoken.map((s) => s.text));
    if (order.length < 3)
      fail("expected three spoken answers, got " + order.length);
    const texts = await page.locator("#notes .note-text").allTextContents();
    if (order[0] !== texts[0] || order[1] !== texts[1])
      fail("playback order differs from note order");
    if (!(await page.evaluate(() => window.__cancelled)))
      fail("barge-in did not cancel speech");
    // A note in Devanagari goes through the same queue.
    await page.evaluate(() => window.vmNotes.add("क्या बजट मंज़ूर हुआ?"));
    await until(4, "done", "speaking");
    await page.screenshot({
      path: "/downloads/voice-notes.png",
      fullPage: true,
    });
    await page.close();
  }

  // --- 5: no voices -> text with reason
  {
    const { page, until } = await open({ voices: [] });
    await page.evaluate(() => window.vmNotes.add("Was the budget approved?"));
    await until(1, "done");
    const s = await page.locator("#notes .note-state").textContent();
    if (!/no voice available/.test(s))
      fail("no-voice fallback not explained: " + s);
    await page.close();
  }
  console.log(
    "notes-check: ok (ack, parallel, ordered playback, barge-in, no-voice fallback)",
  );
} finally {
  await browser?.close();
  server.close();
}
