"""Matched source and decoded Apex Broodlord views, 24-frame orbit and performed clip sheet."""

import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import bpy
import gpu
import numpy as np

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / "scripts/assets")]
from build_materials import png
from core_bastion import color
from ktx2 import decode_ktx2
from review_core_bastion import import_glb, stage, use_decoded_maps
from review_skitter import montage, neutral, render
from verify_skitter import positions, select_action

VIEWS = {
    "oblique": ((1.2, -1.48, 0.82), (0, 0, 0.41), 1.18),
    "front": ((0, -1.8, 0.63), (0, 0, 0.41), 1.06),
    "flank": ((1.6, 0.08, 0.66), (0, 0, 0.41), 1.16),
    "underside": ((0.833, -1.011, -1.2645), (-0.027, 0.069, 0.2455), 1.30),
}
POSES = {
    "boss_march": (0.18, 0.43, 0.72),
    "spawn_adds": (0, 0.5, 1),
    "emp_roar": (0, 0.43, 1),
    "phase2_shift": (0, 0.52, 1),
    "hit": (0, 0.5, 1),
    "death": (0, 0.47, 1),
}


def phase_control(piece: Path, ktx: Path) -> bpy.types.NodeSocket:
    obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
    tree = obj.active_material.node_tree
    sh = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    source = sh.inputs["Emission Color"].links[0].from_socket
    data = np.frombuffer(
        decode_ktx2(ktx, (piece / "phase2-cracks.ktx2").read_bytes()), np.uint8
    ).reshape(2048, 2048, 4)
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / "cracks.png"
        png(dest, data[::-1, :, :3], True)
        image = bpy.data.images.load(str(dest))
        image.colorspace_settings.name = "sRGB"
        image.pack()
    tex = tree.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tint = tree.nodes.new("ShaderNodeMixRGB")
    tint.blend_type = "MULTIPLY"
    tint.inputs[0].default_value = 1
    tint.inputs[2].default_value = color("ff4d00")
    tree.links.new(tex.outputs["Color"], tint.inputs[1])
    add = tree.nodes.new("ShaderNodeMixRGB")
    add.blend_type = "ADD"
    tree.links.new(source, add.inputs[1])
    tree.links.new(tint.outputs[0], add.inputs[2])
    tree.links.new(add.outputs[0], sh.inputs["Emission Color"])
    add.inputs[0].default_value = 0
    return add.inputs[0]


def phase_pixels(path: Path) -> np.ndarray:
    image = bpy.data.images.load(str(path), check_existing=False)
    image.colorspace_settings.name = "Non-Color"
    pixels = np.empty((image.size[1], image.size[0], 4), np.float32)
    image.pixels.foreach_get(pixels.ravel())
    bpy.data.images.remove(image)
    return pixels[:, :, :3]


