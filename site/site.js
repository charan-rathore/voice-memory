// Voice Memory landing: one orchestrated hero replay + reveal-on-scroll.
// Every answer below is the current build's real output on the fictional
// Northstar documents (spoken renderer, dfd848e + vm2-ingestion).
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);

  // Paper lines are verbatim from corpus-md/ (marked spans only highlight).
  const TURNS = [
    {
      q: "Was the $42,000 revision finalized?",
      verdict: "Proposed, not approved",
      open: false,
      a: "$42,000 is the latest proposal, and it is not approved.",
      file: "03_Commercial_Revision.md",
      lines: [
        ["1. Following the narrower scope, ", "", "the revised fee is $42,000", "hl", ", with 40% payable upfront and 60% after acceptance."],
        ["2. The revised terms are subject to client finance sign-off; ", "", "they are a proposal until that sign-off is recorded", "hl", "."],
      ],
    },
    {
      q: "But wasn't it $48,000 earlier?",
      verdict: "Proposed, not approved",
      open: false,
      a: "Yes, the earlier record was $48,000. It was superseded by $42,000, which is still not approved.",
      file: "01_Northstar_Proposal_v1.md",
      lines: [
        ["1. Meridian Advisory proposes a customer analytics pilot for Northstar Retail across three retail regions (North, South, West) for a fixed engagement fee of ", "", "$48,000", "strike", "."],
        ["4. This proposal is an offer, not an agreement; it takes effect only on countersignature.", ""],
      ],
    },
    {
      q: "So finance rejected it?",
      verdict: "Proposed, not approved",
      open: false,
      a: "No record shows a rejection. Approval is pending, which is not the same thing.",
      file: "07_Internal_Action_Log.md",
      lines: [
        ["2. Open decision: final payment schedule (40/60 in the revision memo vs 50/50 in steering notes); ", "", "finance approval outstanding", "hl", "."],
        ["4. ", "", "No signed commercial agreement exists for the revised terms", "hl", ". Production launch authorization is not recorded."],
      ],
    },
    {
      q: "Was the 40/60 split approved?",
      verdict: "Still open: the records differ",
      open: true,
      a: "That is still open: 40/60 versus 50/50 are both on record, and it is not approved.",
      file: "04_Steering_Committee_Notes.md",
      lines: [
        ["2. The discussed payment structure was ", "", "50% upfront and 50% after acceptance", "hl", "; ", "", "no vote was taken on the payment schedule", "hl", "."],
        ["3. The committee noted that client finance had not yet signed off on any revised commercial terms.", ""],
      ],
    },
  ];

  // --- reveal on scroll ------------------------------------------------
  const reveal = document.querySelectorAll("[data-reveal]");
  if (!("IntersectionObserver" in window) || reduce) {
    reveal.forEach((n) => n.classList.add("on"));
  } else {
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add("on");
          io.unobserve(e.target);
          if (e.target.querySelector("#uploads")) runUploads();
        }),
      { threshold: 0.25, rootMargin: "0px 0px -8% 0px" },
    );
    reveal.forEach((n) => io.observe(n));
  }

  // --- upload stages ---------------------------------------------------
  let uploadsRan = false;
  function runUploads() {
    if (uploadsRan) return;
    uploadsRan = true;
    document.querySelectorAll("#uploads li").forEach((li, i) => {
      const steps = li.dataset.steps.split("|");
      const stage = li.querySelector(".stage");
      steps.forEach((s, k) => {
        setTimeout(
          () => {
            stage.textContent = s;
            const last = k === steps.length - 1;
            stage.classList.toggle("busy", !last);
            stage.classList.toggle("done", last);
          },
          reduce ? 0 : 500 + i * 380 + k * 900,
        );
      });
    });
  }
  if (reduce) runUploads();

  // --- hero replay -----------------------------------------------------
  const q = $("q");
  const ans = $("ans");
  const verdict = $("verdict");
  const a = $("a");
  const paper = $("paper");
  const paperName = $("paper-name");
  const pill = $("pill");
  const pillText = $("pill-text");
  if (!q) return;

  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  let run = 0;

  function renderPaper(t) {
    paperName.textContent = t.file;
    paper.replaceChildren(
      ...t.lines.map((parts) => {
        const p = document.createElement("p");
        for (let i = 0; i < parts.length; i += 2) {
          const text = parts[i];
          const cls = parts[i + 1];
          if (!text) continue;
          if (cls) {
            const s = document.createElement("span");
            s.className = cls;
            s.textContent = text;
            p.append(s);
          } else p.append(document.createTextNode(text));
        }
        return p;
      }),
    );
  }

  async function play(t, id) {
    pill.dataset.state = "listening";
    pillText.textContent = "Listening";
    ans.classList.remove("on");
    renderPaper(t);
    q.textContent = "";
    q.classList.add("typing");
    for (const ch of t.q) {
      if (id !== run) return;
      q.textContent += ch;
      await wait(ch === " " ? 55 : 38);
    }
    q.classList.remove("typing");
    await wait(450);
    if (id !== run) return;
    pill.dataset.state = "speaking";
    pillText.textContent = "Speaking";
    verdict.textContent = t.verdict;
    verdict.classList.toggle("open", t.open);
    a.textContent = t.a;
    ans.classList.add("on");
    await wait(350);
    paper.querySelectorAll(".hl, .strike").forEach((n) => n.classList.add("on"));
    await wait(Math.max(2600, t.a.length * 52));
    if (id !== run) return;
    pill.dataset.state = "idle";
    pillText.textContent = "Ready";
    await wait(700);
  }

  async function loop() {
    const id = ++run;
    if (reduce) {
      const t = TURNS[0];
      q.textContent = t.q;
      verdict.textContent = t.verdict;
      a.textContent = t.a;
      ans.classList.add("on");
      renderPaper(t);
      paper.querySelectorAll(".hl, .strike").forEach((n) => n.classList.add("on"));
      pill.dataset.state = "idle";
      pillText.textContent = "Replay paused (reduced motion)";
      return;
    }
    for (let i = 0; ; i = (i + 1) % TURNS.length) {
      if (id !== run) return;
      if (document.hidden) {
        await new Promise((r) => document.addEventListener("visibilitychange", r, { once: true }));
      }
      await play(TURNS[i], id);
    }
  }

  document.querySelectorAll('a[href="#demo"]').forEach((link) =>
    link.addEventListener("click", () => setTimeout(loop, reduce ? 0 : 450)),
  );
  loop();
})();
