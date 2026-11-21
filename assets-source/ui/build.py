"""Build or check source-only UI candidates with Python 3.13 and Pillow 12.3.0."""

import argparse
import hashlib
import json
import math
import tempfile
from pathlib import Path
from subprocess import run

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

BASE = Path(__file__).resolve().parent
CELL = 128
CONTENT = 104


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pixels(box: list[float], size: tuple[int, int]) -> tuple[int, int, int, int]:
    left, top, right, bottom = box
    width, height = size
    return (
        math.floor(left * width),
        math.floor(top * height),
        math.ceil(right * width),
        math.ceil(bottom * height),
    )


def badge(source: Image.Image, matte: Image.Image, region: dict) -> Image.Image:
    rect = pixels(region["bounds"], source.size)
    art = source.crop(rect).convert("RGBA")
    provider_alpha = matte.crop(rect).getchannel("A")
    red, green, blue, _ = art.split()
    distance = ImageOps.invert(ImageChops.darker(ImageChops.darker(red, green), blue))
    # The remover can erase isolated glyphs on a sheet. White is the encoded sheet
    # background, including the deliberate counters in rank, target and star glyphs.
    edge = distance.point([min(255, value * 16) for value in range(256)])
    missing_ink = distance.point(
        [min(255, max(0, (value - 12) * 8)) for value in range(256)]
    )
    alpha = ImageChops.lighter(ImageChops.multiply(provider_alpha, edge), missing_ink)
    if "isolationPolygon" in region:
        clip = Image.new("L", art.size)
        points = [
            (round(x * source.width) - rect[0], round(y * source.height) - rect[1])
            for x, y in region["isolationPolygon"]
        ]
        ImageDraw.Draw(clip).polygon(points, fill=255)
        alpha = ImageChops.multiply(alpha, clip)
    art.putalpha(alpha)
    opaque = alpha.point([0] * 128 + [255] * 128)
    bbox = opaque.getbbox()
    if bbox is None:
        raise ValueError("Empty cutout")
    # Keep the antialiased contour outside the opaque bounds.
    x1, y1, x2, y2 = bbox
    art = art.crop(
        (
            max(0, x1 - 3),
            max(0, y1 - 3),
            min(art.width, x2 + 3),
            min(art.height, y2 + 3),
        )
    )
    art.thumbnail((CONTENT, CONTENT), Image.Resampling.LANCZOS)
    frame = Image.new("RGBA", (CELL, CELL))
    frame.paste(art, ((CELL - art.width) // 2, (CELL - art.height) // 2))
    # A thin titanium keyline holds dark silhouettes against the radial wheel.
    rim = Image.new("RGBA", frame.size, (181, 197, 207))
    rim.putalpha(frame.getchannel("A").filter(ImageFilter.MaxFilter(5)))
    return Image.alpha_composite(rim, frame)


def title(
    source: Image.Image, size: tuple[int, int], safe: list[float], strip: str
) -> Image.Image:
    scene = ImageOps.fit(source.convert("RGB"), size, method=Image.Resampling.LANCZOS)
    width, height = size
    # The scrim tapers away from the reserved typography area towards the subject.
    horizontal = strip == "desktop-title"
    length = width if horizontal else height
    curve = Image.new("L", (length, 1) if horizontal else (1, length))
    values = []
    for pixel in range(length):
        coord = pixel / (length - 1)
        t = (coord - safe[2]) / 0.17 if horizontal else (safe[1] - coord) / 0.13
        t = min(1.0, max(0.0, t))
        values.append(round(176 * (1 - t * t * (3 - 2 * t))))
    curve.putdata(values)
    return Image.composite(
        Image.new("RGB", size, (9, 13, 19)), scene, curve.resize(size)
    )


def build(out: Path) -> None:
    spec = json.loads((BASE / "layout.json").read_text())
    provenance = json.loads((BASE / "provenance.json").read_text())
    records = {row["key"]: row for row in provenance["outputs"]}
    regions = json.loads((BASE / "regions.json").read_text())
    source_size = (6 * CELL, 3 * CELL)
    atlas = Image.new("RGBA", source_size)
    (out / "icons").mkdir(parents=True, exist_ok=True)
    entries = {}
    for row, (sheet, ids) in enumerate(spec["sheets"].items()):
        record = records[sheet + "-alpha"]
        with (
            Image.open(BASE / records[sheet]["file"]) as source,
            Image.open(BASE / record["file"]) as matte,
        ):
            source.load()
            if "A" not in matte.getbands() or source.size != matte.size:
                raise ValueError(sheet + ": missing alpha")
            for col, key in enumerate(ids):
                icon = badge(source, matte, regions[key])
                x, y = col * CELL, row * CELL
                icon.save(out / "icons" / (key + ".png"), optimize=True)
                atlas.paste(icon, (x, y))
                entries[key] = {
                    "file": "icons/" + key + ".png",
                    "rect": [x, y, CELL, CELL],
                    "source": records[sheet]["file"],
                    "providerMatte": record["file"],
                    "sourceRect": list(pixels(regions[key]["bounds"], source.size)),
                }
    atlas.save(out / "tactical-atlas.png", optimize=True)
    metadata = {
        "atlas": "tactical-atlas.png",
        "width": atlas.width,
        "height": atlas.height,
        "origin": "top-left",
        "rectUnits": "pixels",
        "cellSize": CELL,
        "colorSpace": "sRGB",
        "alpha": "straight",
        "icons": entries,
        "radialActions": spec["radialActions"],
        "desktopActionBus": spec["desktopActionBus"],
        "states": spec["states"],
        "titles": {},
    }
    result = metadata["titles"]
    for key, surface in spec["titles"].items():
        size = (surface["width"], surface["height"])
        source = records[surface["sourceKey"]]["file"]
        with Image.open(BASE / source) as original:
            image = title(original, size, surface["textSafe"], key)
        filename = key + ".jpg"
        image.save(out / filename, quality=88, subsampling=0, optimize=True)
        result[key] = {
            "source": source,
            "file": filename,
            "size": list(size),
            "textSafe": list(pixels(surface["textSafe"], size)),
        }
    formatted = run(
        [
            "bun",
            "x",
            "--no-install",
            "biome",
            "format",
            "--stdin-file-path=assets-source/ui/candidates/atlas.json",
        ],
        cwd=BASE.parents[1],
        input=json.dumps(metadata, indent=2) + "\n",
        text=True,
        capture_output=True,
        check=True,
    )
    (out / "atlas.json").write_text(formatted.stdout, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Rebuild in a temporary directory and compare every candidate byte.",
    )
    args = parser.parse_args()
    dest = BASE / "candidates"
    if args.check:
        with tempfile.TemporaryDirectory() as folder:
            reference = Path(folder)
            build(reference)
            expected = {
                p.relative_to(reference): digest(p)
                for p in reference.rglob("*")
                if p.is_file()
            }
            actual = {
                p.relative_to(dest): digest(p) for p in dest.rglob("*") if p.is_file()
            }
            if actual != expected:
                raise ValueError("Candidate set differs from the deterministic build")
            print(f"{len(expected)} candidate files reproduced byte-for-byte.")
    else:
        build(dest)


if __name__ == "__main__":
    main()
