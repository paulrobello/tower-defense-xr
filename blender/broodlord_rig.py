"""In-place diagonal-pair march and body performances baked to an export-only FK skeleton."""

from collections.abc import Callable
from math import cos, pi, sin

import bpy
from broodlord_shape import ARM, LEGS, leg, side_name
from brute_rig import triangulate_leg
from mathutils import Matrix, Quaternion, Vector

CLIPS = {
    "boss_march": 54,
    "spawn_adds": 46,
    "emp_roar": 42,
    "phase2_shift": 48,
    "hit": 20,
    "death": 52,
}
V = Vector


def rig(mesh: bpy.types.Object, xyz: Callable) -> bpy.types.Object:
    arm = bpy.data.armatures.new("Broodlord skeleton")
    rig = bpy.data.objects.new("Broodlord", arm)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    def bone(
        name: str, a: Vector, b: Vector, parent: str | None = None
    ) -> bpy.types.EditBone:
        edit = arm.edit_bones.new(name)
        edit.head, edit.tail = a, b
        if parent:
            edit.parent = arm.edit_bones[parent]
        return edit

    bone("root", V((0, 0, 0)), V((0, -0.024, 0)))
    bone("thorax", xyz((0, 0, 378)), xyz((0, -95, 400)), "root")
    bone("abdomen", xyz((0, 77, 370)), xyz((0, 232, 330)), "thorax")
    bone("head", xyz((0, -86, 500)), xyz((0, -206, 524)), "thorax")
    for s in (-1, 1):
        side = side_name(s)
        bone(f"crest.{side}", xyz((s * 49, -135, 579)), xyz((s * 109, 80, 680)), "head")
        a, b, c, d = [xyz((s * x, y, z)) for x, y, z in ARM]
        upper, fore, palm = [f"{n}.{side}" for n in ("brachium", "forearm", "palm")]
        bone(upper, a, b, "thorax")
        bone(fore, b, c, upper).use_connect = True
        bone(palm, c, d, fore).use_connect = True
        for i, chain in enumerate(LEGS):
            a, b, c, d, e = [xyz((s * x, y, z)) for x, y, z in chain]
            coxa, fem, tib, claw = [
                leg(n, i, s) for n in ("coxa", "femur", "tibia", "blade")
            ]
            bone(coxa, a, b, "thorax")
            bone(fem, b, c, coxa).use_connect = True
            bone(tib, c, d, fem).use_connect = True
            bone(claw, d, e, tib).use_connect = True
    bpy.ops.object.mode_set(mode="OBJECT")
    mesh.parent = rig
    modifier = mesh.modifiers.new("Cuticle articulation", "ARMATURE")
    modifier.object = rig
    rig.show_in_front = True
    arm.display_type = "STICK"
    return rig


