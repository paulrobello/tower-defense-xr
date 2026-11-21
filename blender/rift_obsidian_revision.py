"""Author and inspect the isolated second Rift obsidian coupon."""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_materials
import review_materials
import verify_materials
from materials import SURFACES
from surface_fields import Field, color, noise


def mineral_fields(slug: str, samples: int, tile_m: float) -> dict[str, Field]:
    if slug != "rift-obsidian":
        raise ValueError(slug)
    v, u = np.mgrid[:samples, :samples] / samples
    rng = np.random.default_rng(3229)
    first = np.full_like(u, np.inf)
    second, third = first.copy(), first.copy()
    tint = np.zeros_like(u)
    # A skewed metric produces unequal shards. The third-nearest face identifies
    # junctions independently of any one UV position, including the tile borders.
    centers: list[tuple[float, float]] = []
    while len(centers) < 77:
        x, y, face = rng.uniform(size=3)
        if any(
            ((x - px + 0.5) % 1 - 0.5) ** 2 + ((y - py + 0.5) % 1 - 0.5) ** 2 < 0.056**2
            for px, py in centers
        ):
            continue
        centers.append((x, y))
        dx, dy = (u - x + 0.5) % 1 - 0.5, (v - y + 0.5) % 1 - 0.5
        distance = (dx + 0.35 * dy) ** 2 + (0.86 * dy) ** 2
        third = np.minimum(third, np.maximum(second, distance))
        second = np.minimum(second, np.maximum(first, distance))
        tint = np.where(distance < first, face, tint)
        first = np.minimum(first, distance)
    fault = np.exp(-np.square((second - first) / 0.00043))
    away_from_junction = np.clip((third - second) / 0.00095, 0, 1)
    lamination = noise(u, v, 9, 7, 4241)
    mineral = noise(u, v, 17, 14, 971)
    grain = noise(u, v, 41, 37, 191)
    base = color((32, 23, 46), (75, 54, 95), 0.22 + 0.42 * tint + 0.10 * lamination)
    height = -0.034 * first - 0.000039 * fault + 0.000013 * mineral
    spacing = 2 * tile_m / samples
    du = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) / spacing
    dv = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) / spacing
    normal = np.stack((-du, -dv, np.ones_like(du)), axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    rough = 0.171 + 0.070 * tint + 0.018 * fault + 0.009 * grain
    inclusion = fault * away_from_junction * np.clip((mineral - 0.06) * 1.24, 0, 1)
    hue = np.clip(0.52 + 0.91 * lamination, 0, 1)
    emissive = inclusion[..., None] * color((81, 49, 118), (32, 128, 136), hue)
    return {
        "basecolor": base / 255,
        "normal": 0.5 + 0.5 * normal,
        "orm": np.stack((1 - 0.065 * fault, rough, np.zeros_like(u)), axis=-1),
        "emissive": emissive / 255,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["build", "verify", "review"])
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--ktx", type=Path, default=verify_materials.DEFAULT_KTX)
    parser.add_argument("--font", default="/System/Library/Fonts/Supplemental/Arial.ttf")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    directory = args.out.resolve()
    surfaces = {"rift-obsidian": SURFACES["rift-obsidian"]}
    if args.action == "build":
        build_materials.SURFACES = surfaces
        build_materials.channels = mineral_fields
        build_materials.build(directory)
    elif args.action == "review":
        review_materials.SURFACES = surfaces
        review_materials.render_review(directory, args.font)
    else:
        verify_materials.SURFACES = surfaces
        verify_materials.DEFAULT_KTX = args.ktx
        verify_materials.inspect(directory)
        quality = verify_materials.image_metrics(directory)
        (directory / "quality.json").write_text(json.dumps(quality, indent=2) + "\n")


if __name__ == "__main__":
    main()
