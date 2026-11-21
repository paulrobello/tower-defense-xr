"""Antialiased branching fissures drawn in shared chart space, authored as linear coverage."""

import itertools
from pathlib import Path

import numpy as np
from build_materials import png
from core_bastion import sha


def crack_map(out: Path, parts: list, size: int) -> dict:
    coverage = np.zeros((size, size), dtype=np.float32)
    probes = []
    for i, part in enumerate(parts):
        if not part.name.startswith(
            (
                "Swept crest",
                "Temple blade",
                "Abdominal shingle",
                "Outer blade",
                "Pleural shield",
                "Frontal keel",
                "Forearm vambrace",
                "Descending thigh",
            )
        ):
            continue
        rng = np.random.default_rng(3891 + i)
        x0, y0, x1, y1 = np.asarray(part.uv) * size
        width, height = x1 - x0, y1 - y0

        def stroke(
            points: list, diameter: float, x0=x0, y0=y0, width=width, height=height
        ):
            for (ax, ay), (bx, by) in itertools.pairwise(points):
                ax = x0 + ax * width
                bx = x0 + bx * width
                ay = y0 + ay * height
                by = y0 + by * height
                xlo = max(0, int(min(ax, bx) - diameter))
                xhi = min(size, int(max(ax, bx) + diameter + 1))
                ylo = max(0, int(min(ay, by) - diameter))
                yhi = min(size, int(max(ay, by) + diameter + 1))
                y, x = np.mgrid[ylo:yhi, xlo:xhi]
                dx, dy = bx - ax, by - ay
                t = np.clip(
                    ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / (dx * dx + dy * dy),
                    0,
                    1,
                )
                dist = np.hypot(x + 0.5 - ax - t * dx, y + 0.5 - ay - t * dy)
                window = coverage[ylo:yhi, xlo:xhi]
                np.maximum(
                    window, np.clip(diameter * 0.5 + 0.5 - dist, 0, 1), out=window
                )

        # Two independent tributary systems wrap the visible and far sides of each plate.
        for center in (0.22, 0.70):
            spine = [
                (
                    center + 0.064 * np.sin(j * 0.82 + i) + rng.uniform(-0.028, 0.028),
                    0.10 + j * 0.082,
                )
                for j in range(11)
            ]
            radius = max(1.9, min(5.2, width * 0.0105))
            stroke(spine, radius)
            for j in (2, 4, 6, 8):
                a, b = spine[j]
                k = -1 if j % 4 else 1
                branch = [
                    (a, b),
                    (a + k * 0.041, b + 0.028),
                    (a + k * 0.066, b + 0.019),
                    (a + k * 0.11, b + 0.085),
                ]
                stroke(branch, radius * 0.68)
                stroke(
                    [branch[2], (a + k * 0.074, b - 0.036), (a + k * 0.10, b - 0.056)],
                    radius * 0.41,
                )
            if part.name == "Swept crest L" and center == 0.22:
                x, y = spine[5]
                probes.append(
                    {
                        "surface": "crest fracture trunk",
                        "x": int(x0 + x * width),
                        "y": size - 1 - int(y0 + y * height),
                        "rgb": [255] * 3,
                        "tolerance": 19,
                    }
                )
        if part.name == "Swept crest L":
            probes.append(
                {
                    "surface": "intact crest",
                    "x": int(x0 + 0.45 * width),
                    "y": size - 1 - int(y0 + 0.5 * height),
                    "rgb": [0] * 3,
                    "tolerance": 8,
                }
            )
    srgb = np.where(
        coverage <= 0.0031308, 12.92 * coverage, 1.055 * coverage ** (1 / 2.4) - 0.055
    )
    encoded = np.rint(srgb * 255).astype(np.uint8)
    for pr in probes:
        assert abs(int(encoded[size - 1 - pr["y"], pr["x"]]) - pr["rgb"][0]) < 3, pr
    png(out / "phase2-cracks.png", np.repeat(encoded[:, :, None], 3, axis=2), True)
    assert len(probes) == 2
    return {
        "samples": probes,
        "sha256": sha(out / "phase2-cracks.png"),
        "bright_texels": int((coverage > 0.8).sum()),
        "antialiased_texels": int(((coverage > 0) & (coverage < 1)).sum()),
    }
