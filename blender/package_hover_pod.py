"""Package both hover pod LODs with the shared embedded-map packaging pipeline."""

from pathlib import Path

import package_surface_clamp as packaging

ID = "hover-pod"
MATERIAL = "Hover Pod satin armor"


def main() -> None:
    original_id, pack = packaging.ID, packaging.pack

    def hover_record(stage: Path, target: Path, lod: int) -> dict:
        record = pack(stage, target, lod)
        record["sockets"]["mountSocket"]["parent"] = "hoverPod"
        record["limits"]["materials"] = 1
        record["material_textures"] = {
            MATERIAL: {role: f"{ID}/{role}.ktx2" for role in packaging.MAPS}
        }
        return record

    # The checked-in clamp packager is provenance-bound and takes its ID from module scope.
    try:
        packaging.ID, packaging.pack = ID, hover_record
        packaging.main()
    finally:
        packaging.ID, packaging.pack = original_id, pack


if __name__ == "__main__":
    main()
