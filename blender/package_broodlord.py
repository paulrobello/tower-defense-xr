"""Package both Broodlord receivers and their separately switchable Phase 2 mask."""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import package_surface_clamp as embedded
from package_core_bastion import MAPS, ROOT, digest, write_json

ID = "apex-broodlord"
CLIPS = ["boss_march", "spawn_adds", "emp_roar", "phase2_shift", "hit", "death"]


def main() -> None:
    parser = argparse.ArgumentParser()
    for arg in ("stage", "models", "ktx"):
        parser.add_argument("--" + arg, type=Path, required=True)
    args = parser.parse_args()
    stage, models, ktx = args.stage.resolve(), args.models.resolve(), args.ktx.resolve()
    target = models / ID
    target.mkdir(parents=True, exist_ok=True)
    metrics = json.loads((stage / "geometry.json").read_text())["bake"]
    textures = []
    for name in (*MAPS, "phase2-cracks"):
        role = "emissive" if name == "phase2-cracks" else name
        source = stage / f"{name}.png"
        assert digest(source) == metrics[name]["sha256"]
        with tempfile.TemporaryDirectory(dir=target) as temp:
            dest = Path(temp) / f"{name}.ktx2"
            subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/assets/encode_ktx2.py"),
                    "--ktx",
                    str(ktx),
                    "--role",
                    role,
                    str(source),
                    str(dest),
                ],
                check=True,
            )
            dest.replace(target / dest.name)
        shutil.copy2(source, target / source.name)
        textures.append(
            {
                "file": f"{ID}/{dest.name}",
                "role": role,
                "width": 2048,
                "height": 2048,
                "sha256": digest(target / dest.name),
                "samples": metrics[name]["samples"],
            }
        )
    original_id = embedded.ID
    records = []
    try:
        embedded.ID = ID
        for lod in (0, 1):
            row = embedded.pack(stage, target, lod)
            row.update(
                sockets={},
                animations=CLIPS,
                planar_primitives=[],
                material_textures={
                    "Broodlord obsidian chitin": {r: f"{ID}/{r}.ktx2" for r in MAPS}
                },
            )
            row["limits"].update(
                triangles=28000 if lod == 0 else 14000,
                materials=3,
                bones=48,
                sockets=0,
                texture_size=2048,
            )
            records.append(row)
    finally:
        embedded.ID = original_id
    for name in ("high.blend", "low.blend", "geometry.json"):
        shutil.copy2(stage / name, target / name)
    index = models / "manifest.json"
    data = (
        json.loads(index.read_text())
        if index.exists()
        else {"version": 1, "textures": [], "models": []}
    )
    assert data["version"] == 1
    data["textures"] = [
        t for t in data["textures"] if not t["file"].startswith(ID + "/")
    ] + textures
    data["models"] = [m for m in data["models"] if m["id"] != ID] + records
    write_json(index, data)


if __name__ == "__main__":
    main()
