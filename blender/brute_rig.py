"""In-place tripod walk and body performances baked to an export-only FK skeleton."""

from collections.abc import Callable
from math import cos, pi, sin

import bpy
from brute_shape import CHAINS, key
from mathutils import Matrix, Quaternion, Vector

CLIPS = {"stomp_walk": 44, "armor_brace": 40, "attack": 28, "hit": 18, "death": 42}
V = Vector


def rig(mesh: bpy.types.Object, xyz: Callable) -> bpy.types.Object:
    arm = bpy.data.armatures.new("Brute skeleton")
    rig = bpy.data.objects.new("Brute", arm)
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

    bone("root", V((0, 0, 0)), V((0, -0.018, 0)))
    bone("thorax", xyz((0, 18, 220)), xyz((0, -45, 220)), "root")
    bone("head", xyz((0, -150, 186)), xyz((0, -216, 178)), "thorax")
    bone("shield", xyz((0, -2, 368)), xyz((0, -175, 295)), "thorax")
    for s in (-1, 1):
        bone(
            f"mandible.{'L' if s > 0 else 'R'}",
            xyz((s * 52, -209, 152)),
            xyz((s * 26, -260, 139)),
            "head",
        )
        for i, chain in enumerate(CHAINS):
            a, b, c, d = [xyz((s * x, y, z)) for x, y, z in chain]
            femur, tibia, claw = [key(p, i, s) for p in ("femur", "tibia", "claw")]
            bone(femur, a, b, "thorax")
            bone(tibia, b, c, femur).use_connect = True
            bone(claw, c, d, tibia).use_connect = True
    bpy.ops.object.mode_set(mode="OBJECT")
    mesh.parent = rig
    modifier = mesh.modifiers.new("Cuticle articulation", "ARMATURE")
    modifier.object = rig
    rig.show_in_front = True
    arm.display_type = "STICK"
    return rig


def triangulate_leg(
    hip: Vector, rest_knee: Vector, rest_ankle: Vector, target: Vector, rest_hip: Vector
) -> Vector:
    a = (rest_knee - rest_hip).length
    b = (rest_ankle - rest_knee).length
    axis = (target - hip).normalized()
    distance = (target - hip).length
    # Preserve the lateral knee bend by projecting its rest pole onto the solve plane.
    pole = rest_knee - rest_hip
    pole = (pole - axis * axis.dot(pole)).normalized()
    along = (a * a - b * b + distance * distance) / (2 * distance)
    assert abs(along) < a, (distance, a, b)
    return hip + along * axis + (a * a - along * along) ** 0.5 * pole


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
            cycle = name == "stomp_walk"
            phase = 2 * pi * t
            brace = sin(pi * t) ** 2 if name == "armor_brace" else 0
            attack = sin(pi * t) ** 2 if name == "attack" else 0
            hit = sin(pi * t) ** 2 if name == "hit" else 0
            fall = min(t / 0.78, 1) if name == "death" else 0
            death = fall * fall * (3 - 2 * fall)
            lunge = attack * sin(2 * pi * (t - 0.03))
            offset = V(
                (
                    0.0045 * sin(phase) if cycle else 0.009 * hit,
                    0.004 * cos(2 * phase) if cycle else 0.025 * lunge,
                    -0.007 * (1 - cos(2 * phase)) / 2
                    if cycle
                    else -0.031 * brace - 0.061 * death + 0.008 * hit - 0.012 * attack,
                )
            )
            rotation = Quaternion(
                (0, 1, 0), 0.034 * sin(phase) if cycle else 0.12 * hit + 0.075 * death
            )
            rotation @= Quaternion(
                (1, 0, 0), 0.095 * brace - 0.15 * lunge + 0.065 * death
            )
            chest = rest["thorax"].translation
            delta = (
                Matrix.Translation(chest + offset)
                @ rotation.to_matrix().to_4x4()
                @ Matrix.Translation(-chest)
            )
            poses = {"root": rest["root"], "thorax": delta @ rest["thorax"]}

            def child(
                name: str, parent: str, axis: tuple, angle: float, poses=poses
            ) -> Matrix:
                base = poses[parent] @ rest[parent].inverted() @ rest[name]
                return base @ Quaternion(axis, angle).to_matrix().to_4x4()

            poses["head"] = child(
                "head", "thorax", (1, 0, 0), -0.19 * lunge - 0.26 * hit + 0.28 * death
            )
            retreat = V(
                (
                    0,
                    0.012 * attack + 0.022 * brace + 0.014 * hit + 0.022 * death,
                    -0.021 * attack - 0.028 * brace - 0.014 * hit - 0.019 * death,
                )
            )
            poses["head"].translation += rotation @ retreat
            pivot = rest["shield"].translation
            tilt = 0.105 * brace - 0.11 * lunge + 0.09 * death
            poses["shield"] = (
                delta
                @ Matrix.Translation(pivot)
                @ Quaternion((1, 0, 0), tilt).to_matrix().to_4x4()
                @ Matrix.Translation(-pivot)
                @ rest["shield"]
            )
            for s in (-1, 1):
                jaw = f"mandible.{'L' if s > 0 else 'R'}"
                gape = 0.48 * attack * (0.4 + cos(pi * t)) + 0.15 * hit + 0.21 * death
                poses[jaw] = child(jaw, "head", (0, 0, 1), s * gape)
                for i in range(3):
                    fem, tib, claw = (key(p, i, s) for p in ("femur", "tibia", "claw"))
                    hip, knee, ankle = [rest[n].translation for n in (fem, tib, claw)]
                    toe = bones[claw].bone.tail_local.copy()
                    p = (t + (0.5 if (i + (s > 0)) % 2 else 0)) % 1
                    # Stance takes 64% of the cycle. The short double-support interval
                    # prevents a floating frame when the two tripods exchange support.
                    if p < 0.64:
                        swing = 0
                        stride = -cos(pi * p / 0.64)
                    else:
                        q = (p - 0.64) / 0.36
                        swing = sin(pi * q) ** 2
                        stride = cos(pi * q)
                    motion = (
                        V(
                            (
                                s * 0.003 * swing,
                                0.019 * stride,
                                0.030 * swing,
                            )
                        )
                        if cycle
                        else V((0, 0, 0))
                    )
                    if not cycle:
                        motion += V(
                            (
                                s * (0.004 * attack + 0.026 * death),
                                0.002 * lunge + 0.012 * death * (i - 1),
                                (0.014 * attack if i == 0 else 0),
                            )
                        )
                    end = toe + motion
                    foot_dir = Quaternion(
                        (1, 0, 0),
                        (0.13 * swing if cycle else 0.09 * attack if i == 0 else 0),
                    ) @ (toe - ankle)
                    new_ankle = end - foot_dir
                    new_hip = delta @ hip
                    new_knee = triangulate_leg(new_hip, knee, ankle, new_ankle, hip)
                    for b, a, d, old in (
                        (fem, new_hip, new_knee, knee - hip),
                        (tib, new_knee, new_ankle, ankle - knee),
                        (claw, new_ankle, end, toe - ankle),
                    ):
                        quat = old.rotation_difference(d - a)
                        poses[b] = (
                            Matrix.Translation(a)
                            @ quat.to_matrix().to_4x4()
                            @ rest[b].to_quaternion().to_matrix().to_4x4()
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
                if n in ("thorax", "head"):
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
