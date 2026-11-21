"""In-place magnetic suspension, field release, recoil and power-down."""

from math import cos, pi, sin, tau

import bpy
from mathutils import Euler, Matrix, Vector

CLIPS = {"hover_glide": 60, "emp_pulse": 36, "hit": 20, "death": 42}


def rig(mesh: bpy.types.Object) -> bpy.types.Object:
    data = bpy.data.armatures.new("Disruptor skeleton")
    obj = bpy.data.objects.new("Disruptor", data)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for name, parent, z in (
        ("root", None, 0),
        ("hull", "root", 0.16),
        ("rotor", "hull", 0.16),
    ):
        b = data.edit_bones.new(name)
        b.head = (0, 0, z)
        b.tail = (0, 0.025, z)
        if parent:
            b.parent = data.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    mesh.parent = obj
    mesh.modifiers.new("Magnetic suspension", "ARMATURE").object = obj
    obj.show_in_front = True
    data.display_type = "STICK"
    return obj


def actions(obj: bpy.types.Object) -> None:
    scene = bpy.context.scene
    scene.render.fps = 30
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    ad = obj.animation_data_create()
    for name, frames in CLIPS.items():
        action = bpy.data.actions.new(name)
        ad.action = action
        action.use_fake_user = True
        prev = {}
        for i in range(frames + 1):
            t = i / frames
            drift = sin(tau * t) if name == "hover_glide" else 0
            lift = (1 - cos(tau * t)) / 2 if name == "hover_glide" else 0
            prep = sin(pi * min(t / 0.46, 1)) ** 2 if name == "emp_pulse" else 0
            strike = (
                sin(pi * max(0, (t - 0.35) / 0.65)) ** 2 if name == "emp_pulse" else 0
            )
            hit = sin(pi * t) ** 2 if name == "hit" else 0
            f = min(t / 0.76, 1) if name == "death" else 0
            fall = f * f * (3 - 2 * f)
            for bone, loc, rot in (
                (
                    "hull",
                    (
                        0.011 * drift + 0.022 * hit,
                        0,
                        0.019 * lift
                        - 0.018 * prep
                        + 0.019 * strike
                        + 0.008 * hit
                        - 0.072 * fall,
                    ),
                    (
                        0.055 * drift - 0.17 * hit + 0.56 * fall,
                        0.055 * drift + 0.28 * hit + 0.28 * fall,
                        0.10 * strike,
                    ),
                ),
                (
                    "rotor",
                    (0, 0, -0.029 * prep + 0.038 * strike - 0.020 * hit - 0.027 * fall),
                    (
                        0.13 * prep - 0.17 * strike + 0.23 * hit + 0.14 * fall,
                        0.06 * drift,
                        tau * t
                        if name == "hover_glide"
                        else -0.56 * prep + 1.2 * strike - 0.32 * hit + 0.67 * fall,
                    ),
                ),
            ):
                pb = obj.pose.bones[bone]
                pb.location = Vector(loc)
                q = Euler(rot, "XYZ").to_quaternion()
                if bone in prev:
                    q.make_compatible(prev[bone])
                prev[bone] = q.copy()
                pb.rotation_quaternion = q
                pb.keyframe_insert("location", frame=i + 1, group=bone)
                pb.keyframe_insert("rotation_quaternion", frame=i + 1, group=bone)
        track = ad.nla_tracks.new()
        track.name = name
        track.strips.new(name, 1, action)
        track.mute = True
    ad.action = None
    for pb in obj.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    scene.frame_set(1)
    bpy.context.view_layer.update()
