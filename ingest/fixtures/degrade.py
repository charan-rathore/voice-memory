# Deterministic degradations of printed.png (run after build.mjs):
#   degraded.png  - heavy: quarter resolution, 3.5 deg skew, blur, strong noise
#   skewed.png    - mild: third resolution, 2 deg skew, light blur and noise
import random
from PIL import Image, ImageFilter
def make(out, scale, angle, blur, noise, seed):
    random.seed(seed)
    im = Image.open("ingest/fixtures/files/printed.png").convert("L")
    im = im.resize((im.width // scale, im.height // scale), Image.BILINEAR)
    im = im.rotate(angle, expand=True, fillcolor=255)
    im = im.filter(ImageFilter.GaussianBlur(blur))
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            px[x, y] = max(0, min(255, px[x, y] + random.randint(-noise, noise)))
    im.save("ingest/fixtures/files/" + out)
make("degraded.png", 4, 3.5, 1.1, 70, 7)
make("skewed.png", 3, 2.0, 0.5, 25, 11)