def movie(pattern: Path, destination: Path, fps: int) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-framerate",
            str(fps),
            "-i",
            str(pattern),
            "-c:v",
            "libx264",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(destination),
        ],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", required=True, type=Path)
    parser.add_argument("--ktx", required=True, type=Path)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece = args.piece.resolve()
    out = piece / "review"
    out.mkdir(exist_ok=True)
    gpu.init()
    backend = gpu.platform.backend_type_get()
    assert bpy.app.version == (5, 2, 2) and backend == "METAL"
    result = {
        "engine": "EEVEE",
        "backend": backend,
        "matched_views": {},
        "animations": {},
        "phase_proof": {},
        "underside_silhouette_margins_px": {},
    }
    shots = []
    for level in ("high", "lod1", "lod0"):
        if level == "high":
            bpy.ops.wm.open_mainfile(filepath=str(piece / "high.blend"))
        else:
            source = piece / f"apex-broodlord-{level}.glb"
            import_glb(source)
            use_decoded_maps(source, args.ktx.resolve())
        arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
        neutral(arm)
        blend = phase_control(piece, args.ktx.resolve()) if level != "high" else None
        stage(False)
        scene = bpy.context.scene
        scene.eevee.taa_render_samples = 32
        scene.view_settings.exposure = -0.35
        scene.world.node_tree.nodes["Background"].inputs[
            "Strength"
        ].default_value = 0.42
        for name, factor in {
            "Core key": 0.75,
            "Core satin strip": 0.78,
            "Core face bounce": 0.24,
            "Core back rim": 0.78,
            "Underbody bounce": 0.34,
        }.items():
            bpy.data.objects[name].data.energy *= factor
        ground = bpy.data.objects["Review ground"]
        ground.location.z = -0.001
        ground.active_material.node_tree.nodes["Principled BSDF"].inputs[
            "Base Color"
        ].default_value = (0.24, 0.27, 0.31, 1.0)
        scene.render.resolution_x = scene.render.resolution_y = 512
        for name, view in VIEWS.items():
            ground.hide_render = name == "underside"
            path = out / f"{level}-{name}.png"
            camera = render(path, view)
            if name == "underside":
                subject = next(
                    o
                    for o in bpy.context.scene.objects
                    if o.type == "MESH" and o != ground
                )
                coords = positions(subject)
                inv = np.linalg.inv(np.array(camera["world_matrix"]))
                uv = (coords @ inv[:3, :3].T + inv[:3, 3])[:, :2] / camera[
                    "ortho_scale"
                ] + 0.5
                margins = (
                    np.r_[uv.min(axis=0), 1 - uv.max(axis=0)]
                    * scene.render.resolution_x
                )
                assert np.min(margins) > 24, (level, margins)
                result["underside_silhouette_margins_px"][level] = dict(
                    zip(
                        ("left", "bottom", "right", "top"),
                        margins.tolist(),
                        strict=True,
                    )
                )
            if level == "high":
                result["matched_views"][name] = camera
            else:
                assert result["matched_views"][name] == camera
            shots.append((f"{level.upper()}   {name}", path))
            if blend is not None and name in ("oblique", "flank", "front"):
                blend.default_value = 1.0
                assert render(out / f"{level}-phase2-{name}.png", view) == camera
                blend.default_value = 0.0
                delta = phase_pixels(out / f"{level}-phase2-{name}.png") - phase_pixels(
                    path
                )
                warm = (delta[:, :, 0] > 0.06) & (
                    delta[:, :, 0] - delta[:, :, 2] > 0.04
                )
                fraction = float(warm.mean())
                assert 0.0003 < fraction < 0.20, (name, level, fraction)
                result["phase_proof"][f"{level}-{name}"] = {
                    "same_mesh": source.name,
                    "phase_1_factor": 0,
                    "phase_2_factor": 1,
                    "matched_camera": camera,
                    "warm_changed_pixels": int(warm.sum()),
                    "warm_image_fraction": fraction,
                }
    shots.sort(
        key=lambda shot: (
            ("HIGH", "LOD0", "LOD1").index(shot[0].split()[0]),
            list(VIEWS).index(shot[0].split()[1]),
        )
    )
    montage(shots, 4, out / "comparison.jpg")
    phase_shots = [
        (
            f"{level.upper()}  Phase {phase}  {name}",
            out
            / (f"{level}-{name}.png" if phase == 1 else f"{level}-phase2-{name}.png"),
        )
        for level in ("lod0", "lod1")
        for phase in (1, 2)
        for name in ("oblique", "front", "flank")
    ]
    montage(phase_shots, 3, out / "phases.jpg")
    with tempfile.TemporaryDirectory() as directory:
        temp = Path(directory)
        scene.eevee.taa_render_samples = 12
        scene.render.resolution_x = scene.render.resolution_y = 448
        ground.hide_render = False
        for i in range(24):
            angle = math.tau * i / 24 + 0.58
            render(
                temp / f"orbit-{i:02d}.png",
                (
                    (1.5 * math.sin(angle), -1.5 * math.cos(angle), 0.82),
                    (0, 0, 0.41),
                    1.18,
                ),
            )
        movie(temp / "orbit-%02d.png", out / "turntable.mp4", 10)
        images = []
        reel_frames = 0
        for clip, times in POSES.items():
            action = select_action(arm, clip)
            start, end = action.frame_range
            angle = "flank" if clip == "spawn_adds" else "oblique"
            ground.hide_render = angle == "underside"
            for i, t in enumerate(times):
                blend.default_value = min(1, 2 * t) if clip == "phase2_shift" else 0
                f = start + t * (end - start)
                scene.frame_set(int(f), subframe=float(f - int(f)))
                path = temp / f"{clip}-{i}.png"
                render(path, VIEWS[angle])
                images.append((f"{clip}   {round(100 * t)}%", path))
            fps = 12
            count = max(2, round((end - start) / scene.render.fps * fps) + 1)
            reel_start = reel_frames
            for i in range(count):
                blend.default_value = (
                    min(1, 2 * i / (count - 1)) if clip == "phase2_shift" else 0
                )
                frame = start + (end - start) * i / (count - 1)
                scene.frame_set(int(frame), subframe=float(frame - int(frame)))
                render(temp / f"motion-{reel_frames:03d}.png", VIEWS[angle])
                reel_frames += 1
            result["animations"][clip] = {
                "normalized_times": times,
                "view": angle,
                "video_frames": [reel_start, reel_frames - 1],
                "video_fps": fps,
            }
        movie(temp / "motion-%03d.png", out / "motion.mp4", 12)
        montage(images, 3, out / "motion.jpg")
    (out / "cameras.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
