"""Matched source and decoded Disruptor views, 24-frame orbit and performed clip sheet."""

import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import bpy
import gpu

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from package_core_bastion import digest
from review_brute import movie
from review_core_bastion import import_glb, stage
from review_skitter import montage, neutral, render
from review_surface_clamp import decoded
from verify_skitter import select_action

VIEWS = {
    "oblique": ((0.49, -0.76, 0.48), (0, 0, 0.16), 0.54),
    "top": ((0, -0.001, 0.94), (0, 0, 0.16), 0.51),
    "flank": ((0.96, -0.13, 0.27), (0, 0, 0.16), 0.52),
    "underside": ((0.44, -0.58, -0.57), (0, 0, 0.16), 0.56),
}
POSES = {
    "hover_glide": (0, 0.28, 0.58),
    "emp_pulse": (0, 0.23, 0.68),
    "hit": (0, 0.5, 1),
    "death": (0, 0.5, 1),
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", required=True, type=Path)
    parser.add_argument("--ktx", required=True, type=Path)
    parser.add_argument("--previous-review", type=Path)
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
    }
    shots = []
    for level in ("high", "lod1", "lod0"):
        if level == "high":
            bpy.ops.wm.open_mainfile(filepath=str(piece / "high.blend"))
        else:
            source = piece / f"rift-disruptor-{level}.glb"
            import_glb(source)
            decoded(source, args.ktx.resolve())
        arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
        neutral(arm)
        stage(False)
        scene = bpy.context.scene
        scene.eevee.taa_render_samples = 48
        scene.view_settings.exposure = -0.70
        scene.world.node_tree.nodes["Background"].inputs[
            "Strength"
        ].default_value = 0.42
        for name, factor in {
            "Core key": 0.50,
            "Core satin strip": 0.53,
            "Core face bounce": 0.19,
            "Core back rim": 0.58,
            "Underbody bounce": 0.34,
        }.items():
            bpy.data.objects[name].data.energy *= factor
        ground = bpy.data.objects["Review ground"]
        ground.location.z = -0.13
        ground.active_material.node_tree.nodes["Principled BSDF"].inputs[
            "Base Color"
        ].default_value = (0.24, 0.27, 0.31, 1.0)
        scene.render.resolution_x = scene.render.resolution_y = 512
        for name, view in VIEWS.items():
            ground.hide_render = name == "underside"
            path = out / f"{level}-{name}.png"
            camera = render(path, view)
            if level == "high":
                result["matched_views"][name] = camera
            else:
                assert result["matched_views"][name] == camera
            shots.append((f"{level.upper()}   {name}", path))
    shots.sort(
        key=lambda shot: (
            ("HIGH", "LOD0", "LOD1").index(shot[0].split()[0]),
            list(VIEWS).index(shot[0].split()[1]),
        )
    )
    montage(shots, 4, out / "comparison.jpg")
    with tempfile.TemporaryDirectory() as directory:
        temp = Path(directory)
        scene.eevee.taa_render_samples = 32
        scene.render.resolution_x = scene.render.resolution_y = 448
        ground.hide_render = False
        for i in range(24):
            angle = math.tau * i / 24 + 0.58
            render(
                temp / f"orbit-{i:02d}.png",
                (
                    (0.77 * math.sin(angle), -0.77 * math.cos(angle), 0.52),
                    (0, 0, 0.16),
                    0.54,
                ),
            )
        movie(temp / "orbit-%02d.png", out / "turntable.mp4", 10)
        images = []
        reel_frames = 0
        for clip, times in POSES.items():
            action = select_action(arm, clip)
            start, end = action.frame_range
            angle = "oblique"
            ground.hide_render = angle == "underside"
            for i, t in enumerate(times):
                f = start + t * (end - start)
                scene.frame_set(int(f), subframe=float(f - int(f)))
                path = temp / f"{clip}-{i}.png"
                render(path, VIEWS[angle])
                images.append((f"{clip}   {round(100 * t)}%", path))
            fps = 12
            count = max(2, round((end - start) / scene.render.fps * fps) + 1)
            reel_start = reel_frames
            for i in range(count):
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
        if args.previous_review:
            previous = args.previous_review.resolve()
            earlier = json.loads((previous / "cameras.json").read_text())
            assert earlier["matched_views"] == result["matched_views"]
            comparison = []
            for label, path in (
                ("Prior LOD0", previous / "lod0-top.png"),
                ("Final LOD0", out / "lod0-top.png"),
                ("High source", out / "high-top.png"),
            ):
                crop = temp / (label + ".png")
                subprocess.run(
                    [
                        "magick",
                        str(path),
                        "-crop",
                        "160x160+176+176",
                        "+repage",
                        "-resize",
                        "290x290",
                        str(crop),
                    ],
                    check=True,
                )
                comparison.append((label, crop))
            montage(comparison, 3, out / "polar-well-comparison.jpg")
            result["polar_chart_comparison"] = {
                "source_crop_px": [176, 176, 160, 160],
                "prior_receiver_sha256": digest(
                    previous.parent / "rift-disruptor-lod0.glb"
                ),
                "prior_top_render_sha256": digest(previous / "lod0-top.png"),
                "final_receiver_sha256": digest(piece / "rift-disruptor-lod0.glb"),
                "final_top_render_sha256": digest(out / "lod0-top.png"),
            }
    (out / "cameras.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
