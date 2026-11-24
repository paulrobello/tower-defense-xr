#!/usr/bin/env python3
"""Render the original 8-bar procedural preview loop with FFmpeg codec fallbacks."""

import math
import struct
import subprocess
import tempfile
import wave
from pathlib import Path

SAMPLE_RATE = 48_000
BEAT_SECONDS = 0.5
CHORD_BEATS = 8
CHORDS = (
    (38, 50, 53, 57),  # D minor
    (34, 46, 53, 57),  # B-flat major seventh
    (41, 48, 53, 57),  # F major
    (36, 48, 50, 55),  # C suspended second
)
DURATION_SECONDS = BEAT_SECONDS * CHORD_BEATS * len(CHORDS)
OUTPUT = Path(__file__).resolve().parents[1] / "public/assets/audio/music"


def oscillator(age: float, note: int) -> float:
    frequency = 440 * 2 ** ((note - 69) / 12)
    return math.sin(math.tau * frequency * age)


def envelope(age: float, duration: float, attack: float, release: float) -> float:
    return min(1, age / attack, (duration - age) / release)


def sample_at(seconds: float) -> tuple[float, float]:
    beat = seconds / BEAT_SECONDS
    chord = CHORDS[int(beat) // CHORD_BEATS]
    chord_length = CHORD_BEATS * BEAT_SECONDS
    chord_age = seconds % chord_length
    bass_age = seconds % BEAT_SECONDS
    bass_note = chord[0] + (12 if int(beat) % 4 == 3 else 0)
    bass = envelope(bass_age, BEAT_SECONDS, 0.015, 0.07) * (
        0.14 * oscillator(bass_age, bass_note) + 0.055 * oscillator(bass_age, bass_note + 12)
    )

    pluck_age = seconds % (BEAT_SECONDS / 2)
    eighth = int(beat * 2) % CHORD_BEATS
    pluck_note = chord[1 + (0, 2, 1, 0, 1, 2, 1, 2)[eighth]] + 12
    pluck = (
        envelope(pluck_age, BEAT_SECONDS / 2, 0.012, 0.045)
        * math.exp(-9 * pluck_age)
        * (0.085 * oscillator(pluck_age, pluck_note)
           + 0.023 * oscillator(pluck_age, pluck_note + 12))
    )

    pad = envelope(chord_age, chord_length, 0.15, 0.25) * sum(
        (0.06 + 0.01 * math.sin(math.tau * chord_age / chord_length + voice))
        * oscillator(chord_age, note)
        for voice, note in enumerate(chord[1:])
    )

    return bass + pad + pluck * 0.9, bass + pad * 0.95 + pluck


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="rift-preview-music-") as directory:
        master = Path(directory) / "preview.wav"
        frames = bytearray()
        for index in range(round(SAMPLE_RATE * DURATION_SECONDS)):
            left, right = sample_at(index / SAMPLE_RATE)
            frames.extend(struct.pack("<hh", round(left * 32767), round(right * 32767)))

        with wave.open(str(master), "wb") as stream:
            stream.setnchannels(2)
            stream.setsampwidth(2)
            stream.setframerate(SAMPLE_RATE)
            stream.writeframes(frames)

        for suffix, codec_args in (
            ("ogg", ["-c:a", "libopus", "-b:a", "80k", "-application", "audio"]),
            ("mp3", ["-c:a", "libmp3lame", "-q:a", "4", "-write_xing", "1"]),
        ):
            subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", str(master), "-map_metadata", "-1", "-fflags", "+bitexact",
                    *codec_args, str(OUTPUT / f"rift-bastion-preview.{suffix}"),
                ],
                check=True,
            )


if __name__ == "__main__":
    main()
