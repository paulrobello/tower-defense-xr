"""Matched source and decoded armored Brute views, 24-frame orbit and performed clip sheet."""

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
from review_core_bastion import import_glb, stage
from review_skitter import montage, neutral, render
from review_surface_clamp import decoded
from verify_skitter import select_action

VIEWS = {
    "oblique": ((0.60, -0.95, 0.55), (0, 0, 0.225), 0.68),
    "front": ((0, -1.07, 0.36), (0, 0, 0.225), 0.64),
    "flank": ((1.08, 0.03, 0.37), (0, 0, 0.225), 0.68),
    "underside": ((0.39, -0.59, -0.65), (0, 0, 0.177), 0.75),
}
POSES = {
    "stomp_walk": (0.125, 0.375, 0.625),
    "armor_brace": (0, 0.5, 1),
    "attack": (0.24, 0.67, 1),
    "hit": (0, 0.5, 1),
    "death": (0, 0.55, 1),
}


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
    }
    shots = []
    for level in ("high", "lod1", "lod0"):
        if level == "high":
            bpy.ops.wm.open_mainfile(filepath=str(piece / "high.blend"))
        else:
            source = piece / f"carapace-brute-{level}.glb"
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
        ground.location.z = -0.001
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
                    (0, 0, 0.225),
                    0.69,
                ),
            )
        movie(temp / "orbit-%02d.png", out / "turntable.mp4", 10)
        images = []
        reel_frames = 0
        for clip, times in POSES.items():
            action = select_action(arm, clip)
            start, end = action.frame_range
            angle = "flank" if clip == "armor_brace" else "oblique"
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
    (out / "cameras.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
