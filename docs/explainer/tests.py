"""Manim explainers: one lab test, for someone who has never read a report.

Each scene follows the same six beats as the page's explainer:

    What is it? -> Why is it measured? -> What does my report say?
    -> Where does my result sit? -> What changed? -> What can't be concluded?

Every number is read from site/snapshot-visuals.js, the engine's own saved
output for the fictional SYN-0001 reports, so a scene can never show a value
the engine did not extract. A test the reports don't contain (LDL here) gets
the concept only and says there is no value to place.

Colour never works alone: green + dot = inside the lab's printed range,
coral + triangle = outside it (not "danger"), amber + diamond = not settled
(preliminary, corrected, or not comparable).

Rendered in CI (.github/workflows/explainer.yml):

    manim -qm docs/explainer/tests.py Ferritin Hemoglobin TSH Creatinine HbA1c LDL
"""
import json
import math
import textwrap
from pathlib import Path

from manim import (
    Scene, Text, VGroup, Line, Dot, Rectangle, Triangle, Square, Arrow,
    FadeIn, FadeOut, Write, Create, Transform, GrowFromEdge, Indicate,
    UP, DOWN, LEFT, RIGHT, ORIGIN, PI, rate_functions, config,
)

INK = "#161c2d"
INK2 = "#55607a"
PAPER = "#fbfaf2"
GREEN = "#2f9e6e"
CORAL = "#e0674b"
AMBER = "#c98a0b"
GREY = "#8a90a0"
SERIF = "DejaVu Serif"
SANS = "DejaVu Sans"
config.background_color = PAPER

ROOT = Path(__file__).resolve().parents[2]


def _snapshot():
    raw = (ROOT / "site" / "snapshot-visuals.js").read_text(encoding="utf8")
    body = raw[raw.index("{"): raw.rindex("}") + 1]
    data = json.loads(body)
    subject = next(
        s for s in data["health"]["visual"]["subjects"] if s["id"] == "SYN-0001"
    )
    return {t["key"]: t for t in subject["tests"]}


TESTS = _snapshot()
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()


def day(iso):
    y, m, d = iso.split("-")
    return f"{int(d)} {MONTHS[int(m) - 1]}"


# Plain-language background, paraphrased from MedlinePlus (the same text the
# page shows). General information, not from the report; not yet reviewed by
# a clinician.
PRIMER = {
    "ferritin": ("Ferritin", "iron storage",
                 "Your body keeps spare iron in storage, like a pantry. "
                 "Ferritin holds it, so the amount in blood hints at how full the pantry is.",
                 "To check whether the body's iron stores are low or high."),
    "hemoglobin": ("Hemoglobin", "oxygen carrier",
                   "Red blood cells are like delivery vans. Hemoglobin is the cargo space "
                   "that carries oxygen from your lungs to the rest of your body.",
                   "To see how well your blood can carry oxygen."),
    "tsh": ("TSH", "thyroid-stimulating hormone",
            "Think of a thermostat. A gland in the brain sends TSH to tell the thyroid "
            "how much hormone to make, like turning a dial.",
            "To check how the thyroid is working."),
    "creatinine": ("Creatinine", "muscle waste the kidneys clear",
                   "Working muscles make a little waste called creatinine every day. "
                   "The kidneys sieve it out of the blood.",
                   "To check how well the kidneys are filtering."),
    "hba1c": ("HbA1c", "3-month blood sugar average",
              "Sugar slowly sticks to red blood cells, like dust settling on a shelf. "
              "HbA1c measures how much has stuck over about three months.",
              "To look at blood sugar over time, not on a single day."),
    "ldl": ("LDL cholesterol", "cholesterol carried by LDL",
            "Cholesterol travels in the blood inside tiny carriers, like parcels in vans. "
            "LDL is one kind of van; the number is how much it carries.",
            "To help judge heart and blood vessel health."),
}


