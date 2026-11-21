"""Package the revised hover pod under its unchanged game asset ID."""

import argparse
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import package_hover_pod
from package_core_bastion import write_json

ID = "hover-pod"
DIRECTORY = "hover-pod-revision"


def main() -> None:
    parser = argparse.ArgumentParser()
    for arg in ("stage", "models", "ktx"):
        parser.add_argument("--" + arg, type=Path, required=True)
    args = parser.parse_args()
    models = args.models.resolve()
    models.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(dir=models) as temp:
        with patch(
            "sys.argv",
            [
                "pack",
                "--stage",
                str(args.stage),
                "--models",
                temp,
                "--ktx",
                str(args.ktx),
            ],
        ):
            package_hover_pod.main()
        new = json.loads((Path(temp) / "manifest.json").read_text())
        for row in new["textures"] + new["models"]:
            row["file"] = row["file"].replace(ID + "/", DIRECTORY + "/", 1)
        for row, limit in zip(new["models"], (2476, 1148), strict=True):
            # Each mesh mixes curved and planar surfaces; verify planar triangles separately on reimport.
            del row["planar_primitives"]
            row["limits"]["triangles"] = limit
            for mapping in row["material_textures"].values():
                for role in mapping:
                    mapping[role] = f"{DIRECTORY}/{role}.ktx2"
        (Path(temp) / ID).rename(models / DIRECTORY)
        write_json(models / "manifest.json", new)


if __name__ == "__main__":
    main()
