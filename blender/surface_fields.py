"""Periodic relief in metres, reflectance in sRGB bytes, and linear scalar fields."""

import numpy as np
from numpy.typing import NDArray

Field = NDArray[np.float64]
TAU = 2 * np.pi


def noise(u: Field, v: Field, nx: int, ny: int, seed: int) -> Field:
    """Quintic-interpolated value noise on a two-dimensional torus."""
    lattice = np.random.Generator(np.random.PCG64(seed)).uniform(-1, 1, (ny, nx))
    x, y = (u % 1) * nx, (v % 1) * ny
    i, j = x.astype(int), y.astype(int)
    dx, dy = x - i, y - j
    a = dx**3 * (dx * (6 * dx - 15) + 10)
    b = dy**3 * (dy * (6 * dy - 15) + 10)
    low = (1 - a) * lattice[j % ny, i % nx] + a * lattice[j % ny, (i + 1) % nx]
    high = (1 - a) * lattice[(j + 1) % ny, i % nx] + a * lattice[
        (j + 1) % ny, (i + 1) % nx
    ]
    return low * (1 - b) + high * b


def color(low: tuple, high: tuple, mask: Field) -> Field:
    return np.array(low) + np.clip(mask, 0, 1)[..., None] * (np.array(high) - low)


def crystal(u: Field, v: Field) -> tuple[Field, Field, Field]:
    """The upper envelope of seeded support planes forms fractured glass faces."""
    rng = np.random.Generator(np.random.PCG64(81))
    first = np.full_like(u, np.inf)
    second = first.copy()
    face = np.zeros_like(u)
    for x, y, tint in rng.uniform(size=(24, 3)):
        dx, dy = (u - x + 0.5) % 1 - 0.5, (v - y + 0.5) % 1 - 0.5
        dist = (dx + 0.39 * dy) ** 2 + (0.78 * dy) ** 2
        second = np.minimum(second, np.maximum(first, dist))
        face = np.where(dist < first, tint, face)
        first = np.minimum(first, dist)
    gap = second - first
    return first, face, np.exp(-np.square(gap / 0.00086))


def channels(surface_id: str, samples: int, tile_m: float) -> dict[str, Field]:
    """Fields are indexed [v increasing, u increasing] with one unique row per sample."""
    v, u = np.mgrid[0:samples, 0:samples] / samples
    grain = noise(u, v, 103, 97, 29)
    broad = noise(u, v, 5, 5, 17)
    mottling = noise(u, v, 21, 17, 13)
    zero = np.zeros_like(u)
    emissive = None
    if surface_id == "brushed-titanium":
        brush = noise(u, v, 3, 117, 7)
        cut = np.clip((-noise(u + 0.009 * broad, v, 9, 71, 5) - 0.42) * 2.2, 0, 1)
        base = color(
            (171, 177, 183),
            (208, 211, 212),
            0.54 + 0.26 * brush + 0.12 * broad - 0.2 * cut,
        )
        height = 0.000012 * brush - 0.000025 * cut
        rough = 0.33 + 0.053 * brush + 0.022 * broad + 0.013 * cut
        metal = 0.966 - 0.018 * cut + 0.01 * mottling
        ao = 1 - 0.015 * cut
    elif surface_id == "tactical-ceramic":
        pores = np.clip((-grain - 0.39) * 2.5, 0, 1)
        base = color(
            (48, 56, 67),
            (77, 86, 97),
            0.52 + 0.29 * broad + 0.12 * mottling - 0.13 * pores,
        )
        height = 0.000024 * mottling + 0.000016 * grain - 0.000042 * pores
        rough = 0.635 + 0.057 * mottling + 0.029 * broad + 0.033 * pores
        metal = zero
        ao = 1 - 0.05 * pores
    elif surface_id == "dark-gunmetal":
        # Fine diagonal finishing marks interrupt the darker oxide film.
        tool = 0.65 * noise(u, v + u, 9, 91, 41) + 0.35 * noise(u, v, 19, 41, 43)
        polished = np.clip(
            0.48 + 0.31 * noise(u, v, 9, 7, 59) + 0.17 * broad + 0.13 * mottling, 0, 1
        )
        base = color(
            (54, 61, 70), (109, 117, 126), 0.12 + 0.61 * polished + 0.12 * tool
        )
        height = 0.000018 * tool + 0.000022 * mottling
        rough = 0.411 - 0.077 * polished + 0.024 * tool
        metal = 0.86 + 0.10 * polished
        ao = 0.995 - 0.016 * np.maximum(-tool, 0)
    elif surface_id == "obsidian-chitin":
        # Recurved accretion lines bend through soft lanes in the shell.
        wave = 0.43 * noise(u, v, 3, 3, 31) + 0.20 * np.sin(TAU * (u + v))
        flow = 6 * v - 2 * u + wave + 0.18 * broad
        ridge = np.exp(-np.square(np.sin(np.pi * flow) / 0.34))
        ridge *= 0.70 + 0.28 * noise(u, v, 4, 5, 73)
        fibril = noise(u, v + 0.06 * wave, 11, 87, 72)
        base = color(
            (31, 25, 38),
            (75, 65, 79),
            0.52 + 0.22 * broad + 0.15 * fibril - 0.13 * ridge,
        )
        height = 0.00023 * ridge + 0.000025 * fibril + 0.00009 * broad
        rough = 0.438 - 0.056 * ridge + 0.037 * fibril + 0.013 * broad
        metal = zero
        ao = 0.993 - 0.035 * ridge
    elif surface_id == "rift-obsidian":
        dist, face, fault = crystal(u, v)
        base = color((33, 24, 55), (79, 59, 100), 0.16 + 0.53 * face + 0.12 * broad)
        height = -0.028 * dist + 0.000018 * mottling - 0.000068 * fault
        rough = 0.158 + 0.09 * face + 0.025 * fault + 0.012 * mottling
        metal = zero
        ao = 1 - 0.08 * fault
        # Mineral inclusions light only intermittent sections of a fracture.
        active = fault * np.clip(0.15 + 1.65 * broad, 0, 1)
        emissive = color((0, 0, 0), (108, 57, 176), active)
        teal = active * np.clip(2 * mottling, 0, 1)
        emissive += teal[..., None] * np.array((-59, 96, -21))
    else:
        raise KeyError(surface_id)
    spacing = tile_m / samples
    du = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) / (2 * spacing)
    dv = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) / (2 * spacing)
    n = np.stack((-du, -dv, np.ones_like(du)), axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    result = {
        "basecolor": base / 255,
        "normal": 0.5 + 0.5 * n,
        "orm": np.stack((ao, rough, metal), axis=-1),
    }
    if emissive is not None:
        result["emissive"] = emissive / 255
    return result
