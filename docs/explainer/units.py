"""Manim explainer: why Voice Memory won't compare 1.2 mg/dL with 106 umol/L.

Rendered in CI (.github/workflows/explainer.yml) to docs/media/units.mp4 and
docs/media/units.gif. Values are the fictional SYN-0001 reports used on the
landing page.

    manim -qm docs/explainer/units.py Units
"""
from manim import (
    Scene, Text, NumberLine, Dot, VGroup, Line, Cross, Arrow, FadeIn, FadeOut,
    Write, Create, Transform, UP, DOWN, LEFT, RIGHT, ORIGIN, smooth, there_and_back,
    rate_functions, config,
)

INK = "#161c2d"
PAPER = "#fbfaf2"
CORAL = "#e8735a"
TEAL = "#1f9e8f"
MARK = "#f4dc4a"
RED = "#c2412f"
SERIF = "Newsreader"
config.background_color = PAPER


def t(s, size=30, color=INK, **kw):
    return Text(s, font_size=size, color=color, font=SERIF, **kw)


class Units(Scene):
    def construct(self):
        q = t("“Has creatinine gone up since September?”", 34).to_edge(UP, buff=0.6)
        self.play(Write(q), run_time=1.4)

        # tick labels as plain Text (DecimalNumber would need LaTeX)
        sep = NumberLine(x_range=[0, 2, 0.5], length=5.2, color=INK)
        octl = NumberLine(x_range=[0, 160, 40], length=5.2, color=INK)
        sep.shift(LEFT * 3.3 + DOWN * 0.2)
        octl.shift(RIGHT * 3.3 + DOWN * 0.2)
        ticks = VGroup(
            *[t(f"{v:g}", 20).next_to(sep.n2p(v), DOWN, buff=0.15) for v in (0, 0.5, 1, 1.5, 2)],
            *[t(f"{v:g}", 20).next_to(octl.n2p(v), DOWN, buff=0.15) for v in (0, 40, 80, 120, 160)],
        )
        sl = t("3 Sept report · mg/dL", 24, CORAL).next_to(sep, UP, buff=0.5)
        ol = t("12 Oct report · µmol/L", 24, TEAL).next_to(octl, UP, buff=0.5)
        self.play(Create(sep), Create(octl), FadeIn(ticks), FadeIn(sl, shift=DOWN * 0.2), FadeIn(ol, shift=DOWN * 0.2))

        a = Dot(sep.n2p(0), color=CORAL, radius=0.11)
        b = Dot(octl.n2p(0), color=TEAL, radius=0.11)
        self.add(a, b)
        # each value travels to its place on its own scale (eased, not linear)
        self.play(a.animate.move_to(sep.n2p(1.2)), b.animate.move_to(octl.n2p(106)),
                  rate_func=rate_functions.ease_in_out_cubic, run_time=1.4)
        av = t("1.2", 32, CORAL).next_to(a, UP, buff=0.3)
        bv = t("106", 32, TEAL).next_to(b, UP, buff=0.3)
        self.play(FadeIn(av), FadeIn(bv))

        naive = Arrow(av.get_right() + RIGHT * 0.1, bv.get_left() + LEFT * 0.1, color=INK, buff=0.1, stroke_width=4)
        claim = t("“up 88×”", 28).next_to(naive, UP, buff=0.2)
        self.play(Create(naive), FadeIn(claim), run_time=1.0)
        self.wait(0.5)
        x = Cross(VGroup(naive, claim), stroke_color=RED, stroke_width=6)
        self.play(Create(x), run_time=0.6)
        self.wait(0.4)

        verdict = t("Won’t compare: different units. Both values stay on screen.", 30, RED)
        verdict.to_edge(DOWN, buff=0.9)
        why = t("Converting is the lab’s or the clinician’s call, not the assistant’s.", 24)
        why.next_to(verdict, DOWN, buff=0.25)
        self.play(FadeOut(VGroup(naive, claim, x)), Write(verdict), run_time=1.2)
        self.play(FadeIn(why, shift=UP * 0.15))
        # both dots pulse in place: shown, never joined
        self.play(a.animate.scale(1.6), b.animate.scale(1.6), rate_func=there_and_back, run_time=0.9)
        self.wait(1.6)
