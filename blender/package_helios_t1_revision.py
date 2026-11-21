"""Package a mixed curved/planar head; the reimport gate measures each planar cap."""

import sys
from pathlib import Path
from unittest.mock import patch

import package_helios
import package_surface_clamp


def main() -> None:
    pack = package_surface_clamp.pack

    def mixed_surface(stage: Path, target: Path, lod: int) -> dict:
        row = pack(stage, target, lod)
        del row["planar_primitives"]
        return row

    with (
        patch.object(package_surface_clamp, "pack", mixed_surface),
        patch.object(sys, "argv", [sys.argv[0], "--tier", "1", *sys.argv[1:]]),
    ):
        package_helios.main()


if __name__ == "__main__":
    main()
