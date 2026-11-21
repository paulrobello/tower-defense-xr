"""Render the revised KTX2s and pair each underside with its exact archived camera."""

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))

import review_hover_pod as review


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", type=Path, required=True)
    parser.add_argument("--original", type=Path, required=True)
    parser.add_argument("--ktx", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    sys.argv = [__file__, "--", "--piece", str(args.piece), "--ktx", str(args.ktx)]
    review.main()
    old, new = args.original / "review", args.piece / "review"
    assert json.loads((old / "cameras.json").read_text()) == json.loads(
        (new / "cameras.json").read_text()
    )
    font = subprocess.check_output(
        ["fc-match", "-f", "%{file}", "sans-serif"], text=True
    ).strip()
    images = []
    for title, folder in [("Original", old), ("Revised", new)]:
        for level in ("high", "lod0", "lod1"):
            images.extend(
                [
                    "-label",
                    f"{title}    {level.upper()}",
                    str(folder / f"{level}-underside.png"),
                ]
            )
    subprocess.run(
        [
            "magick",
            "montage",
            "-background",
            "#222833",
            "-fill",
            "white",
            "-font",
            font,
            "-pointsize",
            "18",
            *images,
            "-geometry",
            "536x536+4+4",
            "-tile",
            "3x2",
            "-quality",
            "94",
            str(new / "underside-comparison.jpg"),
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
