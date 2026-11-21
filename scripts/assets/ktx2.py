"""Rift Bastion's glTF-compatible KTX2 profile and pinned decoder."""

from __future__ import annotations

import hashlib
import struct
import subprocess
import tempfile
from collections.abc import Callable
from itertools import pairwise
from pathlib import Path
from typing import Any

DEFAULT_KTX = Path.home() / ".local/opt/ktx-software-4.4.2/bin/ktx"
VERSION = "ktx version: v4.4.2"
ROLES = ("basecolor", "normal", "orm", "emissive")
COLOR_ROLES = {"basecolor", "emissive"}
IDENTIFIER = b"\xabKTX 20\xbb\r\n\x1a\n"
HEADER = struct.Struct("<12s13I2Q")
LEVEL = struct.Struct("<3Q")
MAX_DIMENSION = 2048
Json = dict[str, Any]
Decoder = Callable[[bytes], bytes]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def unsigned(value: Any, label: str, minimum: int = 0) -> int:
    require(type(value) is int and value >= minimum, f"invalid {label}: {value!r}")
    return value


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ktx_run(ktx: Path, *args: str, timeout: int = 60) -> bytes:
    try:
        return subprocess.run(
            [str(ktx), *args], capture_output=True, check=True, timeout=timeout
        ).stdout
    except (OSError, subprocess.SubprocessError) as error:
        message = (
            (error.stderr or b"").decode(errors="replace").strip()
            if isinstance(error, subprocess.CalledProcessError)
            else str(error)
        )
        raise ValueError(f"KTX 4.4.2 at {ktx}: {message}") from error


def checked_ktx(path: Path) -> Path:
    require(ktx_run(path, "--version").decode().strip() == VERSION, f"expected {VERSION} at {path}")
    return path


def decode_ktx2(ktx: Path, data: bytes) -> bytes:
    with tempfile.TemporaryDirectory(prefix="rift-ktx2-") as scratch:
        path = Path(scratch) / "input.ktx2"
        path.write_bytes(data)
        ktx_run(ktx, "validate", "--gltf-basisu", str(path))
        return ktx_run(
            ktx, "extract", "--raw", "--transcode", "rgba8", "--level", "0", str(path), "-"
        )


def read_ktx2(data: bytes, role: str) -> tuple[int, int]:
    require(role in ROLES, f"unknown texture role {role!r}")
    require(len(data) >= HEADER.size, "truncated KTX2 header")
    (
        identifier,
        vk_format,
        type_size,
        width,
        height,
        depth,
        layers,
        faces,
        count,
        compression,
        dfd_offset,
        dfd_length,
        kvd_offset,
        kvd_length,
        sgd_offset,
        sgd_length,
    ) = HEADER.unpack_from(data)
    require(identifier == IDENTIFIER, "invalid KTX2 identifier")
    require(
        (vk_format, type_size, depth, layers, faces, compression) == (0, 1, 0, 0, 1, 2),
        "expected Zstandard-supercompressed 2D Basis Universal KTX2",
    )
    require(
        4 <= width <= MAX_DIMENSION
        and 4 <= height <= MAX_DIMENSION
        and width % 4 == height % 4 == 0,
        "KTX2 dimensions must be multiples of four from 4 through 2048",
    )
    require(count == max(width, height).bit_length(), "KTX2 must contain a complete mip chain")
    index_end = HEADER.size + count * LEVEL.size
    require(index_end <= len(data), "truncated KTX2 level index")
    ranges = [(0, index_end)]

    def section(offset: int, length: int, label: str) -> bytes:
        require(
            length > 0 and offset >= index_end and offset + length <= len(data),
            f"KTX2 {label} byte range",
        )
        ranges.append((offset, offset + length))
        return data[offset : offset + length]

    require((sgd_offset, sgd_length) == (0, 0), "unexpected KTX2 global supercompression data")
    require(dfd_offset % 4 == 0 and kvd_offset % 4 == 0, "KTX2 metadata offsets must be aligned")
    dfd = section(dfd_offset, dfd_length, "DFD")
    require(len(dfd) == 44, "KTX2 must have one UASTC data format descriptor and sample")
    total, vendor_type, version, block_size = struct.unpack_from("<IIHH", dfd)
    require(
        (total, vendor_type, version, block_size) == (len(dfd), 0, 2, 40), "invalid KTX2 basic DFD"
    )
    require(
        dfd[12] == 166 and dfd[16:20] == bytes((3, 3, 0, 0)) and dfd[20] in (0, 16),
        "expected a 4×4 UASTC KTX2 texture",
    )
    expected_tf = 2 if role in COLOR_ROLES else 1
    require(dfd[14] == expected_tf, f"{role}: wrong KTX2 transfer function")
    require(role not in COLOR_ROLES or dfd[13] == 1, f"{role}: expected BT.709/sRGB primaries")
    require(
        (dfd[31] & 0xF) in (0, 3) and dfd[15] == 0,
        f"{role}: expected RGB/RGBA without premultiplied alpha",
    )

    require(kvd_length != 0 or kvd_offset == 0, "empty KTX2 metadata must have offset 0")
    kvd = section(kvd_offset, kvd_length, "metadata") if kvd_length else b""
    metadata: dict[bytes, bytes] = {}
    cursor = 0
    while cursor < len(kvd):
        require(cursor + 4 <= len(kvd), "truncated KTX2 metadata entry")
        size = struct.unpack_from("<I", kvd, cursor)[0]
        cursor += 4
        require(size > 0 and cursor + size <= len(kvd), "invalid KTX2 metadata entry size")
        key, separator, value = kvd[cursor : cursor + size].partition(b"\0")
        require(
            bool(key and separator) and key not in metadata,
            "invalid or duplicate KTX2 metadata key",
        )
        metadata[key] = value.rstrip(b"\0")
        cursor += (size + 3) & ~3
    require(cursor == len(kvd), "truncated KTX2 metadata padding")
    require(
        metadata.get(b"KTXorientation", b"rd") == b"rd", "expected top-left KTX2 orientation (rd)"
    )
    require(
        metadata.get(b"KTXswizzle", b"rgba") == b"rgba", "texture channel swizzling is unsupported"
    )

    for level in range(count):
        offset, length, uncompressed = LEVEL.unpack_from(data, HEADER.size + level * LEVEL.size)
        mip_width, mip_height = max(1, width >> level), max(1, height >> level)
        require(
            uncompressed == astc_bytes(mip_width, mip_height),
            f"KTX2 mip {level}: wrong UASTC byte length",
        )
        section(offset, length, f"mip {level}")
    ordered = sorted(ranges)
    require(
        all(left[1] <= right[0] for left, right in pairwise(ordered)),
        "overlapping KTX2 byte ranges",
    )
    return width, height


