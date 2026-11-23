"""Author deterministic Blender 5.2.2 LTS animations for all hard-surface Rift Bastion assets.

Covers:
  - Core Bastion (5 clips: ShieldEmitterSweep, idle_pulse, hit_flinch, critical_overload, victory_surge)
  - Dimensional Rift Portal (4 clips: idle_rift, open_tear, spawn_surge, close_seal)
  - Surface Clamp Base LOD0/LOD1 (3 clips: deploy_lock, idle_locked, retract_release)
  - Repulsor Hover-Ring Pod LOD0/LOD1 (4 clips: hover_idle, deploy_ignite, emp_stall, retract_powerdown)
  - All 12 Turret Heads x LOD0/LOD1 (5 clips each: idle_scan, deploy, fire_recoil, emp_disrupted, upgrade_surge)

Run with Blender 5.2.2 LTS:
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python blender/animate_hard_surface.py
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
import tempfile
from pathlib import Path
from typing import Any

import bpy
from mathutils import Euler, Quaternion, Vector

ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = ROOT / "assets-source/models"
MANIFEST_PATH = MODELS_DIR / "manifest.json"
FPS = 30

INVADER_IDS = {
    "skitter-crawler",
    "wasp-skimmer",
    "carapace-brute",
    "rift-disruptor",
    "apex-broodlord",
}

Json = dict[str, Any]


def read_glb(path: Path) -> tuple[Json, bytes]:
    raw = path.read_bytes()
    magic, version, length = struct.unpack_from("<4s2I", raw, 0)
    if (magic, version, length) != (b"glTF", 2, len(raw)):
        raise ValueError(f"{path}: invalid GLB header")
    json_len, json_type = struct.unpack_from("<I4s", raw, 12)
    if json_type != b"JSON":
        raise ValueError(f"{path}: missing JSON chunk")
    doc: Json = json.loads(raw[20 : 20 + json_len].decode("utf-8"))
    bin_off = 20 + json_len
    bin_len, bin_type = struct.unpack_from("<I4s", raw, bin_off)
    if bin_type != b"BIN\0":
        raise ValueError(f"{path}: missing BIN chunk")
    declared = doc["buffers"][0]["byteLength"]
    return doc, raw[bin_off + 8 : bin_off + 8 + declared]


def write_glb(path: Path, doc: Json, payload: bytes) -> str:
    padded_bin = payload + b"\x00" * (-len(payload) % 4)
    doc["buffers"] = [{"byteLength": len(padded_bin)}]
    json_bytes = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    json_bytes += b" " * (-len(json_bytes) % 4)
    total = 28 + len(json_bytes) + len(padded_bin)
    out = (
        struct.pack("<4s2I", b"glTF", 2, total)
        + struct.pack("<I4s", len(json_bytes), b"JSON")
        + json_bytes
        + struct.pack("<I4s", len(padded_bin), b"BIN\0")
        + padded_bin
    )
    path.write_bytes(out)
    return hashlib.sha256(out).hexdigest()


def gltf_to_blender_pos(t: list[float] | tuple[float, float, float]) -> Vector:
    return Vector((float(t[0]), -float(t[2]), float(t[1])))


def gltf_to_blender_quat(r: list[float] | tuple[float, float, float, float]) -> Quaternion:
    # glTF [x, y, z, w] in Y-up -> Blender (w, x, y, z) in Z-up: (x, y, z)_g -> (x, -z, y)_b
    return Quaternion((float(r[3]), float(r[0]), -float(r[2]), float(r[1]))).normalized()


def gltf_to_blender_scale(s: list[float] | tuple[float, float, float]) -> Vector:
    return Vector((float(s[0]), float(s[2]), float(s[1])))


def smoothstep(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return x * x * (3.0 - 2.0 * x)


def ease_out_cubic(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return 1.0 - (1.0 - x) ** 3


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"


def build_hierarchy_from_glb(doc: Json) -> dict[str, bpy.types.Object]:
    nodes = doc["nodes"]
    parents: dict[int, int] = {}
    for idx, node in enumerate(nodes):
        for child in node.get("children", []):
            parents[child] = idx

    objects_by_idx: dict[int, bpy.types.Object] = {}
    objects_by_name: dict[str, bpy.types.Object] = {}
    for idx, node in enumerate(nodes):
        name = node.get("name", f"node_{idx}")
        obj = bpy.data.objects.new(name, None)
        bpy.context.collection.objects.link(obj)
        obj.rotation_mode = "QUATERNION"
        objects_by_idx[idx] = obj
        objects_by_name[name] = obj

    for idx, node in enumerate(nodes):
        obj = objects_by_idx[idx]
        if idx in parents:
            obj.parent = objects_by_idx[parents[idx]]
        obj.location = gltf_to_blender_pos(node.get("translation", [0.0, 0.0, 0.0]))
        obj.rotation_quaternion = gltf_to_blender_quat(
            node.get("rotation", [0.0, 0.0, 0.0, 1.0])
        )
        obj.scale = gltf_to_blender_scale(node.get("scale", [1.0, 1.0, 1.0]))

    bpy.context.view_layer.update()
    return objects_by_name


def record_clip(
    clip_name: str,
    frames: int,
    objects: dict[str, bpy.types.Object],
    rest: dict[str, tuple[Vector, Quaternion, Vector]],
    evaluator: Any,
) -> None:
    """Sample keyframes for `clip_name` across participating objects and push onto NLA tracks."""
    actions: dict[str, bpy.types.Action] = {}
    prev_quats: dict[str, Quaternion] = {}

    for i in range(frames + 1):
        t = i / frames
        frame_no = i
        poses: dict[str, dict[str, Any]] = evaluator(t)
        for obj_name, channels in poses.items():
            obj = objects.get(obj_name)
            if obj is None:
                continue
            if obj_name not in actions:
                ad = obj.animation_data or obj.animation_data_create()
                act = bpy.data.actions.new(f"{clip_name}__{obj_name}")
                act.use_fake_user = True
                ad.action = act
                actions[obj_name] = act
            base_loc, base_rot, base_scl = rest[obj_name]

            if "loc_delta" in channels:
                obj.location = base_loc + Vector(channels["loc_delta"])
                obj.keyframe_insert(data_path="location", frame=frame_no)
            if "rot_quat" in channels:
                q: Quaternion = (base_rot @ channels["rot_quat"]).normalized()
                if obj_name in prev_quats:
                    q.make_compatible(prev_quats[obj_name])
                prev_quats[obj_name] = q.copy()
                obj.rotation_quaternion = q
                obj.keyframe_insert(data_path="rotation_quaternion", frame=frame_no)
            if "scale_mul" in channels:
                sm = channels["scale_mul"]
                obj.scale = Vector(
                    (base_scl.x * sm[0], base_scl.y * sm[1], base_scl.z * sm[2])
                )
                obj.keyframe_insert(data_path="scale", frame=frame_no)

    for obj_name, act in actions.items():
        obj = objects[obj_name]
        ad = obj.animation_data
        track = ad.nla_tracks.new()
        track.name = clip_name
        strip = track.strips.new(clip_name, 0, act)
        strip.action_frame_start = 0
        strip.action_frame_end = frames
        track.mute = True
        ad.action = None
        base_loc, base_rot, base_scl = rest[obj_name]
        obj.location = base_loc.copy()
        obj.rotation_quaternion = base_rot.copy()
        obj.scale = base_scl.copy()


def author_core_bastion(
    objects: dict[str, bpy.types.Object],
    rest: dict[str, tuple[Vector, Quaternion, Vector]],
) -> list[str]:
    tau = math.tau

    def sweep(t: float) -> dict[str, dict[str, Any]]:
        return {
            "shieldEmitterRing": {"rot_quat": Euler((0.0, 0.0, tau * t), "XYZ").to_quaternion()},
            "energyCrystal": {
                "loc_delta": (0.0, 0.0, 0.014 * math.sin(tau * t * 2.0)),
                "rot_quat": Euler((0.0, 0.0, tau * t), "XYZ").to_quaternion(),
            },
            "containmentCollar": {
                "rot_quat": Euler((0.0, 0.0, -tau * t), "XYZ").to_quaternion(),
            },
        }

    def idle_pulse(t: float) -> dict[str, dict[str, Any]]:
        return {
            "energyCrystal": {
                "loc_delta": (0.0, 0.0, 0.016 * math.sin(tau * t)),
                "rot_quat": Euler(
                    (0.05 * math.sin(tau * t), 0.05 * math.cos(tau * t), tau * t), "XYZ"
                ).to_quaternion(),
            },
            "containmentCollar": {
                "rot_quat": Euler((0.0, 0.0, -tau * t), "XYZ").to_quaternion(),
            },
            "shieldEmitterRing": {
                "loc_delta": (0.0, 0.0, 0.005 * (1.0 - math.cos(tau * t)) * 0.5),
                "rot_quat": Euler((0.0, 0.0, tau * t), "XYZ").to_quaternion(),
            },
        }

    def hit_flinch(t: float) -> dict[str, dict[str, Any]]:
        env = math.sin(math.pi * t) ** 1.4
        damp = math.exp(-4.5 * t) * math.sin(tau * 4.5 * t)
        surge = math.sin(math.pi * min(1.0, t / 0.55)) ** 2 if t < 0.55 else 0.0
        return {
            "energyCrystal": {
                "loc_delta": (0.012 * damp, -0.008 * damp, 0.032 * surge + 0.008 * damp),
                "rot_quat": Euler((0.18 * damp, -0.15 * damp, 0.55 * env), "XYZ").to_quaternion(),
            },
            "containmentCollar": {
                "loc_delta": (0.0, 0.0, -0.012 * surge),
                "rot_quat": Euler((0.0, 0.0, -0.35 * surge), "XYZ").to_quaternion(),
            },
            "shieldEmitterRing": {
                "loc_delta": (0.0, 0.0, 0.028 * surge),
                "rot_quat": Euler((0.0, 0.0, 1.4 * smoothstep(t)), "XYZ").to_quaternion(),
            },
        }

    def critical_overload(t: float) -> dict[str, dict[str, Any]]:
        jitter_x = 0.010 * math.sin(tau * 5.0 * t)
        jitter_y = 0.009 * math.cos(tau * 7.0 * t)
        bob = 0.022 * math.sin(tau * 2.0 * t)
        return {
            "energyCrystal": {
                "loc_delta": (jitter_x, jitter_y, bob),
                "rot_quat": Euler(
                    (0.14 * math.sin(tau * 3.0 * t), 0.14 * math.cos(tau * 4.0 * t), tau * 2.0 * t),
                    "XYZ",
                ).to_quaternion(),
            },
            "containmentCollar": {
                "loc_delta": (0.0, 0.0, 0.008 * math.sin(tau * 4.0 * t)),
                "rot_quat": Euler((0.0, 0.0, 0.28 * math.sin(tau * 3.0 * t)), "XYZ").to_quaternion(),
            },
            "shieldEmitterRing": {
                "loc_delta": (0.0, 0.0, 0.014 * (1.0 - math.cos(tau * 2.0 * t)) * 0.5),
                "rot_quat": Euler((0.0, 0.0, -tau * t), "XYZ").to_quaternion(),
            },
        }

    def victory_surge(t: float) -> dict[str, dict[str, Any]]:
        arc = math.sin(math.pi * t) ** 1.3
        spin = tau * 2.0 * smoothstep(t)
        return {
            "energyCrystal": {
                "loc_delta": (0.0, 0.0, 0.068 * arc),
                "rot_quat": Euler((0.0, 0.0, spin), "XYZ").to_quaternion(),
            },
            "containmentCollar": {
                "loc_delta": (0.0, 0.0, 0.012 * arc),
                "rot_quat": Euler((0.0, 0.0, -tau * smoothstep(t)), "XYZ").to_quaternion(),
            },
            "shieldEmitterRing": {
                "loc_delta": (0.0, 0.0, 0.036 * arc),
                "rot_quat": Euler((0.0, 0.0, tau * smoothstep(t)), "XYZ").to_quaternion(),
            },
        }

    clips = [
        ("ShieldEmitterSweep", 240, sweep),
        ("idle_pulse", 120, idle_pulse),
        ("hit_flinch", 24, hit_flinch),
        ("critical_overload", 48, critical_overload),
        ("victory_surge", 72, victory_surge),
    ]
    for name, frames, fn in clips:
        record_clip(name, frames, objects, rest, fn)
    return [c[0] for c in clips]


def author_rift_portal(
    objects: dict[str, bpy.types.Object],
    rest: dict[str, tuple[Vector, Quaternion, Vector]],
) -> list[str]:
    tau = math.tau

    def idle_rift(t: float) -> dict[str, dict[str, Any]]:
        # Keep portalInterior flush at full ring scale (1.0) so zero bezel gap occurs;
        # dimensional swirl & breathing are driven by the GLSL Rift Portal shader.
        dy = 0.004 * math.sin(tau * t)
        return {
            "portalInterior": {
                "loc_delta": (0.0, dy, 0.0),
                "scale_mul": (1.0, 1.0, 1.0),
            },
        }

    def open_tear(t: float) -> dict[str, dict[str, Any]]:
        # Uniform radial center-out expansion filling the elliptical bezel smoothly to 1.0
        s = max(0.002, ease_out_cubic(min(1.0, t / 0.82)))
        lock_kick = 0.006 * math.sin(math.pi * max(0.0, (t - 0.72) / 0.28)) if t > 0.72 else 0.0
        return {
            "portalInterior": {"scale_mul": (s, 1.0, s)},
            "portalFrame": {"loc_delta": (0.0, -lock_kick, 0.0)},
        }

    def spawn_surge(t: float) -> dict[str, dict[str, Any]]:
        # Stay flush inside the bezel while pulsing forward toward the room with a frame kick
        push = math.sin(math.pi * max(0.0, (t - 0.14) / 0.86)) ** 1.35 if t > 0.14 else 0.0
        return {
            "portalInterior": {
                "loc_delta": (0.0, -0.014 * push, 0.0),
                "scale_mul": (1.0, 1.0, 1.0),
            },
            "portalFrame": {
                "loc_delta": (0.0, -0.006 * push, 0.0),
            },
        }

    def close_seal(t: float) -> dict[str, dict[str, Any]]:
        # Uniform radial collapse from full ring back to center singularity
        s = max(0.002, 1.0 - smoothstep(t))
        return {
            "portalInterior": {"scale_mul": (s, 1.0, s)},
        }

    clips = [
        ("idle_rift", 90, idle_rift),
        ("open_tear", 34, open_tear),
        ("spawn_surge", 28, spawn_surge),
        ("close_seal", 28, close_seal),
    ]
    for name, frames, fn in clips:
        record_clip(name, frames, objects, rest, fn)
    return [c[0] for c in clips]


def author_surface_clamp(
    objects: dict[str, bpy.types.Object],
    rest: dict[str, tuple[Vector, Quaternion, Vector]],
) -> list[str]:
    leg_axes: dict[str, Vector] = {}
    for leg_idx in range(4):
        name = f"turret-clamp-leg-{leg_idx}"
        loc = rest[name][0]
        radial = Vector((loc.x, loc.y, 0.0)).normalized()
        # In Blender Z-up, radial x +Z is tangent axis where positive angle lifts leg tip UP
        leg_axes[name] = radial.cross(Vector((0.0, 0.0, 1.0))).normalized()

    def deploy_lock(t: float) -> dict[str, dict[str, Any]]:
        hub_drop = 1.0 - ease_out_cubic(min(1.0, t / 0.68))
        settle = -0.003 * math.sin(math.pi * max(0.0, (t - 0.68) / 0.32)) if t > 0.68 else 0.0
        hub_z = 0.028 * hub_drop + settle
        poses: dict[str, dict[str, Any]] = {
            "turret-clamp-hub": {"loc_delta": (0.0, 0.0, hub_z)},
        }
        for idx in range(4):
            name = f"turret-clamp-leg-{idx}"
            delay = 0.0 if idx in (0, 2) else 0.08
            u = max(0.0, min(1.0, (t - delay) / 0.70))
            fold = 1.0 - ease_out_cubic(u)
            bounce = 0.035 * math.sin(math.pi * max(0.0, (t - (0.70 + delay)) / 0.22)) if 0.70 + delay < t < 0.92 + delay else 0.0
            angle = math.radians(52.0) * fold + bounce
            poses[name] = {
                "loc_delta": (0.0, 0.0, hub_z),
                "rot_quat": Quaternion(leg_axes[name], angle),
            }
        return poses

    def idle_locked(t: float) -> dict[str, dict[str, Any]]:
        pulse = 0.0008 * math.sin(math.tau * t)
        return {
            "turret-clamp-hub": {"loc_delta": (0.0, 0.0, pulse)},
        }

    def retract_release(t: float) -> dict[str, dict[str, Any]]:
        u = smoothstep(t)
        hub_z = 0.028 * u
        poses: dict[str, dict[str, Any]] = {
            "turret-clamp-hub": {"loc_delta": (0.0, 0.0, hub_z)},
        }
        for idx in range(4):
            name = f"turret-clamp-leg-{idx}"
            delay = 0.0 if idx in (1, 3) else 0.06
            lu = smoothstep(max(0.0, min(1.0, (t - delay) / 0.85)))
            angle = math.radians(52.0) * lu
            poses[name] = {
                "loc_delta": (0.0, 0.0, hub_z),
                "rot_quat": Quaternion(leg_axes[name], angle),
            }
        return poses

    clips = [
        ("deploy_lock", 30, deploy_lock),
        ("idle_locked", 45, idle_locked),
        ("retract_release", 26, retract_release),
    ]
    for name, frames, fn in clips:
        record_clip(name, frames, objects, rest, fn)
    return [c[0] for c in clips]


def author_hover_pod(
    objects: dict[str, bpy.types.Object],
    rest: dict[str, tuple[Vector, Quaternion, Vector]],
) -> list[str]:
    tau = math.tau

    def hover_idle(t: float) -> dict[str, dict[str, Any]]:
        bob = 0.011 * (1.0 - math.cos(tau * t)) * 0.5
        tilt_x = math.radians(2.2) * math.sin(tau * t)
        tilt_y = math.radians(2.2) * math.cos(tau * t)
        return {
            "turret-hover-repulsor-ring": {
                "loc_delta": (0.0, 0.0, bob),
                "rot_quat": Euler((tilt_x, tilt_y, tau * t), "XYZ").to_quaternion(),
            },
            "turret-hover-repulsor-core": {
                "loc_delta": (0.0, 0.0, bob * 0.85),
                "rot_quat": Euler((-tilt_x * 0.5, -tilt_y * 0.5, -tau * t), "XYZ").to_quaternion(),
            },
        }

    def deploy_ignite(t: float) -> dict[str, dict[str, Any]]:
        lift = ease_out_cubic(min(1.0, t / 0.72))
        over = 0.012 * math.sin(math.pi * max(0.0, (t - 0.55) / 0.45)) if t > 0.55 else 0.0
        z = -0.024 * (1.0 - lift) + over
        spin = tau * 2.0 * (t * t * 0.6 + t * 0.4)
        return {
            "turret-hover-repulsor-ring": {
                "loc_delta": (0.0, 0.0, z),
                "rot_quat": Euler((0.0, 0.0, spin), "XYZ").to_quaternion(),
            },
            "turret-hover-repulsor-core": {
                "loc_delta": (0.0, 0.0, z),
                "rot_quat": Euler((0.0, 0.0, -spin * 0.5), "XYZ").to_quaternion(),
            },
        }

    def emp_stall(t: float) -> dict[str, dict[str, Any]]:
        dip = -0.014 * (0.5 + 0.5 * math.sin(tau * 2.0 * t)) - 0.006 * math.sin(tau * 5.0 * t)
        rx = math.radians(9.5) * math.sin(tau * 3.0 * t)
        ry = math.radians(8.5) * math.cos(tau * 2.0 * t)
        stutter_z = 0.45 * math.sin(tau * t) + 0.18 * math.sin(tau * 4.0 * t)
        return {
            "turret-hover-repulsor-ring": {
                "loc_delta": (0.0, 0.0, dip),
                "rot_quat": Euler((rx, ry, stutter_z), "XYZ").to_quaternion(),
            },
            "turret-hover-repulsor-core": {
                "loc_delta": (0.0, 0.0, dip * 0.8),
                "rot_quat": Euler((rx * 0.6, ry * 0.6, -stutter_z * 0.5), "XYZ").to_quaternion(),
            },
        }

    def retract_powerdown(t: float) -> dict[str, dict[str, Any]]:
        u = smoothstep(t)
        z = 0.018 * (1.0 - u)
        spin = tau * (u - 0.45 * u * u)
        return {
            "turret-hover-repulsor-ring": {
                "loc_delta": (0.0, 0.0, z),
                "rot_quat": Euler((0.0, 0.0, spin), "XYZ").to_quaternion(),
            },
            "turret-hover-repulsor-core": {
                "loc_delta": (0.0, 0.0, z),
                "rot_quat": Euler((0.0, 0.0, -spin * 0.4), "XYZ").to_quaternion(),
            },
        }

    clips = [
        ("hover_idle", 90, hover_idle),
        ("deploy_ignite", 34, deploy_ignite),
        ("emp_stall", 36, emp_stall),
        ("retract_powerdown", 28, retract_powerdown),
    ]
    for name, frames, fn in clips:
        record_clip(name, frames, objects, rest, fn)
    return [c[0] for c in clips]


def author_turret(
    model_id: str,
    objects: dict[str, bpy.types.Object],
    rest: dict[str, tuple[Vector, Quaternion, Vector]],
) -> list[str]:
    tau = math.tau
    has_rotary = "rotaryCluster" in objects
    family = (
        "autocannon"
        if model_id.startswith("m44-")
        else "mortar"
        if model_id.startswith("helios-")
        else "cryo"
        if model_id.startswith("glacier-")
        else "rail"
    )
    tier = 3 if model_id.endswith("-t3") else 2 if model_id.endswith("-t2") else 1

    def idle_scan(t: float) -> dict[str, dict[str, Any]]:
        # Smooth sentry sweep with deliberate pauses at left/right sectors
        yaw = math.radians(38.0) * math.sin(tau * t) + math.radians(5.0) * math.sin(tau * 3.0 * t)
        pitch = math.radians(-4.5) * math.sin(tau * 2.0 * t) - math.radians(2.0) * (1.0 - math.cos(tau * t)) * 0.5
        poses: dict[str, dict[str, Any]] = {
            "yawRing": {"rot_quat": Euler((0.0, 0.0, yaw), "XYZ").to_quaternion()},
            "pitchCradle": {"rot_quat": Euler((pitch, 0.0, 0.0), "XYZ").to_quaternion()},
        }
        if has_rotary:
            poses["rotaryCluster"] = {
                "rot_quat": Euler((0.0, tau * 0.5 * t, 0.0), "XYZ").to_quaternion()
            }
        return poses

    def deploy(t: float) -> dict[str, dict[str, Any]]:
        u = ease_out_cubic(min(1.0, t / 0.78))
        overshoot = -math.radians(4.5) * math.sin(math.pi * max(0.0, (t - 0.65) / 0.35)) if t > 0.65 else 0.0
        yaw = math.radians(-26.0) * (1.0 - u)
        pitch = math.radians(20.0) * (1.0 - u) + overshoot
        retract_y = 0.022 * (1.0 - ease_out_cubic(min(1.0, t / 0.65)))
        poses: dict[str, dict[str, Any]] = {
            "yawRing": {"rot_quat": Euler((0.0, 0.0, yaw), "XYZ").to_quaternion()},
            "pitchCradle": {"rot_quat": Euler((pitch, 0.0, 0.0), "XYZ").to_quaternion()},
            "recoilGroup": {"loc_delta": (0.0, retract_y, 0.0)},
        }
        if has_rotary:
            poses["rotaryCluster"] = {
                "rot_quat": Euler((0.0, tau * smoothstep(t), 0.0), "XYZ").to_quaternion()
            }
        return poses

    def fire_recoil(t: float) -> dict[str, dict[str, Any]]:
        # In Blender Z-up, muzzle points along -Y, so recoil is +Y and muzzle climb is -X
        recoil_y = 0.0
        pitch_kick = 0.0
        rotary_angle = 0.0

        if family == "autocannon":
            if has_rotary:
                # 6-barrel rotary burst
                rotary_angle = tau * 2.0 * t
                burst_env = math.sin(math.pi * t) ** 0.45
                chatter = 0.5 + 0.5 * math.sin(tau * 6.0 * t)
                recoil_y = (0.008 + 0.014 * chatter) * burst_env
                pitch_kick = -math.radians(3.2) * burst_env - math.radians(1.0) * chatter * burst_env
            else:
                # Snappy 3-round kinetic burst
                depth = 0.024 if tier == 1 else 0.029
                for shot_t in (0.08, 0.36, 0.64):
                    dt = t - shot_t
                    if 0.0 <= dt < 0.26:
                        u = dt / 0.26
                        pulse = (u / 0.16) if u < 0.16 else math.exp(-5.5 * (u - 0.16))
                        recoil_y = max(recoil_y, depth * pulse)
                        pitch_kick = min(pitch_kick, -math.radians(3.4) * pulse)
        elif family == "mortar":
            # Heavy plasma mortar elevation + deep hydraulic recoil slam
            depth = 0.040 + 0.006 * tier
            prep = math.sin(math.pi * min(1.0, t / 0.22)) if t < 0.22 else 0.0
            dt = t - 0.18
            kick = 0.0
            if dt >= 0.0:
                u = min(1.0, dt / 0.82)
                kick = (u / 0.10) if u < 0.10 else math.exp(-3.8 * (u - 0.10)) * (1.0 - u)
            recoil_y = depth * kick
            pitch_kick = -math.radians(16.0) * math.sin(math.pi * min(1.0, t / 0.85)) - math.radians(5.0) * kick + math.radians(2.0) * prep
        elif family == "cryo":
            # Capacitor charge tremor + crisp arc discharge kick
            depth = 0.020 + 0.004 * tier
            if t < 0.35:
                charge = t / 0.35
                recoil_y = -0.004 * charge + 0.003 * math.sin(tau * 10.0 * t) * charge
                pitch_kick = math.radians(1.5) * charge
            else:
                u = (t - 0.35) / 0.65
                kick = (u / 0.14) if u < 0.14 else math.exp(-4.5 * (u - 0.14)) * (1.0 - u)
                recoil_y = depth * kick
                pitch_kick = -math.radians(4.2) * kick
        else:
            # Valkyrie Rail Sniper: disciplined lock-on stillness -> instant hypervelocity kick
            depth = 0.042 + 0.005 * tier
            if t >= 0.22:
                u = (t - 0.22) / 0.78
                kick = (u / 0.07) if u < 0.07 else math.exp(-3.6 * (u - 0.07)) * (1.0 - u)
                recoil_y = depth * kick
                pitch_kick = -math.radians(6.0) * kick

        poses: dict[str, dict[str, Any]] = {
            "pitchCradle": {"rot_quat": Euler((pitch_kick, 0.0, 0.0), "XYZ").to_quaternion()},
            "recoilGroup": {"loc_delta": (0.0, recoil_y, 0.0)},
        }
        if has_rotary:
            poses["rotaryCluster"] = {
                "rot_quat": Euler((0.0, rotary_angle, 0.0), "XYZ").to_quaternion()
            }
        return poses

    def emp_disrupted(t: float) -> dict[str, dict[str, Any]]:
        # Power-slumped pitch droop + erratic electrical twitch
        twitch_yaw = math.radians(7.0) * math.sin(tau * 3.0 * t) + math.radians(3.5) * math.sin(tau * 7.0 * t)
        twitch_pitch = math.radians(20.0) + math.radians(4.0) * math.sin(tau * 5.0 * t)
        poses: dict[str, dict[str, Any]] = {
            "yawRing": {"rot_quat": Euler((0.0, 0.0, twitch_yaw), "XYZ").to_quaternion()},
            "pitchCradle": {"rot_quat": Euler((twitch_pitch, 0.0, 0.0), "XYZ").to_quaternion()},
        }
        if has_rotary:
            poses["rotaryCluster"] = {
                "rot_quat": Euler((0.0, 0.35 * math.sin(tau * 4.0 * t), 0.0), "XYZ").to_quaternion()
            }
        return poses

    def upgrade_surge(t: float) -> dict[str, dict[str, Any]]:
        arc = math.sin(math.pi * t) ** 1.2
        yaw = tau * smoothstep(t)
        pitch = -math.radians(16.0) * arc
        poses: dict[str, dict[str, Any]] = {
            "yawRing": {"rot_quat": Euler((0.0, 0.0, yaw), "XYZ").to_quaternion()},
            "pitchCradle": {"rot_quat": Euler((pitch, 0.0, 0.0), "XYZ").to_quaternion()},
            "recoilGroup": {"loc_delta": (0.0, 0.015 * arc, 0.0)},
        }
        if has_rotary:
            poses["rotaryCluster"] = {
                "rot_quat": Euler((0.0, tau * 2.0 * smoothstep(t), 0.0), "XYZ").to_quaternion()
            }
        return poses

    fire_frames = 30 if family == "autocannon" and has_rotary else 24 if family == "autocannon" else 34 if family == "mortar" else 28 if family == "cryo" else 36
    clips = [
        ("idle_scan", 144, idle_scan),
        ("deploy", 28, deploy),
        ("fire_recoil", fire_frames, fire_recoil),
        ("emp_disrupted", 42, emp_disrupted),
        ("upgrade_surge", 36, upgrade_surge),
    ]
    for name, frames, fn in clips:
        record_clip(name, frames, objects, rest, fn)
    return [c[0] for c in clips]


def graft_blender_animations(
    target_doc: Json,
    target_bin: bytes,
    anim_doc: Json,
    anim_bin: bytes,
) -> tuple[Json, bytes]:
    """Copy Blender-exported glTF animations & accessors onto the approved GLB without touching meshes/textures."""
    target_node_by_name = {
        node["name"]: idx for idx, node in enumerate(target_doc["nodes"]) if "name" in node
    }
    anim_nodes = anim_doc.get("nodes", [])
    anim_views = anim_doc.get("bufferViews", [])
    anim_accessors = anim_doc.get("accessors", [])

    out_bin = bytearray(target_bin)
    out_views = list(target_doc.get("bufferViews", []))
    out_accessors = list(target_doc.get("accessors", []))

    copied_accessors: dict[int, int] = {}

    def copy_accessor(src_acc_idx: int) -> int:
        if src_acc_idx in copied_accessors:
            return copied_accessors[src_acc_idx]
        acc = dict(anim_accessors[src_acc_idx])
        src_view = anim_views[acc["bufferView"]]
        v_off = src_view.get("byteOffset", 0)
        v_len = src_view["byteLength"]
        raw_slice = anim_bin[v_off : v_off + v_len]

        out_bin.extend(b"\x00" * (-len(out_bin) % 4))
        new_view_idx = len(out_views)
        new_view: Json = {
            "buffer": 0,
            "byteOffset": len(out_bin),
            "byteLength": len(raw_slice),
        }
        if "byteStride" in src_view:
            new_view["byteStride"] = src_view["byteStride"]
        out_views.append(new_view)
        out_bin.extend(raw_slice)

        acc["bufferView"] = new_view_idx
        new_acc_idx = len(out_accessors)
        out_accessors.append(acc)
        copied_accessors[src_acc_idx] = new_acc_idx
        return new_acc_idx

    new_animations: list[Json] = []
    for anim in anim_doc.get("animations", []):
        new_samplers: list[Json] = []
        sampler_remap: dict[int, int] = {}
        new_channels: list[Json] = []

        for ch in anim.get("channels", []):
            target = ch.get("target", {})
            src_node_idx = target.get("node")
            if src_node_idx is None:
                continue
            src_name = anim_nodes[src_node_idx].get("name")
            if src_name not in target_node_by_name:
                raise ValueError(f"Animated node {src_name!r} not found in target GLB")
            src_s = ch["sampler"]
            if src_s not in sampler_remap:
                s = anim["samplers"][src_s]
                sampler_remap[src_s] = len(new_samplers)
                new_samplers.append(
                    {
                        "input": copy_accessor(s["input"]),
                        "interpolation": s.get("interpolation", "LINEAR"),
                        "output": copy_accessor(s["output"]),
                    }
                )
            new_channels.append(
                {
                    "sampler": sampler_remap[src_s],
                    "target": {
                        "node": target_node_by_name[src_name],
                        "path": target["path"],
                    },
                }
            )

        if new_channels:
            new_animations.append(
                {
                    "name": anim["name"],
                    "channels": new_channels,
                    "samplers": new_samplers,
                }
            )

    new_doc = dict(target_doc)
    new_doc["bufferViews"] = out_views
    new_doc["accessors"] = out_accessors
    new_doc["animations"] = new_animations
    return new_doc, bytes(out_bin)


def process_model(record: Json, tmp_dir: Path) -> list[str]:
    model_id = record["id"]
    glb_path = MODELS_DIR / record["file"]
    target_doc, target_bin = read_glb(glb_path)

    clear_scene()
    objects = build_hierarchy_from_glb(target_doc)
    rest = {
        name: (obj.location.copy(), obj.rotation_quaternion.copy(), obj.scale.copy())
        for name, obj in objects.items()
    }

    if model_id == "core-bastion":
        expected = author_core_bastion(objects, rest)
    elif model_id == "rift-portal":
        expected = author_rift_portal(objects, rest)
    elif model_id == "surface-clamp":
        expected = author_surface_clamp(objects, rest)
    elif model_id == "hover-pod":
        expected = author_hover_pod(objects, rest)
    else:
        expected = author_turret(model_id, objects, rest)

    export_path = tmp_dir / f"{model_id}-lod{record['lod']}-anims.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(export_path),
        export_format="GLB",
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_nla_strips=True,
        export_optimize_animation_size=False,
        export_bake_animation=False,
        export_reset_pose_bones=True,
    )

    anim_doc, anim_bin = read_glb(export_path)
    exported_names = [a["name"] for a in anim_doc.get("animations", [])]
    if sorted(exported_names) != sorted(expected):
        raise ValueError(
            f"{model_id} LOD{record['lod']}: expected clips {expected}, Blender exported {exported_names}"
        )

    merged_doc, merged_bin = graft_blender_animations(target_doc, target_bin, anim_doc, anim_bin)
    new_sha = write_glb(glb_path, merged_doc, merged_bin)
    record["sha256"] = new_sha
    record["animations"] = exported_names
    print(f"Animated {model_id} LOD{record['lod']}: {len(exported_names)} clips -> {exported_names}")
    return exported_names


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="rift-anim-") as tmp:
        tmp_dir = Path(tmp)
        for record in manifest["models"]:
            if record["id"] in INVADER_IDS:
                continue
            process_model(record, tmp_dir)

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("Updated assets-source/models/manifest.json successfully.")


if __name__ == "__main__":
    main()
