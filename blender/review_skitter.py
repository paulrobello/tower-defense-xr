"""Render matched source/decoded GLBs, an orbit, and five performed clip sheets."""

import argparse
import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import bpy
import gpu
from mathutils import Matrix

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from review_core_bastion import import_glb, stage
from review_materials import aim
from review_surface_clamp import decoded
from verify_skitter import select_action

VIEWS = {
    "oblique": ((0.45, -0.72, 0.31), (0, 0, 0.082), 0.411),
    "top": ((0, -0.001, 0.80), (0, 0, 0.076), 0.398),
    "flank": ((0.70, 0.14, 0.225), (0, 0, 0.084), 0.409),
}
WALL = Matrix(((-1, 0, 0, 0), (0, 0, 1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def neutral(arm: bpy.types.Object) -> None:
    ad = arm.animation_data
    ad.action = None
    for tr in ad.nla_tracks:
        tr.mute = True
    for p in arm.pose.bones:
        p.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


def render(path: Path, view: tuple) -> dict:
    scene = bpy.context.scene
    camera = scene.camera
    camera.location, target, scale = view
    aim(camera, target)
    camera.data.ortho_scale = scale
    bpy.context.view_layer.update()
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    return {
        "world_matrix": [list(r) for r in camera.matrix_world],
        "ortho_scale": scale,
    }


def montage(files: list, cols: int, target: Path) -> None:
    font = Path("/System/Library/Fonts/Supplemental/Arial.ttf")
    if not font.exists():
        font = subprocess.check_output(
            ["fc-match", "-f", "%{file}", "sans-serif"], text=True
        ).strip()
    inputs = []
    for name, path in files:
        inputs.extend(["-label", name, str(path)])
    subprocess.run(
        [
            "magick",
            "montage",
            "-background",
            "#222833",
            "-fill",
            "#f4f5f6",
            "-font",
            str(font),
            "-pointsize",
            "15",
            *inputs,
            "-geometry",
            "288x288+4+4",
            "-tile",
            f"{cols}x",
            "-quality",
            "91",
            str(target),
        ],
        check=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", type=Path, required=True)
    parser.add_argument("--ktx", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    assert bpy.app.version == (5, 2, 2)
    piece = args.piece.resolve()
    out = piece / "review"
    out.mkdir(exist_ok=True)
    matched = []
    evidence = {}
    gpu.init()
    backend = gpu.platform.backend_type_get()
    if sys.platform == "darwin":
        assert backend == "METAL", backend
    for label in ("high", "lod1", "lod0"):
        if label == "high":
            bpy.ops.wm.open_mainfile(filepath=str(piece / "high.blend"))
        else:
            path = piece / f"skitter-crawler-{label}.glb"
            import_glb(path)
            decoded(path, args.ktx.resolve())
        arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
        neutral(arm)
        stage(False)
        scene = bpy.context.scene
        scene.eevee.taa_render_samples = 48
        scene.view_settings.exposure = -0.72
        scene.world.node_tree.nodes["Background"].inputs[
            "Strength"
        ].default_value = 0.36
        for name, factor in {
            "Core key": 0.46,
            "Core satin strip": 0.53,
            "Core face bounce": 0.14,
            "Core back rim": 0.61,
            "Underbody bounce": 0.13,
        }.items():
            bpy.data.objects[name].data.energy *= factor
        floor_material = bpy.data.objects["Review ground"].active_material
        floor_material.node_tree.nodes["Principled BSDF"].inputs[
            "Base Color"
        ].default_value = (0.25, 0.28, 0.32, 1)
        scene.render.resolution_x = scene.render.resolution_y = 512
        for name, view in VIEWS.items():
            path = out / f"{label}-{name}.png"
            state = render(path, view)
            if label == "high":
                evidence[name] = state
            else:
                assert evidence[name] == state
            matched.append((f"{label.upper()}   {name}", path))
    montage(
        sorted(
            matched,
            key=lambda p: (
                ("HIGH", "LOD0", "LOD1").index(p[0].split()[0]),
                list(VIEWS).index(p[0].split()[-1]),
            ),
        ),
        3,
        out / "comparison.jpg",
    )
    original = arm.matrix_world.copy()
    floor = bpy.data.objects["Review ground"]
    floor_matrix = floor.matrix_world.copy()
    summary = {
        "engine": "EEVEE",
        "backend": backend,
        "matched_views": evidence,
        "animations": {},
    }
    with tempfile.TemporaryDirectory() as temp:
        temp = Path(temp)
        scene.eevee.taa_render_samples = 40
        scene.render.resolution_x = scene.render.resolution_y = 448
        for frame in range(24):
            angle = math.tau * frame / 24 + 0.53
            render(
                temp / f"orbit-{frame:02d}.png",
                (
                    (0.78 * math.sin(angle), -0.78 * math.cos(angle), 0.36),
                    (0, 0, 0.079),
                    0.412,
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
        clips = []
        for name in ("crawl_floor", "climb_wall", "attack", "hit", "death"):
            act = select_action(arm, name)
            start, end = act.frame_range
            wall = name == "climb_wall"
            arm.matrix_world = WALL @ original if wall else original
            floor.matrix_world = WALL @ floor_matrix if wall else floor_matrix
            times = (
                (0.08, 0.28, 0.76)
                if name in ("crawl_floor", "climb_wall")
                else ((0, 0.68, 1) if name == "attack" else (0, 0.50, 1))
            )
            for i, t in enumerate(times):
                frame = start + t * (end - start)
                scene.frame_set(int(frame), subframe=frame - int(frame))
                path = temp / f"{name}-{i}.png"
                view = (
                    ((0.21, 0.84, 0.14), (0, 0.075, 0), 0.422)
                    if wall
                    else ((0.13, -0.44, 0.79), (0, 0, 0.075), 0.411)
                    if name == "crawl_floor"
                    else VIEWS["oblique"]
                )
                render(path, view)
                if i == 1 and name in ("climb_wall", "crawl_floor"):
                    shutil.copy2(path, out / f"{name}.png")
                clips.append((f"{name}   {int(t * 100)}%", path))
            summary["animations"][name] = {
                "normalized_times": times,
                "fixture": list(map(list, WALL if wall else Matrix.Identity(4))),
            }
        montage(clips, 3, out / "motion.jpg")
    (out / "cameras.json").write_text(json.dumps(summary, indent=2) + "\n")


if __name__ == "__main__":
    main()