def astc_bytes(width: int, height: int) -> int:
    return ((width + 3) // 4) * ((height + 3) // 4) * 16


def validate_pixels(pixels: bytes, width: int, height: int, record: Json) -> None:
    role = record["role"]
    require(len(pixels) == width * height * 4, "KTX2 decode did not produce complete RGBA8 pixels")
    if role == "normal":
        squares = [(2 * value / 255 - 1) ** 2 for value in range(256)]
        channels = zip(pixels[::4], pixels[1::4], pixels[2::4], strict=True)
        for index, (r, g, b) in enumerate(channels):
            require(
                b >= 127 and 0.88**2 <= squares[r] + squares[g] + squares[b] <= 1.12**2,
                f"non-unit tangent normal at ({index % width}, {index // width}): {(r, g, b)}",
            )
            if record.get("flat_normal", False):
                require(
                    abs(r - 128) <= 4 and abs(g - 128) <= 4 and b >= 251,
                    f"flat tangent normal is not neutral at ({index % width}, {index // width}): {(r, g, b)}",
                )

    require(
        role == "normal" or "flat_normal" not in record, "flat_normal only applies to normal maps"
    )
    for sample in record.get("samples", []):
        x = unsigned(sample["x"], "sample x")
        y = unsigned(sample["y"], "sample y")
        expected = sample["rgb"]
        tolerance = unsigned(sample.get("tolerance", 8), "sample tolerance")
        require(x < width and y < height, "texture sample is outside the image")
        require(
            len(expected) == 3
            and all(type(value) is int and 0 <= value <= 255 for value in expected),
            "expected RGB sample must be three 8-bit integers",
        )
        require(tolerance <= 32, "sample tolerance exceeds 32")
        offset = (y * width + x) * 4
        actual = tuple(pixels[offset : offset + 3])
        labels = "ORM R/G/B (AO/roughness/metallic)" if role == "orm" else role
        require(
            all(abs(a - b) <= tolerance for a, b in zip(actual, expected, strict=True)),
            f"{labels} sample ({x}, {y}): decoded {actual}, expected {expected} ± {tolerance}",
        )


def validate_texture(data: bytes, record: Json, decoder: Decoder | None) -> tuple[int, int]:
    require(digest(data) == record["sha256"], "texture SHA-256 mismatch")
    width, height = read_ktx2(data, record["role"])
    require(
        (width, height) == (record["width"], record["height"]),
        "texture dimensions differ from manifest",
    )
    if decoder is not None:
        validate_pixels(decoder(data), width, height, record)
    return width, height
