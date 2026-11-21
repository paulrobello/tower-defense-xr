"""Register the skinned receiver pair using the shared embedded-map GLB writer."""

from pathlib import Path

import package_surface_clamp as packaging

ID = "wasp-skimmer"
CLIPS = ["hover_fly", "bank_turn", "attack", "hit", "death"]


def main() -> None:
    original_id, original_pack = packaging.ID, packaging.pack

    def record(stage: Path, target: Path, lod: int) -> dict:
        row = original_pack(stage, target, lod)
        row.update(
            sockets={},
            animations=CLIPS,
            planar_primitives=[],
            material_textures={
                "Wasp indigo cuticle": {r: f"{ID}/{r}.ktx2" for r in packaging.MAPS}
            },
        )
        row["limits"].update(
            triangles=6500 if lod == 0 else 2800, materials=1, bones=24, sockets=0
        )
        return row

    try:
        packaging.ID, packaging.pack = ID, record
        packaging.main()
    finally:
        packaging.ID, packaging.pack = original_id, original_pack


if __name__ == "__main__":
    main()
