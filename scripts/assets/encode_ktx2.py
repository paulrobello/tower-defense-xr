"""Encode a staged PNG into the pinned glTF UASTC KTX2 profile."""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

from ktx2 import (
    COLOR_ROLES,
    DEFAULT_KTX,
    ROLES,
    checked_ktx,
    digest,
    ktx_run,
    read_ktx2,
    require,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--role", required=True, choices=ROLES)
    parser.add_argument("--ktx", type=Path, default=DEFAULT_KTX)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()

    require(
        args.source.suffix == ".png" and args.destination.suffix == ".ktx2",
        "expected INPUT.png OUTPUT.ktx2",
    )
    source = args.source.resolve(strict=True)
    destination = args.destination.resolve()
    require(not destination.exists(), f"refusing to overwrite {destination}")
    ktx = checked_ktx(args.ktx)
    color = args.role in COLOR_ROLES
    profile = "R8G8B8A8_SRGB" if color else "R8G8B8_UNORM"
    tf, primaries = ("srgb", "bt709") if color else ("linear", "none")
    options = [
        "--format",
        profile,
        "--assign-tf",
        tf,
        "--assign-primaries",
        primaries,
        "--assign-texcoord-origin",
        "top-left",
        "--convert-texcoord-origin",
        "top-left",
        "--encode",
        "uastc",
        "--uastc-quality",
        "2",
        "--uastc-rdo",
        "--threads",
        "1",
        "--zstd",
        "18",
        "--generate-mipmap",
    ]
    if args.role == "normal":
        options.extend(("--normalize", "--uastc-rdo-l", "0.5"))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="encode-ktx2-", dir=destination.parent) as directory:
        temporary = Path(directory) / "texture.ktx2"
        ktx_run(ktx, "create", *options, str(source), str(temporary), timeout=300)
        ktx_run(ktx, "validate", "--gltf-basisu", str(temporary))
        data = temporary.read_bytes()
        width, height = read_ktx2(data, args.role)
        destination.hardlink_to(temporary)
    print(f"{args.role} {width}×{height} {len(data)} bytes SHA-256 {digest(data)} {destination}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit(str(error))
