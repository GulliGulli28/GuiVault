"""Le premier plan de l'icône adaptative d'Android (docs/ANDROID.md).

Android découpe l'icône dans la zone centrale (~66 % du carré de 108 dp) :
le logo, mis tel quel par `cargo tauri icon`, y était tronqué et touchait
les bords. Ici : le logo source réduit à 62 % du carré, centré, pour chaque
densité. Usage : python3 scripts/android/icon-foreground.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "logo_GuiVault.png"
RES = ROOT / "app-tauri/gen/android/app/src/main/res"
SIZES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
SCALE = 0.62

logo = Image.open(SOURCE).convert("RGBA")
logo = logo.crop(logo.getbbox())
for density, size in SIZES.items():
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    side = round(size * SCALE)
    w, h = logo.size
    k = side / max(w, h)
    img = logo.resize((round(w * k), round(h * k)), Image.LANCZOS)
    canvas.paste(img, ((size - img.width) // 2, (size - img.height) // 2), img)
    out = RES / f"mipmap-{density}" / "ic_launcher_foreground.png"
    canvas.save(out, optimize=True)
    print(out.relative_to(ROOT), size)
