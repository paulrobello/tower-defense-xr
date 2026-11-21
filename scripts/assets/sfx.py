"""Build or independently verify the private Rift Bastion sound-effect review package."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from array import array
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
SFX = ROOT / "assets-source/audio/sfx"
RAW = SFX / "raw"
STAGING = SFX / "staging"
SR = 48000
REVIEW_CODECS = {"ogg": ("opus", "ogg"), "mp3": ("mp3", "mp3")}
GROUP_COUNTS = {"placement-ui": 6, "turrets": 10, "rift-enemies": 8, "core-waves": 4}
Json = dict[str, Any]


def run(*args: str, stdin: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        args, input=stdin, capture_output=True, check=True, timeout=30
    )


def ffmpeg(
    *args: str, stdin: bytes | None = None
) -> subprocess.CompletedProcess[bytes]:
    return run("ffmpeg", "-nostdin", "-hide_banner", "-xerror", *args, stdin=stdin)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path) -> Json:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Json) -> None:
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def probe(path: Path) -> Json:
    info = json.loads(
        run(
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,sample_rate,channels:format=format_name",
            "-of",
            "json",
            str(path),
        ).stdout,
    )
    require(
        len(info["streams"]) == 1, f"{path.name}: expected exactly one audio stream"
    )
    stream = info["streams"][0]
    return {
        "codec": stream["codec_name"],
        "container": info["format"]["format_name"],
        "sample_rate_hz": int(stream["sample_rate"]),
        "channels": stream["channels"],
    }


def samples(pcm: bytes) -> array:
    result = array("f", pcm)
    if sys.byteorder != "little":
        result.byteswap()
    require(
        len(result) > 0 and all(map(math.isfinite, result)), "empty or non-finite PCM"
    )
    return result


def pcm_bytes(data: array) -> bytes:
    if sys.byteorder == "little":
        return data.tobytes()
    little_endian = array("f", data)
    little_endian.byteswap()
    return little_endian.tobytes()


def decode(path: Path, audio_filter: str | None = None) -> array:
    filters = ["-af", audio_filter] if audio_filter else []
    return samples(
        ffmpeg(
            "-v", "error", "-i", str(path), *filters, "-ar", str(SR), "-f", "f32le", "-"
        ).stdout
    )


def levels(path: Path) -> tuple[float, float]:
    log = ffmpeg(
        "-nostats",
        "-i",
        str(path),
        "-af",
        "apad=whole_dur=1.2,ebur128=peak=true",
        "-f",
        "null",
        "-",
    ).stderr.decode()
    summary = log.rsplit("Summary:", 1)[-1]
    loudness = re.search(r"\bI:\s+(-?[\d.]+) LUFS", summary)
    peak = re.search(r"\bPeak:\s+(-?[\d.]+|-inf) dBFS", summary)
    require(
        bool(loudness and peak),
        f"{path.name}: integrated loudness or true peak missing",
    )
    return float(loudness[1]), float(peak[1])


def db(amplitude: float) -> float:
    return 20 * math.log10(max(amplitude, 1e-9))


def rms(values: array) -> float:
    return math.sqrt(math.fsum(value * value for value in values) / len(values))


def mono_loss(stereo: array) -> float:
    left = stereo[::2]
    right = stereo[1::2]
    require(len(left) == len(right), "invalid interleaved stereo PCM")
    mono = array(
        "f",
        (
            0.5 * l_value + 0.5 * r_value
            for l_value, r_value in zip(left, right, strict=True)
        ),
    )
    return db(rms(stereo)) - db(rms(mono))


def validate_mono(stereo: array, delivery: Json) -> float:
    loss = mono_loss(stereo)
    require(
        loss <= delivery["max_mono_cancellation_db"],
        f"phase cancellation on 0.5L + 0.5R fold: {loss:.2f} dB",
    )
    return round(loss, 2)


def steps(data: array, window: int) -> list[float]:
    return [db(rms(data[i : i + window])) for i in range(0, len(data), window)]


def silence(data: array, threshold: float) -> tuple[float, float, float]:
    window = SR // 1000
    full_windows = len(data) // window
    activity = [
        i
        for i, level in enumerate(steps(data, window)[:full_windows])
        if level >= threshold
    ]
    require(bool(activity), "silence: no active windows")
    lead = activity[0]
    tail = full_windows - 1 - activity[-1]
    interior = max(
        (right - left - 1 for left, right in itertools.pairwise(activity)), default=0
    )
    return lead, tail, interior


def measure_loop(data: array, delivery: Json) -> Json:
    motion = sorted(abs(b - a) for a, b in itertools.pairwise(data))
    p999 = motion[int((len(motion) - 1) * 0.999)]
    seam_ratio = abs(data[-1] - data[0]) / max(p999, 1e-9)
    width = SR // 10
    windows = steps(data, width)[: len(data) // width]
    edge_delta = abs(db(rms(data[:width])) - db(rms(data[-width:])))
    interior_drop = max(windows) - min(windows)
    require(
        seam_ratio <= delivery["max_peak_delta_ratio"],
        f"loop boundary step ratio {seam_ratio:.2f}",
    )
    require(
        edge_delta <= delivery["max_loop_edge_delta_db"],
        f"loop head/tail level delta {edge_delta:.2f} dB",
    )
    require(
        interior_drop <= delivery["max_loop_interior_drop_db"],
        f"loop interior dip {interior_drop:.2f} dB",
    )
    return {
        "seam_step_ratio": round(seam_ratio, 3),
        "head_tail_delta_db": round(edge_delta, 2),
        "max_interior_drop_db": round(interior_drop, 2),
    }


def validate_audio(
    path: Path, cue: Json, delivery: Json, frames: int | None = None
) -> Json:
    media = probe(path)
    ext = path.suffix[1:]
    codec, container = REVIEW_CODECS[ext]
    require(
        (media["codec"], media["container"]) == (codec, container),
        f"wrong codec/container for {ext}",
    )
    require(
        media["sample_rate_hz"] == SR and media["channels"] == 1,
        "derivative must be 48 kHz mono",
    )
    require(
        path.stat().st_size <= delivery["max_asset_bytes"],
        "derivative exceeded byte budget",
    )
    if ext == "mp3":
        require(
            b"Lavc" in path.read_bytes()[:1024], "MP3 is missing its Lavc gapless tag"
        )
    data = decode(path)
    duration = len(data) / SR
    low, high = cue["duration_range_seconds"]
    require(low <= duration <= high, f"duration {duration:.3f}s outside {low}–{high}s")
    require(
        frames is None or len(data) == frames,
        f"decoded {len(data)} frames, expected {frames} with trim metadata",
    )
    loudness, true_peak = levels(path)
    require(
        true_peak <= delivery["max_true_peak_dbtp"],
        f"true peak {true_peak} dBTP exceeds the ceiling",
    )
    lead, tail, gap = silence(data, delivery["silence_threshold_dbfs"])
    require(lead <= delivery["max_leading_silence_ms"], f"leading silence: {lead} ms")
    require(tail <= delivery["max_trailing_silence_ms"], f"trailing silence: {tail} ms")
    require(gap <= delivery["max_interior_silence_ms"], f"interior silence: {gap} ms")
    lo, hi = delivery["profiles"][cue["profile"]]["lufs_range"]
    require(lo <= loudness <= hi, f"loudness {loudness} LUFS outside {lo}–{hi} LUFS")
    info = {
        **media,
        "file": path.name,
        "bytes": path.stat().st_size,
        "sha256": sha(path),
        "decoded_frames": len(data),
        "duration_seconds": round(duration, 5),
        "integrated_lufs": loudness,
        "true_peak_dbtp": true_peak,
        "leading_silence_ms": lead,
        "trailing_silence_ms": tail,
        "interior_silence_ms": gap,
    }
    if cue["loop"]:
        info["loop"] = measure_loop(data, delivery)
    return info


def verify_hash(path: Path, expected: str) -> None:
    require(sha(path) == expected, f"SHA-256 mismatch: {path.name}")


def inspect_take(cue: Json, take: Path, contract: Json) -> Json | None:
    request = read_json(take / "request.json")
    receipt = read_json(take / "receipt.json")
    require(request["cue"] == cue["id"], "mismatched cue receipt")
    require(request["provider"] == contract["provider"], "mismatched provider")
    require(request["rights"] == contract["rights"], "mismatched rights evidence")
    require(
        request["url"]
        == f"{contract['endpoint']}?output_format={contract['output_format']}",
        "mismatched provider format",
    )
    expected = {
        name: cue[name]
        for name in ("text", "duration_seconds", "prompt_influence", "loop")
    }
    expected.update(cue.get("retry_parameters", {}).get(take.name, {}))
    expected["model_id"] = contract["model_id"]
    require(request["request"] == expected, "mismatched provider parameters")
    require(
        (take.name == "take-01") == (request["retry_reason"] is None),
        "missing or unexpected retry reason",
    )
    source = take / receipt["file"]
    verify_hash(source, receipt["sha256"])
    require(source.stat().st_size == receipt["bytes"], "mismatched receipt size")
    if receipt["http_status"] != 200:
        return None
    media = probe(source)
    require(
        media["codec"] == "mp3"
        and media["sample_rate_hz"] == 44100
        and media["channels"] in (1, 2),
        "wrong provider audio format",
    )
    decoded = decode(source)
    loudness, peak = levels(source)
    require(math.isfinite(peak), "source audio is silent")
    return {
        **media,
        "file": str(source.relative_to(SFX)),
        "take": take.name,
        "bytes": receipt["bytes"],
        "sha256": receipt["sha256"],
        "request_sha256": sha(take / "request.json"),
        "receipt_sha256": sha(take / "receipt.json"),
        "duration_seconds": round(len(decoded) / (SR * media["channels"]), 5),
        "integrated_lufs": loudness,
        "true_peak_dbtp": peak,
        "mono_cancellation_db": validate_mono(decoded, contract["delivery"])
        if media["channels"] == 2
        else 0,
    }


def select_source(cue: Json, contract: Json) -> Json:
    cue_dir = RAW / cue["id"]
    takes = sorted(cue_dir.glob("take-*"))
    require(
        0 < len(takes) <= contract["max_attempts_per_cue"],
        f"invalid take count for {cue['id']}",
    )
    require(
        [take.name for take in takes]
        == [f"take-{i:02d}" for i in range(1, len(takes) + 1)],
        "take numbering gap",
    )
    options = [
        info
        for take in takes
        if (info := inspect_take(cue, take, contract)) is not None
    ]
    require(bool(options), f"no successful take for {cue['id']}")
    selected = cue.get("selected_take", options[0]["take"])
    selected_options = [option for option in options if option["take"] == selected]
    require(
        bool(selected_options), f"selected source unavailable: {cue['id']} / {selected}"
    )
    return selected_options[0]


def shape_one_shot(data: array, cue: Json) -> tuple[array, Json]:
    edit = cue.get("mastering_edit")
    offset = round(edit["start_s"] * SR) if edit else 0
    if edit:
        data = data[offset : round(edit["end_s"] * SR)]
    width = SR // 200
    windows = steps(data, width)
    threshold = max(windows) - 40
    active = [i for i, level in enumerate(windows) if level >= threshold]
    start = max(0, active[0] * width - SR // 200)
    low, high = (round(seconds * SR) for seconds in cue["duration_range_seconds"])
    end = min(len(data), (active[-1] + 1) * width + SR // 60, start + high)
    result = data[start:end]
    fade_in = SR // 500
    fade_out = min(SR // 30, len(result) // 4)
    for i in range(fade_in):
        result[i] *= i / fade_in
    for i in range(fade_out):
        result[-1 - i] *= i / fade_out
    # MP3 Xing end padding is limited by its decoder delay. Align both codecs
    # to the same 1 ms grid so the last frame can represent exact length.
    ms = SR // 1000
    aligned = math.ceil(max(low, len(result)) / ms) * ms
    pad = aligned - len(result)
    result.extend([0.0] * pad)
    return result, {
        "source_start_frame": offset + start,
        "source_end_frame": offset + end,
        "tail_pad_frames": pad,
        "fade_in_frames": fade_in,
        "fade_out_frames": fade_out,
    }


def shape_loop(data: array) -> tuple[array, Json]:
    edge = round(0.05 * SR)
    overlap = round(0.16 * SR)
    head, end = edge, len(data) - edge - overlap
    require(end > head + overlap * 2, "not enough source audio for the loop crossfade")
    loop = data[head:end]
    for i in range(overlap):
        angle = math.pi * i / (2 * overlap)
        loop[i] = loop[i] * math.sin(angle) + data[end + i] * math.cos(angle)
    return loop, {
        "source_start_frame": head,
        "source_end_frame": end,
        "crossfade_frames": overlap,
    }


def write_master(path: Path, data: array, gain: float) -> None:
    ffmpeg(
        "-v",
        "error",
        "-y",
        "-f",
        "f32le",
        "-ar",
        str(SR),
        "-ac",
        "1",
        "-i",
        "-",
        "-af",
        f"volume={gain:.4f}dB",
        "-c:a",
        "flac",
        "-sample_fmt",
        "s32",
        "-bits_per_raw_sample",
        "24",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:a",
        "+bitexact",
        str(path),
        stdin=pcm_bytes(data),
    )


def encode(master: Path, path: Path) -> None:
    common = ["-v", "error", "-y", "-i", str(master), "-map_metadata", "-1"]
    if path.suffix == ".ogg":
        codec = [
            "-c:a",
            "libopus",
            "-b:a",
            "64k",
            "-vbr",
            "on",
            "-application",
            "audio",
            "-fflags",
            "+bitexact",
            "-flags:a",
            "+bitexact",
            "-f",
            "ogg",
        ]
    else:
        codec = ["-c:a", "libmp3lame", "-b:a", "96k", "-write_xing", "1"]
    ffmpeg(*common, *codec, str(path))


def master_cue(cue: Json, contract: Json, destination: Path) -> Json:
    delivery = contract["delivery"]
    source = select_source(cue, contract)
    source_path = SFX / source["file"]
    fold = "pan=mono|c0=0.5*c0+0.5*c1," if source["channels"] == 2 else ""
    shaped = decode(source_path, f"{fold}highpass=f=65")
    data, edit = shape_loop(shaped) if cue["loop"] else shape_one_shot(shaped, cue)
    cue_id = cue["id"]
    master = destination / "masters" / f"{cue_id}.flac"
    paths = [destination / f"{cue_id}.{ext}" for ext in REVIEW_CODECS]

    analysis_gain = min(0.0, -3 - db(max(map(abs, data))))
    write_master(master, data, analysis_gain)
    loudness, true_peak = levels(master)
    require(math.isfinite(true_peak), "mastered signal is silent")
    ceiling = delivery["max_true_peak_dbtp"]
    intended_gain = delivery["profiles"][cue["profile"]]["target_lufs"] - loudness
    gain = analysis_gain + min(intended_gain, ceiling - 0.25 - true_peak)
    for _ in range(4):
        write_master(master, data, gain)
        for path in paths:
            encode(master, path)
        decoded_peak = max(levels(path)[1] for path in paths)
        if decoded_peak <= ceiling:
            break
        gain -= decoded_peak - ceiling + 0.2

    derivatives = {
        p.suffix[1:]: validate_audio(p, cue, delivery, len(data)) for p in paths
    }
    return {
        "id": cue_id,
        "family": cue["family"],
        "label": cue["label"],
        "trigger": cue["trigger"],
        "loop": cue["loop"],
        "source": source,
        "master": {
            "file": str(master.relative_to(destination)),
            "sha256": sha(master),
            "bytes": master.stat().st_size,
            "sample_rate_hz": SR,
            "channels": 1,
            "decoded_frames": len(data),
            "highpass_hz": 65,
            "linear_gain_db": round(gain, 4),
            **edit,
        },
        "derivatives": derivatives,
    }


def checked_config() -> Json:
    contract = read_json(SFX / "contract.json")
    cues = contract["cues"]
    require(
        Counter(cue["family"] for cue in cues) == GROUP_COUNTS,
        "cue family counts changed",
    )
    require(len({cue["id"] for cue in cues}) == len(cues), "duplicate cue ID")
    require(
        [cue["id"] for cue in cues if cue["loop"]] == ["rift-ambient"],
        "loop cue changed",
    )
    require(
        contract["delivery"]["sample_rate_hz"] == SR
        and contract["delivery"]["channels"] == 1,
        "tool/delivery spec mismatch",
    )
    require(
        {p.name for p in RAW.iterdir()} == {cue["id"] for cue in cues},
        "raw cue inventory does not match the contract",
    )
    return contract


def master_all(contract: Json, destination: Path) -> Json:
    (destination / "masters").mkdir(parents=True)
    with ThreadPoolExecutor(max_workers=4) as executor:
        jobs = [
            (cue["id"], executor.submit(master_cue, cue, contract, destination))
            for cue in contract["cues"]
        ]
        entries = []
        errors = []
        for cue_id, job in jobs:
            try:
                entries.append(job.result())
            except (ValueError, subprocess.CalledProcessError) as error:
                details = (
                    error.stderr.decode().strip()
                    if isinstance(error, subprocess.CalledProcessError)
                    else str(error)
                )
                errors.append(f"{cue_id}: {details}")
        require(not errors, "\n".join(errors))

    manifest = {
        "contract_sha256": sha(SFX / "contract.json"),
        "mastering_script_sha256": sha(Path(__file__)),
        "ffmpeg": run("ffmpeg", "-version").stdout.decode().splitlines()[0],
        "review_status": "pending owner listening",
        "cues": entries,
    }
    write_json(destination / "catalog.json", manifest)
    return manifest


def validate_cue(cue: Json, record: Json, contract: Json, directory: Path) -> None:
    for key in ("id", "family", "label", "trigger", "loop"):
        require(cue[key] == record[key], f"mismatched cue {key}")
    require(
        select_source(cue, contract) == record["source"],
        "source selection or evidence changed",
    )
    master = directory / record["master"]["file"]
    verify_hash(master, record["master"]["sha256"])
    require(
        master.stat().st_size == record["master"]["bytes"],
        "mismatched master byte count",
    )
    media = probe(master)
    require(
        media
        == {"codec": "flac", "container": "flac", "sample_rate_hz": SR, "channels": 1},
        "wrong lossless master format",
    )
    frames = len(decode(master))
    require(
        frames == record["master"]["decoded_frames"],
        "lossless master decoded frame count changed",
    )
    for ext in REVIEW_CODECS:
        saved = record["derivatives"][ext]
        path = directory / f"{cue['id']}.{ext}"
        verify_hash(path, saved["sha256"])
        require(
            validate_audio(path, cue, contract["delivery"], frames) == saved,
            "derivative measurements changed",
        )


def validate_all(contract: Json, directory: Path) -> None:
    manifest = read_json(directory / "catalog.json")
    require(
        sha(SFX / "contract.json") == manifest["contract_sha256"],
        "contract hash changed",
    )
    require(
        sha(Path(__file__)) == manifest["mastering_script_sha256"],
        "mastering script hash changed",
    )
    require(
        manifest["review_status"] == "pending owner listening",
        "unexpected owner approval state",
    )
    with ThreadPoolExecutor(max_workers=4) as executor:
        jobs = [
            (cue["id"], executor.submit(validate_cue, cue, record, contract, directory))
            for cue, record in zip(contract["cues"], manifest["cues"], strict=True)
        ]
        for cue_id, job in jobs:
            try:
                job.result()
            except ValueError as error:
                raise ValueError(f"{cue_id}: {error}") from error


def negative_controls(contract: Json, directory: Path) -> None:
    cue = next(cue for cue in contract["cues"] if cue["id"] == "surface-clamp")
    delivery = contract["delivery"]
    path = directory / "mutation.ogg"
    data = array("f", (math.sin(2 * math.pi * 1000 * i / SR) for i in range(SR // 2)))

    def expect_failure(check, message: str) -> None:
        try:
            check()
        except ValueError as error:
            require(message in str(error), f"wrong mutation rejection: {error}")
        else:
            raise ValueError(f"negative control failed to reject: {message}")
        print(f"Rejected mutation: {message}")

    def write_control(signal: array) -> None:
        ffmpeg(
            "-v",
            "error",
            "-y",
            "-f",
            "f32le",
            "-ar",
            str(SR),
            "-ac",
            "1",
            "-i",
            "-",
            "-c:a",
            "libopus",
            str(path),
            stdin=pcm_bytes(signal),
        )

    write_control(data)
    expect_failure(lambda: validate_audio(path, cue, delivery), "true peak")
    write_control(array("f", [0]) * len(data))
    expect_failure(lambda: validate_audio(path, cue, delivery), "silence")
    expect_failure(lambda: verify_hash(path, "0" * 64), "SHA-256 mismatch")
    positive, inverse = array("f"), array("f")
    for value in data:
        positive.extend((value, value))
        inverse.extend((value, -value))
    require(
        abs(validate_mono(positive, delivery)) < 0.01,
        "correlated stereo control failed",
    )
    expect_failure(lambda: validate_mono(inverse, delivery), "phase cancellation")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "verify", "reproduce"))
    parser.add_argument("--directory", type=Path, default=STAGING)
    args = parser.parse_args()
    directory = args.directory.resolve()
    contract = checked_config()
    with tempfile.TemporaryDirectory(prefix="rift-sfx-") as scratch:
        temp = Path(scratch)
        if args.command == "build":
            built = temp / "stage"
            master_all(contract, built)
            for output in built.rglob("*"):
                existing = directory / output.relative_to(built)
                if output.is_file() and existing.exists():
                    require(
                        sha(existing) == sha(output),
                        f"staging already has different {existing.name}; use --directory for a new build",
                    )
            shutil.copytree(built, directory, dirs_exist_ok=True)
        elif args.command == "reproduce":
            rebuilt = master_all(contract, temp / "stage")
            require(
                rebuilt == read_json(directory / "catalog.json"),
                "rebuilt catalog differs from staging",
            )
            print("Reproduced all lossless master and derivative SHA-256 hashes")
        validate_all(contract, directory)
        negative_controls(contract, temp)
    take_count = len(list(RAW.glob("*/take-*/receipt.json")))
    print(
        f"Validated {take_count} raw takes, 28 lossless masters, and 56 staged derivatives."
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        sys.exit(str(error))
