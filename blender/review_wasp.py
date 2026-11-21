"""Matched source and decoded flight-asset views, 24-frame orbit and performed clip sheet."""

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
    "oblique": ((-0.34, -0.55, 0.95), (0, 0, 0.112), 0.51),
    "top": ((0, -0.001, 0.90), (0, 0, 0.112), 0.49),
    "flank": ((0.85, -0.18, 0.22), (0, 0, 0.110), 0.51),
    "underside": ((0.30, -0.46, -0.62), (0, 0, 0.111), 0.51),
}
POSES = {
    "hover_fly": (0.125, 0.375, 0.625),
    "bank_turn": (0, 0.5, 1),
    "attack": (0.24, 0.67, 1),
    "hit": (0, 0.5, 1),
    "death": (0, 0.55, 1),
}


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
            source = piece / f"wasp-skimmer-{level}.glb"
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
        ground.location.z = -0.080
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
                    (0.77 * math.sin(angle), -0.77 * math.cos(angle), 0.45),
                    (0, 0, 0.112),
                    0.53,
                ),
            )
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-framerate",
                "10",
                "-i",
                str(temp / "orbit-%02d.png"),
                "-c:v",
                "libx264",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(out / "turntable.mp4"),
            ],
            check=True,
        )
        images = []
        for clip, times in POSES.items():
            action = select_action(arm, clip)
            start, end = action.frame_range
            angle = "underside" if clip == "bank_turn" else "oblique"
            ground.hide_render = angle == "underside"
            for i, t in enumerate(times):
                f = start + t * (end - start)
                scene.frame_set(int(f), subframe=float(f - int(f)))
                path = temp / f"{clip}-{i}.png"
                render(path, VIEWS[angle])
                images.append((f"{clip}   {round(100 * t)}%", path))
            result["animations"][clip] = {"normalized_times": times, "view": angle}
        montage(images, 3, out / "motion.jpg")
    (out / "cameras.json").write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
