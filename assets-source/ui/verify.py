"""Verify P3-T2 sources, references, runtime candidates, review files, and atlas fidelity."""

import hashlib
import json
from pathlib import Path
from typing import cast

from PIL import Image

BASE = Path(__file__).resolve().parent
CANDIDATES = BASE / "candidates"
SHEETS = {"build-wave", "commands", "targets-stars"}
MODELS = {
    "nano_banana_pro": 2,
    "cinematic_studio_2_5": 2,
    "image_background_remover": 1,
}


def require(value: bool, message: str) -> None:
    if not value:
        raise ValueError(message)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def luminance(rgb: tuple[int, int, int]) -> float:
    def linear(v: int) -> float:
        s = v / 255
        return s / 12.92 if s <= 0.04045 else ((s + 0.055) / 1.055) ** 2.4

    return sum(
        weight * linear(v)
        for weight, v in zip((0.2126, 0.7152, 0.0722), rgb, strict=True)
    )


def rgb_pixels(image: Image.Image) -> tuple[tuple[int, int, int], ...]:
    require(image.mode == "RGB", "RGB pixels required for contrast measurement")
    return cast(tuple[tuple[int, int, int], ...], image.get_flattened_data())


def contrast(a: float, b: float) -> float:
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def verify_sources() -> None:
    manifest = json.loads((BASE / "provenance.json").read_text())
    outputs = manifest["outputs"]
    rows = {r["key"]: r for r in outputs}
    expected = (
        SHEETS
        | {s + "-alpha" for s in SHEETS}
        | {"desktop-title", "desktop-alt", "quest-title"}
    )
    require(
        rows.keys() == expected and len(expected) == len(outputs),
        "Provider job coverage",
    )
    require(len({r["jobId"] for r in outputs}) == len(outputs), "Duplicate generation")
    board = next(
        r
        for r in json.loads((BASE.parent / "concepts/provenance.json").read_text())[
            "outputs"
        ]
        if r["key"] == "bastion-rib"
    )
    require(
        digest(BASE.parent / "concepts" / board["file"]) == board["sha256"],
        "Approved board hash",
    )
    for k, r in rows.items():
        path = BASE / r["file"]
        require(
            path.parent == BASE / "originals"
            and path.stat().st_size == r["bytes"]
            and digest(path) == r["sha256"],
            k + ": original bytes",
        )
        with Image.open(path) as im:
            im.load()
            require(
                im.size == (r["width"], r["height"]) and im.format == r["format"],
                k + ": original decode",
            )
            if k.endswith("-alpha"):
                require("A" in im.getbands(), k + ": missing cutout alpha")
        parent = rows[k.removesuffix("-alpha")] if k.endswith("-alpha") else board
        reference_file = (
            parent["file"] if k.endswith("-alpha") else "../concepts/" + parent["file"]
        )
        require(
            r["references"]
            == [
                {
                    "jobId": parent["jobId"],
                    "file": reference_file,
                    "sha256": parent["sha256"],
                }
            ],
            k + ": reference mismatch",
        )
        model = (
            "image_background_remover"
            if k.endswith("-alpha")
            else "nano_banana_pro"
            if k in SHEETS
            else "cinematic_studio_2_5"
        )
        require(
            r["model"] == model
            and r["quotedCredits"] == r["chargedCredits"] == MODELS[model],
            k + ": model or billing",
        )
        if not k.endswith("-alpha"):
            require(
                bool(r["prompt"].strip()) and r["settings"]["resolution"] == "2k",
                k + ": generator settings",
            )
    require(
        {p.name for p in (BASE / "originals").iterdir()}
        == {Path(r["file"]).name for r in outputs},
        "Unregistered original",
    )
    require(
        sum(r["chargedCredits"] for r in outputs)
        == manifest["billing"]["chargedCredits"],
        "Batch billing",
    )


def verify() -> None:
    verify_sources()
    sums = json.loads((BASE / "checksums.json").read_text())
    names = {
        str(p.relative_to(BASE))
        for folder in ("candidates", "review")
        for p in (BASE / folder).rglob("*")
        if p.is_file()
    } | {"layout.json", "regions.json", "provenance.json"}
    require(names == sums.keys(), "Candidate or review inventory drift")
    for name, sha in sums.items():
        require(digest(BASE / name) == sha, name + ": SHA-256")
    meta = json.loads((CANDIDATES / "atlas.json").read_text())
    layout = json.loads((BASE / "layout.json").read_text())
    ids = [key for row in layout["sheets"].values() for key in row]
    require(
        len(ids) == len(set(ids)) == 18 and set(meta["icons"]) == set(ids),
        "Icon inventory",
    )
    require(
        len(layout["radialActions"]) == 9 and len(layout["desktopActionBus"]) == 6,
        "Control coverage",
    )
    for contract in ("radialActions", "desktopActionBus", "states"):
        require(meta[contract] == layout[contract], contract + ": mapping mismatch")
    atlas = Image.open(CANDIDATES / meta["atlas"])
    require(atlas.mode == "RGBA" and atlas.size == (768, 384), "Atlas dimensions")
    backgrounds = [(21, 28, 37), (211, 217, 221)]
    min_visible = 24 * 24
    for i, key in enumerate(ids):
        entry = meta["icons"][key]
        x, y, w, h = entry["rect"]
        require(
            (x, y, w, h) == ((i % 6) * 128, (i // 6) * 128, 128, 128),
            key + ": atlas cell",
        )
        with Image.open(CANDIDATES / entry["file"]) as icon:
            icon.load()
            require(
                icon.size == (128, 128) and icon.mode == "RGBA", key + ": icon format"
            )
            require(
                icon.tobytes() == atlas.crop((x, y, x + w, y + h)).tobytes(),
                key + ": packed pixels",
            )
            alpha = icon.getchannel("A")
            bounds = alpha.getbbox()
            require(
                bounds is not None
                and min(bounds[:2]) >= 7
                and max(bounds[2:]) <= 121
                and alpha.getextrema() == (0, 255),
                key + ": alpha and gutters",
            )
            small = icon.resize((24, 24), Image.Resampling.LANCZOS)
            for bg in backgrounds:
                comp = Image.new("RGB", small.size, bg)
                comp.paste(small, mask=small.getchannel("A"))
                visible = sum(
                    contrast(luminance(pixel), luminance(bg)) >= 3
                    for pixel in rgb_pixels(comp)
                )
                require(visible >= 12, key + ": insufficient visible pixels at 24 px")
                min_visible = min(min_visible, visible)
    print(
        f"18 RGBA badges equal their atlas cells; each has ≥{min_visible} pixels at ≥3:1 contrast at 24 px on both review fields."
    )
    for key in ("desktop-title", "quest-title"):
        item = meta["titles"][key]
        src = layout["titles"][key]
        with Image.open(CANDIDATES / item["file"]) as pic:
            pic.load()
            require(
                pic.size == (src["width"], src["height"]), key + ": title dimensions"
            )
            safe = pic.crop(tuple(item["textSafe"])).convert("RGB")
            worst = contrast(1.0, max(luminance(px) for px in rgb_pixels(safe)))
            require(worst >= 4.5, key + ": white typography contrast")
            print(
                f"{key}: {pic.width}×{pic.height}, minimum white-on-image contrast throughout text-safe area {worst:.2f}:1."
            )
    print(
        f"Verified 9 provider originals/references and {len(sums)} candidate, review, and manifest hashes."
    )


if __name__ == "__main__":
    verify()
