"""An export skeleton with four independently driven flight vanes, jaw stylets and tail."""

from collections.abc import Callable
from math import pi, sin

import bpy
from mathutils import Matrix, Quaternion, Vector
from wasp_shape import WINGS, socket

CLIPS = {"hover_fly": 30, "bank_turn": 32, "attack": 20, "hit": 14, "death": 34}


def rig(mesh: bpy.types.Object, xyz: Callable) -> bpy.types.Object:
    arm = bpy.data.armatures.new("Wasp flight skeleton")
    obj = bpy.data.objects.new("Wasp", arm)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    def bone(name, head, tail, parent=None):
        b = arm.edit_bones.new(name)
        b.head, b.tail = head, tail
        if parent:
            b.parent = arm.edit_bones[parent]

    bone("root", (0, 0, 0), (0, -0.018, 0))
    bone("thorax", xyz((0, 0, 6)), xyz((0, -67, 4)), "root")
    bone("abdomen", xyz((0, 44, 23)), xyz((0, 155, 27)), "thorax")
    for side, s in (("L", 1), ("R", -1)):
        bone(
            f"stylet.{side}",
            xyz((s * 9, -126, -8)),
            xyz((s * 16, -192, -30)),
            "thorax",
        )
    for name, (s, u) in WINGS.items():
        bone(
            name,
            xyz(socket(s, u)),
            xyz((s * 150, 57 if u else 17, 24 if u else -49)),
            "thorax",
        )
    bpy.ops.object.mode_set(mode="OBJECT")
    mesh.parent = obj
    mod = mesh.modifiers.new("Flight articulation", "ARMATURE")
    mod.object = obj
    obj.show_in_front = True
    arm.display_type = "STICK"
    return obj


def actions(rig: bpy.types.Object) -> None:
    sc = bpy.context.scene
    sc.render.fps = 30
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    ad = rig.animation_data_create()
    for name, length in CLIPS.items():
        action = bpy.data.actions.new(name)
        ad.action = action
        action.use_fake_user = True
        for frame in range(length + 1):
            t = frame / length
            wave = sin(2 * pi * t)
            bell = sin(pi * t) ** 2
            hover = wave if name == "hover_fly" else 0
            bank = bell if name == "bank_turn" else 0
            attack = bell if name == "attack" else 0
            hit = bell if name == "hit" else 0
            death = t * t * (3 - 2 * t) if name == "death" else 0
            strike = attack * sin(2 * pi * t)
            trans = Vector(
                (
                    0.009 * hit,
                    0.038 * strike,
                    0.005 * hover - 0.012 * bank - 0.045 * death,
                )
            )
            thorax = rig.pose.bones["thorax"]
            thorax.location = (
                thorax.bone.matrix_local.to_quaternion().inverted() @ trans
            )
            thorax.keyframe_insert("location", frame=frame + 1, group="thorax")

            def key(
                bone: str,
                pitch: float = 0,
                roll: float = 0,
                yaw: float = 0,
                frame: int = frame,
            ) -> None:
                p = rig.pose.bones[bone]
                basis = p.bone.matrix_local.to_quaternion()
                turn = (
                    Quaternion((0, 1, 0), roll)
                    @ Quaternion((1, 0, 0), pitch)
                    @ Quaternion((0, 0, 1), yaw)
                )
                p.rotation_quaternion = basis.inverted() @ turn @ basis
                p.keyframe_insert("rotation_quaternion", frame=frame + 1, group=bone)

            key(
                "thorax",
                0.035 * hover + 0.18 * strike + 0.09 * hit + 0.46 * death,
                0.04 * hover + 0.60 * bank - 0.32 * hit + 1.12 * death,
                0.14 * bank,
            )
            key(
                "abdomen",
                0.065 * hover - 0.05 * bank - 0.32 * strike + 0.25 * hit - 0.46 * death,
                0,
                -0.12 * bank + 0.16 * hit,
            )
            for side, s in (("L", 1), ("R", -1)):
                key(
                    f"stylet.{side}",
                    -0.14 * attack + 0.08 * hit,
                    0,
                    -s * (0.36 * attack + 0.15 * death),
                )
            for bone, (s, upper) in WINGS.items():
                flap = (
                    (0.12 if upper else 0.105) * sin(4 * pi * t)
                    if name == "hover_fly"
                    else 0
                )
                key(
                    bone,
                    0.028 * hover,
                    s
                    * (
                        flap
                        - 0.10 * attack
                        + 0.10 * hit
                        + (0.21 if upper else 0.13) * death
                    )
                    + 0.12 * bank,
                    s
                    * (
                        0.065 * hover
                        + 0.055 * bank
                        + 0.12 * attack
                        + 0.14 * hit
                        + 0.44 * death
                    ),
                )
        track = ad.nla_tracks.new()
        track.name = name
        track.strips.new(name, 1, action)
        track.mute = True
    ad.action = None
    for p in rig.pose.bones:
        p.matrix_basis = Matrix.Identity(4)
    sc.frame_set(1)
    bpy.context.view_layer.update()
