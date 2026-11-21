"""Verify the archived Rift Bastion concepts. Requires ImageMagick 7 and Python 3."""

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
BOARDS = {
    "facet-foundry",
    "pearl-laminate",
    "pressure-cast",
    "vector-keel",
    "bastion-rib",
    "basalt-inlay",
}
SHEETS = {
    "core-bastion",
    "rift-portal",
    "autocannon",
    "plasma-mortar",
    "cryo-arc",
    "rail-sniper",
    "skitter-crawler",
    "wasp-skimmer",
    "carapace-brute",
    "rift-disruptor",
    "apex-broodlord",
}
MODEL = "cinematic_studio_2_5"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def verify() -> None:
    manifest = json.loads((BASE / "provenance.json").read_text(encoding="utf-8"))
    rows = manifest["outputs"]
    by_key = {item["key"]: item for item in rows}
    require(len(rows) == len(by_key) and by_key.keys() == BOARDS | SHEETS, "coverage")
    selected = manifest["workingReference"]
    require(selected in BOARDS, "working reference must be a board")
    ref = {k: by_key[selected][k] for k in ("file", "jobId", "sha256")}
    attempts = manifest["previousAttempts"]
    sources = rows + attempts
    for field in ("key", "sha256", "jobId", "file"):
        require(
            len({item[field] for item in sources}) == len(sources), f"duplicate {field}"
        )

    for row in sources:
        key = row["key"]
        category = "boards" if key in BOARDS else "sheets"
        if key not in by_key:
            require(
                row["subject"] in SHEETS and bool(row["reason"]),
                key + ": archived attempt",
            )
            require(re.fullmatch(r"[a-z0-9-]+", key) is not None, key + ": invalid key")
            category = "attempts"
        require(row["file"] == f"{category}/{key}.png", key + ": source path")
        source = BASE / row["file"]
        data = source.read_bytes()
        require(len(data) == row["bytes"], key + ": source length")
        require(hashlib.sha256(data).hexdigest() == row["sha256"], key + ": SHA-256")
        require(
            row["references"] == ([] if key in BOARDS else [ref]), key + ": reference"
        )
        require(row["requestedModel"] == row["returnedModel"] == MODEL, key + ": model")
        require(
            row["quotedCredits"] == 2 and row["chargedCredits"] == 2, key + ": cost"
        )
        require(
            isinstance(row["prompt"], str) and bool(row["prompt"].strip()),
            key + ": prompt",
        )
        require(isinstance(row["settings"]["seed"], int), key + ": seed")
        require(row["settings"]["resolution"] == "2k", key + ": resolution")
        require(row["settings"]["aspect_ratio"] == "3:2", key + ": aspect")
        require(row["settings"]["batch_size"] == 1, key + ": batch")
        # ImageMagick consumes the complete pixel stream for the signature (%#).
        result = subprocess.check_output(
            [
                "magick",
                "-regard-warnings",
                str(source),
                "-format",
                "%m %w %h %#",
                "info:",
            ],
            text=True,
        )
        fmt, width, height, signature = result.split()
        require(
            re.fullmatch(r"[a-fA-F0-9]{64}", signature) is not None, key + ": decode"
        )
        require(
            (fmt, int(width), int(height))
            == (row["format"], row["width"], row["height"]),
            key + ": dimensions or format",
        )

    actual = {
        p.relative_to(BASE).as_posix()
        for c in ("boards", "sheets", "attempts")
        for p in (BASE / c).rglob("*")
        if p.is_file()
    }
    require(actual == {r["file"] for r in sources}, "unregistered or missing source")
    preview_sources: list[str] = []
    previews = manifest["previews"]
    preview_files = {r["file"] for r in previews}
    require(
        preview_files
        == {"previews/boards.jpg", "previews/hardware.jpg", "previews/invaders.jpg"}
        and len(previews) == len(preview_files),
        "preview coverage",
    )
    for preview in previews:
        digest = hashlib.sha256((BASE / preview["file"]).read_bytes()).hexdigest()
        require(digest == preview["sha256"], preview["file"] + ": preview SHA-256")
        preview_sources.extend(preview["sourceKeys"])
    require(sorted(preview_sources) == sorted(by_key), "preview source coverage")
    total = sum(r["chargedCredits"] for r in sources)
    require(total == manifest["billing"]["chargedCredits"], "batch cost")
    print(
        f"{len(BOARDS)} boards, {len(SHEETS)} sheets and {len(attempts)} archived attempts decoded. All source and reference hashes match. {total} credits."
    )


if __name__ == "__main__":
    try:
        verify()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
