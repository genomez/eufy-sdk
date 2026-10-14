# Modified for genomez S1 experimental source preview, 2026-10-14.
"""Generate deterministic synthetic pixel JPEG fixtures with the protocol wrapper."""
import base64
import sys
from PIL import Image
SYNTHETIC_SERIAL = b'v2_eufysecurity:T8000P00000000000:0000000000:'

def synthetic_image(w: int, h: int) -> Image.Image:
    """Create a deterministic gradient and color-block pattern from dimensions only."""
    img = Image.new('RGB', (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            r = x * 255 // (w - 1)
            g = y * 255 // (h - 1)
            b = (x + y) * 255 // (w + h - 2)
            if y // 12 % 4 == 0:
                r = min(255, r + 40)
            if 40 <= x < 120 and 30 <= y < 90:
                r, g, b = (200, 60, 60)
            px[x, y] = (r, g, b)
    return img

def main() -> None:
    """Write a synthetic fixture from dimensions, output path, quality and subsampling."""
    w, h, out = (int(sys.argv[1]), int(sys.argv[2]), sys.argv[3])
    quality = int(sys.argv[4]) if len(sys.argv) > 4 else 85
    subsampling = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    from io import BytesIO
    buf = BytesIO()
    synthetic_image(w, h).save(buf, format='JPEG', quality=quality, subsampling=subsampling)
    blob = SYNTHETIC_SERIAL + buf.getvalue()
    with open(out, 'w') as f:
        f.write(base64.b64encode(blob).decode())
    print(f'wrote {out}: {len(blob)} bytes ({w}x{h}, quality {quality}, subsampling {subsampling}, synthetic)')
if __name__ == '__main__':
    main()
