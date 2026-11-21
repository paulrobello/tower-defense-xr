"""Archive one immutable receipt and response for each authorized ElevenLabs SFX call."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import runpy
import sys
from datetime import UTC, datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
SFX = ROOT / "assets-source/audio/sfx"
RAW = SFX / "raw"
WORKSPACE = ROOT / ".local/rift-sfx"
SKILL = Path.home() / ".codex/skills/elevenlabs/scripts/generate.py"
SUBSCRIPTION = "https://api.elevenlabs.io/v1/user/subscription"
HEADER_NAMES = (
    "content-type",
    "character-cost",
    "request-id",
    "xi-request-id",
    "history-item-id",
    "x-history-item-id",
    "generation-id",
    "x-generation-id",
    "x-request-id",
)


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def write_record(path: Path, data: dict) -> None:
    with path.open("x", encoding="utf-8") as output:
        json.dump(data, output, ensure_ascii=False, indent=2)
        output.write("\n")


def meter(key: str) -> dict:
    with urlopen(
        Request(SUBSCRIPTION, headers={"xi-api-key": key}), timeout=20
    ) as response:
        data = json.load(response)
    evidence = {
        "observed_at_utc": now(),
        "tier": data["tier"],
        "status": data["status"],
        "character_count": data["character_count"],
        "character_limit": data["character_limit"],
        "next_character_count_reset_unix": data.get("next_character_count_reset_unix"),
        "max_credit_limit_extension": data.get("max_credit_limit_extension"),
        "can_extend_character_limit": data.get("can_extend_character_limit"),
        "overage": data.get("current_overage"),
    }
    if evidence["tier"] != "starter" or evidence["status"] != "active":
        raise SystemExit(
            "An active Starter account is required by this batch's approval."
        )
    extension = evidence["max_credit_limit_extension"]
    if extension != 0 and evidence["can_extend_character_limit"] is not False:
        raise SystemExit("The meter did not confirm that overage is disabled.")
    if evidence["character_count"] >= evidence["character_limit"]:
        raise SystemExit("No included credits remain.")
    return evidence


def generate(
    cue: dict, contract: dict, take: Path, key: str, reason: str | None, before: dict
) -> None:
    payload = {
        name: cue[name]
        for name in ("text", "duration_seconds", "prompt_influence", "loop")
    }
    payload.update(cue.get("retry_parameters", {}).get(take.name, {}))
    payload["model_id"] = contract["model_id"]
    url = f"{contract['endpoint']}?output_format={contract['output_format']}"
    write_record(
        take / "request.json",
        {
            "cue": cue["id"],
            "started_at_utc": now(),
            "provider": contract["provider"],
            "url": url,
            "request": payload,
            "retry_reason": reason,
            "billing_preflight": before,
            "rights": contract["rights"],
        },
    )
    request = Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "xi-api-key": key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        method="POST",
    )
    try:
        response = urlopen(request, timeout=120)
    except HTTPError as error:
        with error:
            persist_response(take, error)
        raise SystemExit(
            f"{cue['id']} returned HTTP {error.code}. Receipt preserved. Review before any retry."
        ) from None
    except OSError:
        raise SystemExit(
            f"{cue['id']} has an unresolved network outcome. Inspect provider history before retrying."
        ) from None
    with response:
        persist_response(take, response)
    print(f"{cue['id']} archived to {take.name}", flush=True)


def persist_response(take: Path, response) -> None:
    content_type = response.headers.get_content_type()
    file = (
        "response.mp3"
        if response.status == 200 and content_type.startswith("audio/")
        else "response.bin"
    )
    path = take / file
    digest = hashlib.sha256()
    with path.open("xb") as output:
        while chunk := response.read(65536):
            output.write(chunk)
            digest.update(chunk)
    write_record(
        take / "receipt.json",
        {
            "ended_at_utc": now(),
            "http_status": response.status,
            "file": file,
            "bytes": path.stat().st_size,
            "sha256": digest.hexdigest(),
            "response_headers": {
                name: response.headers[name]
                for name in HEADER_NAMES
                if name in response.headers
            },
        },
    )
    if response.status == 200 and file != "response.mp3":
        raise SystemExit("The provider returned non-audio content. Receipt preserved.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--only", nargs="+", metavar="CUE")
    mode.add_argument("--remaining", action="store_true")
    mode.add_argument("--retry", metavar="CUE")
    mode.add_argument("--meter", action="store_true")
    parser.add_argument(
        "--reason", help="Document the reviewed reason for an explicit retry."
    )
    args = parser.parse_args()
    if bool(args.retry) != bool(args.reason):
        parser.error("--retry and --reason must be used together")
    contract = json.loads((SFX / "contract.json").read_text(encoding="utf-8"))
    cues = {cue["id"]: cue for cue in contract["cues"]}
    if len(cues) != contract["delivery"]["first_pass_request_limit"]:
        parser.error("the contract does not match the authorized first-pass cue count")
    selected = list(dict.fromkeys(args.only or ([args.retry] if args.retry else cues)))
    if unknown := set(selected) - cues.keys():
        parser.error("unknown cue IDs: " + ", ".join(sorted(unknown)))

    sys.dont_write_bytecode = True
    key = runpy.run_path(str(SKILL))["get_api_key"]()
    if not key:
        parser.error("ElevenLabs API key is unavailable")
    if args.meter:
        print(json.dumps(meter(key), indent=2))
        return

    WORKSPACE.mkdir(parents=True, exist_ok=True)
    with (WORKSPACE / "generation.lock").open("a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = meter(key)
        print(
            f"Included credit meter before batch: {before['character_count']}/{before['character_limit']}",
            flush=True,
        )
        for cue_id in selected:
            cue_dir = RAW / cue_id
            takes = sorted(cue_dir.glob("take-*"))
            if not args.retry and takes:
                continue
            if args.retry and (not takes or not (takes[-1] / "receipt.json").is_file()):
                parser.error("retry requires a prior resolved receipt")
            if len(takes) >= contract["max_attempts_per_cue"]:
                parser.error("the authorized per-cue attempt count is exhausted")
            take = cue_dir / f"take-{len(takes) + 1:02d}"
            take.mkdir(parents=True)
            generate(cues[cue_id], contract, take, key, args.reason, before)
        after = meter(key)
        charged = after["character_count"] - before["character_count"]
        print(
            f"Included credit meter after batch: {after['character_count']}/{after['character_limit']} ({charged:+d})",
            flush=True,
        )


if __name__ == "__main__":
    main()
