"""Package the Rift Spitter receivers with embedded PNG and KTX2 maps."""

import json
from pathlib import Path

import package_surface_clamp as packaging
from package_broodlord_revision import frames

ID = "rift-spitter"
CLIPS = ["crawl_floor", "climb_wall", "attack", "hit", "death"]


def main() -> None:
    original_id, original_pack = packaging.ID, packaging.pack

    def record(stage: Path, target: Path, lod: int) -> dict:
        gltf = json.loads((stage / f"lod{lod}" / "source.gltf").read_text())
        material = gltf["materials"][0]["name"]
        row = original_pack(stage, target, lod)
        tangents = frames(target / f"{ID}-lod{lod}.glb")
        packaging.write_json(target / f"tangent-lod{lod}.json", tangents)
        row.update(
            sha256=tangents["glb_sha256"],
            sockets={},
            animations=CLIPS,
            planar_primitives=[],
            material_textures={
                material: {role: f"{ID}/{role}.ktx2" for role in packaging.MAPS}
            },
        )
        row["limits"].update(
            triangles=4500 if lod == 0 else 2200, materials=1, bones=24, sockets=0
        )
        return row

    try:
        packaging.ID, packaging.pack = ID, record
        packaging.main()
    finally:
        packaging.ID, packaging.pack = original_id, original_pack


if __name__ == "__main__":
    main()