def actions(rig: bpy.types.Object) -> None:
    scene = bpy.context.scene
    scene.render.fps = 30
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    bones = rig.pose.bones
    anim = rig.animation_data_create()
    rest = {p.name: p.bone.matrix_local.copy() for p in bones}
    for name, frames in CLIPS.items():
        act = bpy.data.actions.new(name)
        anim.action = act
        act.use_fake_user = True
        previous = {}
        for f in range(frames + 1):
            t = f / frames
            cycle = name == "boss_march"
            phase = 2 * pi * t
            peak = sin(pi * t) ** 2
            summon = peak if name == "spawn_adds" else 0.0
            roar = (
                peak * (0.35 + 0.65 * sin(pi * min(1, t / 0.72)) ** 2)
                if name == "emp_roar"
                else 0.0
            )
            shift = peak if name == "phase2_shift" else 0.0
            hit = peak if name == "hit" else 0.0
            q = min(t / 0.8, 1) if name == "death" else 0
            fall = q * q * (3 - 2 * q)
            offset = V(
                (
                    0.008 * sin(phase) if cycle else 0.018 * hit,
                    0,
                    -0.014 * sin(phase) ** 2
                    if cycle
                    else 0.023 * roar - 0.023 * summon - 0.016 * shift - 0.140 * fall,
                )
            )
            rot = Quaternion(
                (0, 1, 0), 0.028 * sin(phase) if cycle else 0.10 * hit + 0.09 * fall
            )
            rot @= Quaternion((1, 0, 0), -0.13 * roar + 0.08 * summon + 0.15 * fall)
            chest = rest["thorax"].translation
            delta = (
                Matrix.Translation(chest + offset)
                @ rot.to_matrix().to_4x4()
                @ Matrix.Translation(-chest)
            )
            poses = {"root": rest["root"], "thorax": delta @ rest["thorax"]}

            def child(
                n: str, parent: str, angles: tuple[float, float, float], poses=poses
            ):
                pivot = rest[n].translation
                rotation = (
                    Quaternion((0, 0, 1), angles[2])
                    @ Quaternion((0, 1, 0), angles[1])
                    @ Quaternion((1, 0, 0), angles[0])
                )
                poses[n] = (
                    poses[parent]
                    @ rest[parent].inverted()
                    @ Matrix.Translation(pivot)
                    @ rotation.to_matrix().to_4x4()
                    @ Matrix.Translation(-pivot)
                    @ rest[n]
                )

            child(
                "abdomen", "thorax", (0.31 * summon - 0.09 * shift - 0.13 * fall, 0, 0)
            )
            child(
                "head",
                "thorax",
                (-0.20 * roar + 0.11 * summon + 0.21 * hit + 0.045 * fall, 0, 0),
            )
            for s in (-1, 1):
                side = side_name(s)
                child(
                    f"crest.{side}",
                    "head",
                    (
                        0.055 * shift - 0.18 * fall,
                        s * (0.035 * roar + 0.095 * shift),
                        0,
                    ),
                )
                upper, fore, palm = [
                    f"{n}.{side}" for n in ("brachium", "forearm", "palm")
                ]
                march = s * 0.075 * sin(phase) if cycle else 0.0
                child(
                    upper,
                    "thorax",
                    (
                        march - 0.34 * roar - 0.27 * summon + 0.08 * fall,
                        0,
                        s * (0.12 * roar + 0.15 * summon + 0.14 * shift),
                    ),
                )
                child(
                    fore,
                    upper,
                    (
                        -0.19 * roar - 0.18 * summon + 0.27 * fall,
                        0,
                        s * (0.06 * summon - 0.07 * shift),
                    ),
                )
                child(
                    palm,
                    fore,
                    (0.25 * summon - 0.12 * roar + 0.29 * fall, 0, s * 0.17 * shift),
                )
                for i in range(2):
                    coxa, fem, tib, claw = [
                        leg(n, i, s) for n in ("coxa", "femur", "tibia", "blade")
                    ]
                    p = (t + (0.5 if (i + (s > 0)) % 2 else 0)) % 1
                    if p < 0.63:
                        swing = 0.0
                        stride = -cos(pi * p / 0.63)
                    else:
                        q = (p - 0.63) / 0.37
                        swing = sin(pi * q) ** 2
                        stride = cos(pi * q)
                    child(
                        coxa,
                        "thorax",
                        (0.035 * stride if cycle else -0.07 * fall, s * 0.06 * fall, 0),
                    )
                    base = poses[coxa] @ rest[coxa].inverted()
                    hip, knee, ankle = [rest[n].translation for n in (fem, tib, claw)]
                    toe = bones[claw].bone.tail_local.copy()
                    motion = (
                        V((s * 0.005 * swing, 0.039 * stride, 0.050 * swing))
                        if cycle
                        else V((s * 0.033 * fall, (2 * i - 1) * 0.022 * fall, 0))
                    )
                    end = toe + motion
                    foot_dir = Quaternion((1, 0, 0), 0.13 * swing if cycle else 0) @ (
                        toe - ankle
                    )
                    new_ankle = end - foot_dir
                    new_hip = base @ hip
                    new_knee = triangulate_leg(new_hip, knee, ankle, new_ankle, hip)
                    for n, a, d, old in (
                        (fem, new_hip, new_knee, knee - hip),
                        (tib, new_knee, new_ankle, ankle - knee),
                        (claw, new_ankle, end, toe - ankle),
                    ):
                        quat = old.rotation_difference(d - a)
                        poses[n] = (
                            Matrix.Translation(a)
                            @ quat.to_matrix().to_4x4()
                            @ rest[n].to_quaternion().to_matrix().to_4x4()
                        )
            for pbone in bones:
                n = pbone.name
                if n == "root":
                    continue
                par = pbone.parent.name
                local = (
                    rest[n].inverted_safe()
                    @ rest[par]
                    @ poses[par].inverted_safe()
                    @ poses[n]
                )
                loc, rot, _ = local.decompose()
                if n in previous:
                    rot.make_compatible(previous[n])
                previous[n] = rot.copy()
                pbone.rotation_quaternion = rot
                pbone.keyframe_insert("rotation_quaternion", frame=f + 1, group=n)
                if n == "thorax":
                    pbone.location = loc
                    pbone.keyframe_insert("location", frame=f + 1, group=n)
        tr = anim.nla_tracks.new()
        tr.name = name
        tr.strips.new(name, 1, act)
        tr.mute = True
    anim.action = None
    for pbone in bones:
        pbone.matrix_basis = Matrix.Identity(4)
    scene.frame_set(1)
    bpy.context.view_layer.update()
