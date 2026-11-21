"""Register the skinned receiver pair using the shared embedded-map GLB writer."""

from pathlib import Path

import package_surface_clamp as packaging

ID = "carapace-brute"
CLIPS = ["stomp_walk", "armor_brace", "attack", "hit", "death"]


def main() -> None:
    original_id, original_pack = packaging.ID, packaging.pack

    def record(stage: Path, target: Path, lod: int) -> dict:
        row = original_pack(stage, target, lod)
        row.update(
            sockets={},
            animations=CLIPS,
            planar_primitives=[],
            material_textures={
                "Brute slate carapace": {r: f"{ID}/{r}.ktx2" for r in packaging.MAPS}
            },
        )
        row["limits"].update(
            triangles=9000 if lod == 0 else 4500, materials=1, bones=28, sockets=0
        )
        return row

    try:
        packaging.ID, packaging.pack = ID, record
        packaging.main()
    finally:
        packaging.ID, packaging.pack = original_id, original_pack


if __name__ == "__main__":
    main()