def txt(s, size=30, color=INK, font=SERIF, width=44, **kw):
    lines = textwrap.wrap(s, width) or [""]
    return Text("\n".join(lines), font_size=size, color=color, font=font,
                line_spacing=0.9, **kw)


def marker(state, size=0.22):
    """Shape and colour together: never colour alone."""
    if state == "in":
        return Dot(radius=size * 0.55, color=GREEN)
    if state == "above":
        return Triangle(color=CORAL, fill_opacity=1).scale(size * 0.7)
    if state == "below":
        return Triangle(color=CORAL, fill_opacity=1).scale(size * 0.7).rotate(PI)
    if state == "unsure":
        return Square(color=AMBER, fill_opacity=1).scale(size * 0.45).rotate(PI / 4)
    return Dot(radius=size * 0.5, color=GREY, fill_opacity=0).set_stroke(GREY, 3)


WORD = {
    "in": ("Inside the lab's printed range", GREEN),
    "above": ("Above the lab's printed range", CORAL),
    "below": ("Below the lab's printed range", CORAL),
    "unsure": ("Not settled yet", AMBER),
    "none": ("No printed range to read it against", GREY),
}


class Scale:
    """A number line in the report's own unit, linear or labelled log."""

    def __init__(self, values, lo_r, hi_r, x0=-5.4, x1=5.4, y=-0.6):
        pts = [v for v in values + [lo_r, hi_r] if v is not None and v > 0]
        lo, hi = min(pts), max(pts)
        self.log = lo > 0 and hi / lo >= 20
        f = math.log10 if self.log else (lambda v: v)
        a, b = f(lo), f(hi)
        pad = (b - a or abs(b) or 1) * 0.16
        self.a, self.b, self.f = a - pad, b + pad, f
        if not self.log and lo >= 0 and self.a < 0:
            self.a = 0
        self.x0, self.x1, self.y = x0, x1, y

    def x(self, v):
        return self.x0 + (self.f(v) - self.a) / (self.b - self.a) * (self.x1 - self.x0)

    def p(self, v):
        return [self.x(v), self.y, 0]

    def ticks(self, n=5):
        if self.log:
            out = []
            for e in range(math.floor(self.a) - 1, math.ceil(self.b) + 1):
                for k in (1, 2, 5):
                    v = k * 10 ** e
                    if self.a <= math.log10(v) <= self.b:
                        out.append(v)
            return out[:: max(1, len(out) // 7)]
        span = self.b - self.a
        raw = span / n
        mag = 10 ** math.floor(math.log10(raw))
        step = min((m * mag for m in (1, 2, 5, 10) if m * mag >= raw), default=mag)
        v = math.ceil(self.a / step) * step
        out = []
        while v <= self.b + 1e-9:
            out.append(round(v, 10))
            v += step
        return out


def fmt(v):
    return f"{v:g}"


class Explainer(Scene):
    key = None

    # ---- beats --------------------------------------------------------------
    def construct(self):
        self.t = TESTS.get(self.key)
        name, plain, analogy, why = PRIMER[self.key]
        self.beat_title(name, plain)
        self.beat_card("What is it?", analogy)
        self.beat_card("Why is it measured?", why,
                       foot="General background, not from your report. Source: MedlinePlus.")
        if not self.t:
            self.beat_card("What does my report say?",
                           f"These demo reports don't include {name}, "
                           "so there is no value to place on a scale.", color=GREY)
            self.wait(1.2)
            return
        self.beat_report()
        self.beat_scale()
        self.beat_change()
        self.beat_cant()

    def wipe(self, run_time=0.5):
        if self.mobjects:
            self.play(*[FadeOut(m, shift=UP * 0.15) for m in self.mobjects], run_time=run_time)

    def kicker(self, s):
        k = Text(s.upper(), font_size=20, color=INK2, font=SANS, weight="BOLD")
        return k.to_corner(UP + LEFT, buff=0.7)

    def beat_title(self, name, plain):
        title = Text(name, font_size=72, color=INK, font=SERIF)
        sub = Text(plain, font_size=30, color=INK2, font=SERIF).next_to(title, DOWN, buff=0.3)
        self.play(Write(title), run_time=1.0)
        self.play(FadeIn(sub, shift=UP * 0.2), run_time=0.6)
        self.wait(0.6)
        self.wipe()

    def beat_card(self, head, body, foot=None, color=INK):
        k = self.kicker(head)
        b = txt(body, 36, color, width=40).next_to(k, DOWN, buff=0.6).align_to(k, LEFT)
        group = [FadeIn(k, shift=RIGHT * 0.2), Write(b, run_time=1.6)]
        self.play(*group)
        if foot:
            f = Text(foot, font_size=20, color=INK2, font=SANS).to_edge(DOWN, buff=0.6)
            self.play(FadeIn(f), run_time=0.4)
        self.wait(1.4)
        self.wipe()

    def state(self):
        L = self.t["latest"]
        if L.get("status") == "preliminary":
            return "unsure"
        return {"within": "in", "above": "above", "below": "below"}.get(L.get("position"), "none")

    def beat_report(self):
        L, unit = self.t["latest"], self.t.get("unit") or ""
        k = self.kicker("What does my report say?")
        big = Text(L["raw"], font_size=120, color=INK, font=SERIF)
        u = Text(unit, font_size=40, color=INK2, font=SANS).next_to(big, RIGHT, buff=0.3).align_to(big, DOWN)
        meta = Text(f"{day(L['date'])} · {L.get('status', '')} report", font_size=26,
                    color=INK2, font=SANS).next_to(VGroup(big, u), DOWN, buff=0.4)
        self.play(FadeIn(k))
        self.play(FadeIn(big, scale=0.8), FadeIn(u), run_time=0.8)
        self.play(FadeIn(meta, shift=UP * 0.1), run_time=0.5)
        self.wait(1.0)
        self.wipe()

    def scale_for(self, hs, rng):
        vals = [h["value"] for h in hs if h.get("value") is not None]
        vals += [float(g["raw"]) for h in hs for g in h.get("superseded", [])]
        return Scale(vals, rng and rng.get("lowN"), rng and rng.get("highN"))

    def draw_scale(self, sc, rng, unit, y=None, small=False):
        if y is not None:
            sc.y = y
        line = Line([sc.x0 - 0.3, sc.y, 0], [sc.x1 + 0.3, sc.y, 0], color=INK, stroke_width=3)
        ticks = VGroup()
        for v in sc.ticks():
            ticks.add(Line([sc.x(v), sc.y - 0.08, 0], [sc.x(v), sc.y + 0.08, 0], color=INK))
            ticks.add(Text(fmt(v), font_size=18 if small else 20, color=INK2, font=SANS)
                      .move_to([sc.x(v), sc.y - 0.38, 0]))
        band = label = VGroup()
        if rng and rng.get("lowN") is not None and rng.get("highN") is not None:
            x0, x1 = sc.x(rng["lowN"]), sc.x(rng["highN"])
            band = Rectangle(width=max(0.05, x1 - x0), height=1.0 if small else 1.4,
                             color=GREEN, fill_color=GREEN, fill_opacity=0.10, stroke_width=2)
            band.move_to([(x0 + x1) / 2, sc.y, 0])
            label = Text(f"Lab's printed range {rng.get('low', fmt(rng['lowN']))}–"
                         f"{rng.get('high', fmt(rng['highN']))} {unit}",
                         font_size=20 if small else 24, color=GREEN, font=SERIF)
            label.next_to(band, UP, buff=0.12)
        log = Text("log scale", font_size=16, color=INK2, font=SANS).move_to([sc.x1, sc.y - 0.75, 0]) if sc.log else VGroup()
        return line, ticks, band, label, log

    def beat_scale(self):
        hs, unit = self.t.get("history") or [self.t["latest"]], self.t.get("unit") or ""
        L = self.t["latest"]
        k = self.kicker("Where does my result sit?")
        self.play(FadeIn(k))
        if self.t.get("unitChanged"):
            # one value, one scale, in its own unit: never one shared axis
            last = hs[-1]
            sc = self.scale_for([last], L.get("range"))
            parts = self.draw_scale(sc, L.get("range"), last.get("unit") or unit)
        else:
            sc = self.scale_for(hs, L.get("range"))
            parts = self.draw_scale(sc, L.get("range"), unit)
        line, ticks, band, label, log = parts
        self.play(Create(line), FadeIn(ticks), run_time=0.8)
        if len(band):
            self.play(GrowFromEdge(band, LEFT), FadeIn(label, shift=DOWN * 0.1), run_time=0.8)
        self.add(log)
        st = self.state()
        m = marker(st).move_to([sc.x0, sc.y + 0.55, 0])
        vtxt = Text(L["raw"], font_size=30, color=INK, font=SERIF)
        self.play(FadeIn(m))
        self.play(m.animate.move_to([sc.x(L["value"]), sc.y + 0.55, 0]),
                  rate_func=rate_functions.ease_in_out_cubic, run_time=1.2)
        vtxt.next_to(m, UP, buff=0.12)
        word, col = WORD[st]
        w = Text(word, font_size=30, color=col, font=SERIF).to_edge(DOWN, buff=1.1)
        self.play(FadeIn(vtxt), Write(w), run_time=0.9)
        if st in ("above", "below"):
            n = Text("Outside the printed range is a reason to ask, not by itself a sign of danger.",
                     font_size=20, color=INK2, font=SANS).next_to(w, DOWN, buff=0.2)
            self.play(FadeIn(n), run_time=0.5)
        self.wait(1.6)
        self.scale, self.dot = sc, m
        self.wipe()

    def beat_change(self):
        hs, t, unit = self.t.get("history") or [], self.t, self.t.get("unit") or ""
        k = self.kicker("What changed?")
        self.play(FadeIn(k))
        if t.get("corrected"):
            c = t["corrected"]
            old = Text(c["from"], font_size=90, color=AMBER, font=SERIF).shift(LEFT * 2.2)
            new = Text(c["to"], font_size=90, color=INK, font=SERIF).shift(RIGHT * 2.2)
            strike = Line(old.get_corner(DOWN + LEFT), old.get_corner(UP + RIGHT), color=AMBER, stroke_width=6)
            arrow = Arrow(old.get_right(), new.get_left(), color=AMBER, buff=0.3)
            cap = txt(f"{day(c['date'])}: first printed as {c['from']}, then corrected to {c['to']}. "
                      "A fix to the paper, not a change in your body.", 28, INK, width=48).to_edge(DOWN, buff=0.9)
            self.play(FadeIn(old))
            self.play(Create(strike), run_time=0.5)
            self.play(Create(arrow), FadeIn(new, shift=LEFT * 0.3), run_time=0.8)
            self.play(Write(cap), run_time=1.4)
            self.wait(1.4)
            self.play(*[FadeOut(m) for m in (old, new, strike, arrow, cap)], run_time=0.4)
        if len(hs) < 2:
            s = txt("Only one reading so far, so there is nothing to compare yet.", 32, GREY)
            self.play(Write(s))
            self.wait(1.2)
            self.wipe()
            return
        a, b = hs[-2], hs[-1]
        if t.get("unitChanged"):
            left = VGroup(Text(a["raw"], font_size=72, color=INK, font=SERIF),
                          Text(a.get("unit") or "", font_size=28, color=INK2, font=SANS)).arrange(DOWN)
            right = VGroup(Text(b["raw"], font_size=72, color=INK, font=SERIF),
                           Text(b.get("unit") or "", font_size=28, color=INK2, font=SANS)).arrange(DOWN)
            left.shift(LEFT * 3)
            right.shift(RIGHT * 3)
            neq = Text("≠", font_size=96, color=AMBER, font=SANS)
            cap = txt("Different units: the same amount reads as a different number. "
                      "So these two are not compared.", 28, INK, width=50).to_edge(DOWN, buff=0.9)
            self.play(FadeIn(left, shift=RIGHT * 0.3), FadeIn(right, shift=LEFT * 0.3))
            self.play(FadeIn(neq, scale=1.4), run_time=0.6)
            self.play(Write(cap), run_time=1.4)
        else:
            ch = (t.get("insight") or {}).get("change")
            sc = self.scale_for(hs, t["latest"].get("range"))
            line, ticks, band, label, log = self.draw_scale(sc, t["latest"].get("range"), unit, small=True)
            self.play(Create(line), FadeIn(ticks), FadeIn(band), FadeIn(label), run_time=0.7)
            dots = VGroup()
            for h in (a, b):
                d = Dot([sc.x(h["value"]), sc.y + 0.45, 0], radius=0.11,
                        color=INK if h is b else INK2)
                lab = VGroup(Text(h["raw"], font_size=24, color=INK, font=SERIF),
                             Text(day(h["date"]), font_size=18, color=INK2, font=SANS)).arrange(DOWN, buff=0.06)
                lab.next_to(d, UP, buff=0.12)
                dots.add(VGroup(d, lab))
            self.play(FadeIn(dots[0]), run_time=0.5)
            self.play(FadeIn(dots[1]), run_time=0.5)
            if ch and ch.get("bounded"):
                word = "Higher" if ch["direction"] == "higher" else "Lower"
                cap = txt(f"{word} than on {day(ch['fromDate'])}. That result was printed as "
                          f"“{ch['from']}”, a limit, not an exact number, so the size of the change "
                          "can't be worked out.", 26, INK, width=56).to_edge(DOWN, buff=0.8)
            elif ch:
                word = {"higher": "Higher", "lower": "Lower"}.get(ch["direction"], "About the same")
                cap = txt(f"{word} than on {day(ch['fromDate'])}: {ch['from']} → {ch['to']} {unit}.",
                          28, INK, width=56).to_edge(DOWN, buff=0.9)
            else:
                cap = txt("These two readings are not compared.", 28, AMBER).to_edge(DOWN, buff=0.9)
            self.play(Write(cap), run_time=1.3)
        self.wait(1.6)
        self.wipe()

    def beat_cant(self):
        k = self.kicker("What this can't tell you")
        items = ["Whether this matters for you: that depends on your history, symptoms and medicines."]
        if self.state() in ("above", "below"):
            items.append("A diagnosis: a value outside the printed range is not one by itself.")
        if self.t.get("unitChanged"):
            items.append("Which way it moved, because the units changed.")
        if ((self.t.get("insight") or {}).get("change") or {}).get("bounded"):
            items.append("The exact size of the change, because one value is a limit.")
        lines = VGroup(*[txt("— " + s, 28, INK, width=58) for s in items]).arrange(DOWN, aligned_edge=LEFT, buff=0.35)
        lines.next_to(k, DOWN, buff=0.6).align_to(k, LEFT)
        ask = Text("Ask your doctor what it means for you.", font_size=30, color=GREEN, font=SERIF).to_edge(DOWN, buff=0.9)
        self.play(FadeIn(k))
        for ln in lines:
            self.play(FadeIn(ln, shift=RIGHT * 0.2), run_time=0.6)
        self.play(Write(ask), run_time=0.9)
        self.wait(1.8)


class Ferritin(Explainer):
    key = "ferritin"


class Hemoglobin(Explainer):
    key = "hemoglobin"


class TSH(Explainer):
    key = "tsh"


class Creatinine(Explainer):
    key = "creatinine"


class HbA1c(Explainer):
    key = "hba1c"


class LDL(Explainer):
    key = "ldl"
