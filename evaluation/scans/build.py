"""A three-page lab report that mixes a digital page with two scans, one of
them degraded like a phone photo. Every patient, value and date is fictional;
the gold values below are the constants printed on the pages.

    python3 evaluation/scans/build.py   # writes page-2.png, page-3.png
    node evaluation/scans/build.mjs     # assembles mixed-quality.pdf
"""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import random

HERE = Path(__file__).parent
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

PATIENT = "Patient: Test Person G (synthetic), ID SYN-0007"
PAGES = {
    1: {"title": "Synthetic Diagnostics - Lipid & Kidney Panel",
        "dates": "Collected: 2 November 2026  Reported: 3 November 2026",
        "rows": [["Creatinine", "1.1", "mg/dL", "0.7-1.3", ""],
                 ["Urea", "31", "mg/dL", "7-20", "H"],
                 ["LDL Cholesterol", "162", "mg/dL", "0-100", "H"]]},
    2: {"title": "Synthetic Diagnostics - Haematology",
        "dates": "Collected: 2 November 2026  Reported: 3 November 2026",
        "rows": [["Hemoglobin", "11.4", "g/dL", "12.0-15.5", "L"],
                 ["Ferritin", "18", "ng/mL", "15-150", ""],
                 ["Platelets", "245", "10^3/uL", "150-450", ""]]},
    3: {"title": "Synthetic Diagnostics - Endocrine",
        "dates": "Collected: 2 November 2026  Reported: 3 November 2026",
        "rows": [["TSH", "6.8", "mIU/L", "0.40-4.00", "H"],
                 ["HbA1c", "5.9", "%", "4.0-5.6", "H"],
                 ["Vitamin D", "17", "ng/mL", "30-100", "L"]]},
}


def render(page, degrade):
    W, H = 2480, 3508  # A4 at 300 dpi
    im = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, 46)
    b = ImageFont.truetype(BOLD, 58)
    p = PAGES[page]
    y = 220
    d.text((180, y), p["title"], font=b, fill=0); y += 130
    d.text((180, y), PATIENT, font=f, fill=0); y += 80
    d.text((180, y), p["dates"], font=f, fill=0); y += 80
    d.text((180, y), "Report status: FINAL", font=f, fill=0); y += 160
    cols = [180, 880, 1240, 1640, 2160]
    for i, h in enumerate(["Test", "Result", "Unit", "Reference range", "Flag"]):
        d.text((cols[i], y), h, font=b, fill=0)
    y += 90
    d.line((180, y, 2300, y), fill=0, width=4); y += 40
    for r in p["rows"]:
        for i, c in enumerate(r):
            d.text((cols[i], y), c, font=f, fill=0)
        y += 100
    d.text((180, H - 260), f"Page {page} of 3", font=f, fill=0)
    if degrade:
        rnd = random.Random(7)
        im = im.rotate(1.6, fillcolor=235, expand=False)
        im = im.filter(ImageFilter.GaussianBlur(3.2))
        px = im.load()
        for _ in range(900000):
            x, yy = rnd.randrange(W), rnd.randrange(H)
            px[x, yy] = max(0, min(255, px[x, yy] + rnd.randint(-90, 90)))
        im = im.point(lambda v: 95 + v * 0.55)  # washed-out, low contrast
        im = im.resize((W // 2, H // 2))  # a phone photo, not 300 dpi
    return im


if __name__ == "__main__":
    render(2, False).save(HERE / "page-2.png")
    render(3, True).save(HERE / "page-3.png")
    (HERE / "gold.json").write_text(json.dumps(
        {"patient": "SYN-0007", "pages": PAGES}, indent=2) + "\n")
    print("wrote page-2.png, page-3.png, gold.json")
