"""Package a fresh procedural bake for the staged-model validator."""

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def package(directory: Path) -> None:
    report = json.loads((directory / "maps.json").read_text())
    textures = []
    for key, material in report["materials"].items():
        for role, record in material["maps"].items():
            source = directory / key / f"{role}.png"
            if digest(source) != record["sha256"]:
                raise ValueError(f"Source differs from the Cycles bake: {source}")
            output = source.with_suffix(".ktx2")
            subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/assets/encode_ktx2.py"),
                    "--role",
                    role,
                    str(source),
                    str(output),
                ],
                check=True,
            )
            textures.append(
                {
                    "file": output.relative_to(directory).as_posix(),
                    "role": role,
                    "sha256": digest(output),
                    "width": report["resolution"][0],
                    "height": report["resolution"][1],
                    "samples": record["samples"],
                }
            )
    manifest = {"version": 1, "models": [], "textures": textures}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "assets-source/materials")
    package(parser.parse_args().out.resolve())
