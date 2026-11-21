"""Matched source/LOD locomotion fixtures and playback from the decoded revision."""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import bpy
from mathutils import Matrix

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import review_skitter as studio
from package_core_bastion import digest
from skitter_rig import CLIPS
from verify_skitter import select_action

FLOOR = ((0.13, -0.44, 0.79), (0, 0, 0.075), 0.411)
WALL = ((0.21, 0.84, 0.14), (0, 0.075, 0), 0.422)
STILL = studio.render


def pose(act: bpy.types.Action, t: float) -> None:
    start, end = act.frame_range
    frame = start + t * (end - start)
    bpy.context.scene.frame_set(int(frame), subframe=frame - int(frame))


def posed_views(out: Path, level: str) -> dict:
    arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
    floor = bpy.data.objects["Review ground"]
    root, ground = arm.matrix_world.copy(), floor.matrix_world.copy()
    cameras = {}
    for clip, transform, camera in (
        ("crawl_floor", Matrix.Identity(4), FLOOR),
        ("climb_wall", studio.WALL, WALL),
    ):
        arm.matrix_world, floor.matrix_world = transform @ root, transform @ ground
        pose(select_action(arm, clip), 0.28)
        cameras[clip] = STILL(out / f"{level}-{clip}.png", camera)
    arm.matrix_world, floor.matrix_world = root, ground
    studio.neutral(arm)
    return cameras


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--piece", type=Path, required=True)
    parser.add_argument("--ktx", type=Path, required=True)
    parser.add_argument("--original", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    piece, previous = args.piece.resolve(), args.original.resolve()
    out = piece / "review"
    extra_cameras = {}

    def render(path: Path, view: tuple) -> dict:
        state = STILL(path, view)
        if path.name in ("high-oblique.png", "lod0-oblique.png", "lod1-oblique.png"):
            level = path.stem.split("-")[0]
            extra_cameras[level] = posed_views(out, level)
        return state

    original_argument = sys.argv.index("--original")
    del sys.argv[original_argument : original_argument + 2]
    with patch.object(studio, "render", render):
        studio.main()
    camera_path = out / "cameras.json"
    cameras = json.loads(camera_path.read_text())
    old_cameras = json.loads((previous / "review/cameras.json").read_text())
    assert cameras["matched_views"] == old_cameras["matched_views"]
    assert extra_cameras["high"] == extra_cameras["lod0"] == extra_cameras["lod1"]
    cameras["matched_posed_views"] = extra_cameras["high"]
    cameras["previous_lod0_sha256"] = digest(previous / "skitter-crawler-lod0.glb")
    cameras["reviewed_glb_sha256"] = {
        lod: digest(piece / f"skitter-crawler-{lod}.glb") for lod in ("lod0", "lod1")
    }
    series = ("lod0-oblique", "lod0-top", "lod0-flank", "crawl_floor", "climb_wall")
    names = ("Oblique", "Top", "Flank", "Floor", "Wall")
    previous_proof = json.loads((previous / "provenance.json").read_text())["files"]
    before = []
    for n, label in zip(series, names, strict=True):
        image = previous / "review" / f"{n}.png"
        assert digest(image) == previous_proof[f"review/{n}.png"]
        before.append((f"Original   {label}", image))
    studio.montage(
        before
        + [
            (f"Revision   {label}", out / f"{n}.png")
            for n, label in zip(series, names, strict=True)
        ],
        len(series),
        out / "revision-comparison.jpg",
    )
    studio.montage(
        [
            (f"{lod.upper()}   {name}", out / f"{lod}-{clip}.png")
            for lod in ("high", "lod0", "lod1")
            for name, clip in (("Floor", "crawl_floor"), ("Wall", "climb_wall"))
        ],
        2,
        out / "locomotion.jpg",
    )
    scene = bpy.context.scene
    scene.render.resolution_x = scene.render.resolution_y = 320
    scene.eevee.taa_render_samples = 12
    arm = next(o for o in scene.objects if o.type == "ARMATURE")
    floor = bpy.data.objects["Review ground"]
    root, ground = arm.matrix_world.copy(), floor.matrix_world.copy()
    with tempfile.TemporaryDirectory() as directory:
        temp = Path(directory)
        index = 0
        sequence = {}
        for clip in CLIPS:
            wall = clip == "climb_wall"
            basis = studio.WALL if wall else Matrix.Identity(4)
            arm.matrix_world, floor.matrix_world = basis @ root, basis @ ground
            act = select_action(arm, clip)
            # Render the five clips at twelve samples per second from their source durations.
            count = max(6, round(CLIPS[clip] / 30 * 12))
            sequence[clip] = {"frames": count, "first_video_frame": index}
            for i in range(count):
                pose(act, i / (count - 1))
                view = (
                    WALL
                    if wall
                    else FLOOR
                    if clip == "crawl_floor"
                    else studio.VIEWS["oblique"]
                )
                STILL(temp / f"pose-{index:03d}.png", view)
                index += 1
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-framerate",
                "12",
                "-i",
                str(temp / "pose-%03d.png"),
                "-c:v",
                "libx264",
                "-threads",
                "2",
                "-crf",
                "17",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(out / "motion.mp4"),
            ],
            check=True,
        )
    cameras["motion_reel"] = {"fps": 12, "clips": sequence}
    camera_path.write_text(json.dumps(cameras, indent=2) + "\n")


if __name__ == "__main__":
    main()
