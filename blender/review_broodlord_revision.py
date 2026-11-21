"""Bind the matched studio review to the revised receivers and the frozen failed round."""

import argparse
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import review_broodlord as studio
from package_core_bastion import digest, write_json


def main() -> None:
    parser = argparse.ArgumentParser()
    for n in ("piece", "original", "ktx"):
        parser.add_argument(f"--{n}", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece, original = args.piece.resolve(), args.original.resolve()
    out = piece / "review"
    prior = json.loads((original / "provenance.json").read_text())["files"]
    views = dict(studio.VIEWS, dorsal=((0.74, 1.30, 1.31), (0, 0, 0.41), 1.18))
    argv = sys.argv[: sys.argv.index("--") + 1] + [
        "--piece",
        str(piece),
        "--ktx",
        str(args.ktx),
    ]
    with patch.object(studio, "VIEWS", views), patch.object(sys, "argv", argv):
        studio.main()
    camera_path = out / "cameras.json"
    cams = json.loads(camera_path.read_text())
    old = json.loads((original / "review/cameras.json").read_text())
    for name in studio.VIEWS:
        assert cams["matched_views"][name] == old["matched_views"][name]
    glbs = {
        lod: digest(piece / f"apex-broodlord-{lod}.glb") for lod in ("lod0", "lod1")
    }
    assert len(cams["phase_proof"]) == 6 and all(
        row["warm_changed_pixels"] > 0 for row in cams["phase_proof"].values()
    )
    cams["reviewed_glb_sha256"] = glbs
    cams["reviewed_high_blend_sha256"] = digest(piece / "high.blend")
    cams["before_lod0_sha256"] = prior["apex-broodlord-lod0.glb"]
    rows = []
    for label, parent in (("Round 1", original), ("Revised", piece)):
        for name in ("oblique", "front", "flank"):
            still = f"review/lod0-{name}.png"
            if parent == original:
                assert digest(parent / still) == prior[still]
            rows.append((f"{label}   {name}", parent / still))
    studio.montage(rows, 3, out / "revision-comparison.jpg")
    studio.montage(
        [
            (f"{lod.upper()}   {name}", out / f"{lod}-{name}.png")
            for lod in ("high", "lod0", "lod1")
            for name in views
        ],
        len(views),
        out / "comparison.jpg",
    )
    write_json(camera_path, cams)


if __name__ == "__main__":
    main()
