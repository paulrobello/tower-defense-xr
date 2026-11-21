"""Check staged Rift Bastion GLBs and KTX2 maps against an asset manifest."""

from __future__ import annotations

import argparse
import functools
import itertools
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any

from assets.ktx2 import (
    DEFAULT_KTX,
    Decoder,
    checked_ktx,
    decode_ktx2,
    digest,
    require,
    unsigned,
    validate_texture,
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFESTS = (
    ROOT / "assets-source/models/manifest.json",
    ROOT / "assets-source/materials/manifest.json",
)
COMPONENTS = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
COMPONENT_COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
IDENTITY = ((1.0, 0.0, 0.0, 0.0), (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0), (0.0, 0.0, 0.0, 1.0))
PLANE_TOLERANCE = 1e-6
AREA_TOLERANCE = 1e-10
Json = dict[str, Any]
Vec3 = tuple[float, float, float]
Vec2 = tuple[float, float]
Mat4 = tuple[tuple[float, ...], ...]
Triangle = tuple[Vec3, Vec3, Vec3]
ModelStats = dict[str, int]


def item(items: list, index: Any, label: str) -> Any:
    require(type(index) is int and 0 <= index < len(items), f"invalid {label} index {index!r}")
    return items[index]


def components(values: Any, count: int, label: str) -> tuple[float, ...]:
    require(
        isinstance(values, (list, tuple))
        and len(values) == count
        and all(type(value) in (float, int) and math.isfinite(value) for value in values),
        f"invalid {label}",
    )
    return tuple(values)


def asset_path(root: Path, name: str, suffix: str, *, relative_to: Path | None = None) -> Path:
    require(
        isinstance(name, str)
        and bool(name)
        and "\\" not in name
        and ":" not in name
        and "?" not in name
        and "#" not in name,
        f"expected a local asset path, got {name!r}",
    )
    root = root.resolve()
    relative = Path(name)
    require(
        not relative.is_absolute() and relative.suffix == suffix,
        f"expected a relative {suffix} path",
    )
    resolved = ((relative_to or root) / relative).resolve()
    require(resolved.is_relative_to(root), f"{name!r} escapes the manifest directory")
    return resolved


def subtract(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def dot(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: Vec3, b: Vec3) -> Vec3:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def unit(v: Vec3) -> Vec3:
    length = math.sqrt(dot(v, v))
    require(length > 1e-14, "degenerate triangle or singular normal")
    return (v[0] / length, v[1] / length, v[2] / length)


def node_transform(node: Json) -> Mat4:
    if "matrix" in node:
        require(
            not ({"translation", "rotation", "scale"} & node.keys()), "node has both matrix and TRS"
        )
        m = components(node["matrix"], 16, "matrix")
        require(m[3:16:4] == (0, 0, 0, 1), "non-affine node matrix")
        return tuple(tuple(m[j * 4 + i] for j in range(4)) for i in range(4))
    x, y, z, w = components(node.get("rotation", [0, 0, 0, 1]), 4, "rotation")
    require(abs(x * x + y * y + z * z + w * w - 1) <= 1e-4, "rotation quaternion is not normalized")
    sx, sy, sz = components(node.get("scale", [1, 1, 1]), 3, "scale")
    tx, ty, tz = components(node.get("translation", [0, 0, 0]), 3, "translation")
    return (
        ((1 - 2 * (y * y + z * z)) * sx, 2 * (x * y - z * w) * sy, 2 * (x * z + y * w) * sz, tx),
        (2 * (x * y + z * w) * sx, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z - x * w) * sz, ty),
        (2 * (x * z - y * w) * sx, 2 * (y * z + x * w) * sy, (1 - 2 * (x * x + y * y)) * sz, tz),
        (0, 0, 0, 1),
    )


def compose(left: Mat4, right: Mat4) -> Mat4:
    return tuple(
        tuple(sum(left[i][k] * right[k][j] for k in range(4)) for j in range(4)) for i in range(4)
    )


def transform_point(m: Mat4, p: Vec3) -> Vec3:
    x, y, z = p
    a, b, c = m[:3]
    return (
        a[0] * x + a[1] * y + a[2] * z + a[3],
        b[0] * x + b[1] * y + b[2] * z + b[3],
        c[0] * x + c[1] * y + c[2] * z + c[3],
    )


def normal_matrix(m: Mat4) -> tuple[Vec3, Vec3, Vec3]:
    a, b, c = (m[i][:3] for i in range(3))
    cofactors = (cross(b, c), cross(c, a), cross(a, b))
    determinant = dot(a, cofactors[0])
    require(abs(determinant) > 1e-14, "singular mesh transform")
    return cofactors


def edge(a: Vec2, b: Vec2, p: Vec2) -> float:
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def intersection_area(a: Triangle, b: Triangle, drop: int) -> float:
    i, j = tuple(axis for axis in range(3) if axis != drop)
    polygon = [(p[i], p[j]) for p in a]
    clip = [(p[i], p[j]) for p in b]
    sign = 1 if edge(*clip) > 0 else -1
    for left, right in zip(clip, [*clip[1:], clip[0]], strict=True):
        prior = polygon[-1]
        prior_dist = sign * edge(left, right, prior)
        result: list[Vec2] = []
        for point in polygon:
            distance = sign * edge(left, right, point)
            if (prior_dist < 0) != (distance < 0):
                t = prior_dist / (prior_dist - distance)
                result.append(
                    (prior[0] + t * (point[0] - prior[0]), prior[1] + t * (point[1] - prior[1]))
                )
            if distance >= 0:
                result.append(point)
            prior, prior_dist = point, distance
        if len(result) < 3:
            return 0.0
        polygon = result
    anchor = polygon[0]
    return abs(sum(edge(anchor, p, q) for p, q in itertools.pairwise(polygon[1:]))) / 2


def check_overlap(faces: list[tuple[Triangle, Vec3, str]]) -> None:
    bounds = [
        (
            tuple(map(min, zip(*tri, strict=True))),
            tuple(map(max, zip(*tri, strict=True))),
            tri,
            n,
            name,
        )
        for tri, n, name in faces
    ]
    axis = max(range(3), key=lambda i: max(b[1][i] for b in bounds) - min(b[0][i] for b in bounds))
    bounds.sort(key=lambda b: b[0][axis])
    active = []
    for left, right, tri, n, name in bounds:
        active = [b for b in active if b[1][axis] + PLANE_TOLERANCE >= left[axis]]
        drop = max(range(3), key=lambda i: abs(n[i]))
        for low, high, other, on, other_name in active:
            if any(
                right[i] + PLANE_TOLERANCE < low[i] or high[i] + PLANE_TOLERANCE < left[i]
                for i in range(3)
            ):
                continue
            if abs(dot(n, on)) < 1 - 1e-10 or any(
                abs(dot(n, subtract(p, tri[0]))) > PLANE_TOLERANCE for p in other
            ):
                continue
            if intersection_area(tri, other, drop) > AREA_TOLERANCE * abs(n[drop]):
                raise ValueError(f"positive-area coplanar overlap: {other_name} and {name}")
        active.append((left, right, tri, n, name))


class Glb:
    def __init__(self, data: bytes):
        require(len(data) >= 20, "truncated GLB header")
        magic, version, length = struct.unpack_from("<4s2I", data)
        require(
            (magic, version, length) == (b"glTF", 2, len(data)),
            "invalid GLB magic, version or file length",
        )
        json_size, chunk_type = struct.unpack_from("<I4s", data, 12)
        bin_header = 20 + json_size
        require(
            chunk_type == b"JSON" and json_size % 4 == 0 and bin_header + 8 <= len(data),
            "invalid GLB JSON chunk range",
        )
        self.doc: Json = json.loads(data[20:bin_header])
        require(self.doc["asset"]["version"] == "2.0", "expected glTF 2.0")
        bin_size, chunk_type = struct.unpack_from("<I4s", data, bin_header)
        require(
            chunk_type == b"BIN\0" and bin_size % 4 == 0 and bin_header + 8 + bin_size == len(data),
            "invalid GLB BIN chunk range",
        )
        buffers = self.doc["buffers"]
        require(len(buffers) == 1 and "uri" not in buffers[0], "expected one embedded GLB buffer")
        declared = unsigned(buffers[0]["byteLength"], "buffer byteLength", 1)
        require(0 <= bin_size - declared <= 3, "GLB BIN length does not match its buffer")
        self.bin = memoryview(data)[bin_header + 8 : bin_header + 8 + declared]
        self.views: list[Json] = self.doc["bufferViews"]
        self.accessors: list[Json] = self.doc["accessors"]
        for index in range(len(self.views)):
            self.view(index)
        self.layouts = [self.accessor_layout(accessor) for accessor in self.accessors]
        self.values: dict[int, list[tuple]] = {}

    def view(self, index: int) -> tuple[int, int, int | None]:
        view = item(self.views, index, "bufferView")
        require(
            type(view["buffer"]) is int and view["buffer"] == 0 and not view.get("extensions"),
            "non-embedded or compressed GLB bufferView",
        )
        start = unsigned(view.get("byteOffset", 0), "view offset")
        size = unsigned(view["byteLength"], "view length", 1)
        require(
            start % 4 == 0 and start + size <= len(self.bin), "bufferView byte range or alignment"
        )
        stride = view.get("byteStride")
        if stride is not None:
            require(
                type(stride) is int and 4 <= stride <= 252 and stride % 4 == 0,
                "invalid bufferView byteStride",
            )
        return start, size, stride

    def accessor_layout(self, accessor: Json) -> tuple[struct.Struct, int, int, int]:
        require(
            "sparse" not in accessor and "bufferView" in accessor,
            "sparse or unbacked accessor unsupported",
        )
        component = accessor["componentType"]
        kind = accessor["type"]
        fmt = COMPONENTS[component]
        component_length = struct.calcsize(fmt)
        count = unsigned(accessor["count"], "accessor count", 1)
        row = fmt * COMPONENT_COUNTS[kind]
        if kind.startswith("MAT"):
            dimension = int(kind[-1])
            row = (fmt * dimension + "x" * (-dimension * component_length % 4)) * dimension
        element = struct.Struct("<" + row)
        view_start, view_size, stride = self.view(accessor["bufferView"])
        offset = unsigned(accessor.get("byteOffset", 0), "accessor byteOffset")
        stride = stride or element.size
        require(
            stride >= element.size
            and stride % component_length == 0
            and offset % component_length == 0
            and offset + (count - 1) * stride + element.size <= view_size,
            "accessor byte range or alignment",
        )
        normal = accessor.get("normalized", False)
        require(
            type(normal) is bool and (not normal or component in (5120, 5121, 5122, 5123)),
            "invalid normalized accessor component",
        )
        return element, view_start + offset, stride, count

    def read(
        self, index: int, kind: str, allowed: tuple[int, ...], *, normalized: bool = False
    ) -> list[tuple]:
        accessor = item(self.accessors, index, "accessor")
        component = accessor["componentType"]
        require(
            accessor["type"] == kind and component in allowed,
            f"expected {kind} accessor, got {accessor['type']}/{component}",
        )
        require(
            accessor.get("normalized", False) == (normalized and component != 5126),
            "accessor normalization mismatch",
        )
        if index not in self.values:
            decoder, start, stride, count = self.layouts[index]
            values = [decoder.unpack_from(self.bin, start + i * stride) for i in range(count)]
            if component == 5126:
                require(
                    all(math.isfinite(x) for row in values for x in row),
                    "non-finite GLB accessor data",
                )
            if normalized and component != 5126:
                full_scale = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535}[component]
                values = [tuple(max(-1.0, x / full_scale) for x in row) for row in values]
            self.values[index] = values
        return self.values[index]

    def scene(self) -> tuple[dict[int, Mat4], dict[int, int | None]]:
        scene = item(self.doc["scenes"], self.doc.get("scene", 0), "scene")
        nodes = self.doc["nodes"]
        poses: dict[int, Mat4] = {}
        parents: dict[int, int | None] = {}
        queue = [(index, None) for index in scene["nodes"]]
        for index, parent in queue:
            node = item(nodes, index, "node")
            require(index not in poses, "scene contains a repeated or cyclic node")
            poses[index] = compose(
                IDENTITY if parent is None else poses[parent], node_transform(node)
            )
            parents[index] = parent
            queue.extend((child, index) for child in node.get("children", []))
        require(bool(poses), "empty GLB scene")
        return poses, parents

    def texture_source(self, root: Path, path: Path, info: Json) -> tuple[bytes, Path | None]:
        tex_transform = info.get("extensions", {}).get("KHR_texture_transform", {})
        require(
            info.get("texCoord", 0) == 0 and tex_transform.get("texCoord", 0) == 0,
            "texture must bind TEXCOORD_0",
        )
        texture = item(self.doc["textures"], info["index"], "texture")
        source = texture.get("extensions", {}).get("KHR_texture_basisu", {}).get("source")
        require(
            source is not None and "KHR_texture_basisu" in self.doc.get("extensionsUsed", []),
            "texture is not bound through KHR_texture_basisu",
        )
        if "source" not in texture:
            require(
                "KHR_texture_basisu" in self.doc.get("extensionsRequired", []),
                "KHR_texture_basisu must be required when there is no fallback",
            )
        image = item(self.doc["images"], source, "texture image")
        if "uri" in image:
            require("bufferView" not in image, "texture has both embedded and external image")
            external = asset_path(root, image["uri"], ".ktx2", relative_to=path.parent)
            return external.read_bytes(), external
        require(image.get("mimeType") == "image/ktx2", "wrong embedded KTX2 MIME type")
        start, size, stride = self.view(image["bufferView"])
        require(stride is None, "image bufferView has a byteStride")
        return bytes(self.bin[start : start + size]), None

    def joints(self, skin_id: Any, active: dict[int, Mat4]) -> list[int]:
        skin = item(self.doc.get("skins", []), skin_id, "skin")
        joints = skin["joints"]
        require(
            bool(joints)
            and all(type(joint) is int and joint in active for joint in joints)
            and len(joints) == len(set(joints)),
            "skin joints are missing, reused, or outside the active scene",
        )
        if "skeleton" in skin:
            require(
                type(skin["skeleton"]) is int and skin["skeleton"] in active,
                "skin skeleton is outside the active scene",
            )
        if "inverseBindMatrices" in skin:
            require(
                len(self.read(skin["inverseBindMatrices"], "MAT4", (5126,))) == len(joints),
                "inverse bind matrix count differs from skin joint count",
            )
        return joints


def validate_sockets(
    glb: Glb, record: Json, poses: dict[int, Mat4], parents: dict[int, int | None]
) -> int:
    nodes = glb.doc["nodes"]
    sockets = record.get("sockets", {})
    tagged = {
        node.get("name")
        for i, node in enumerate(nodes)
        if i in poses and node.get("extras", {}).get("socket") is True
    }
    require(tagged <= sockets.keys(), f"unlisted tagged sockets: {tagged - sockets.keys()}")
    for name, rules in sockets.items():
        matches = [index for index in poses if nodes[index].get("name") == name]
        require(len(matches) == 1, f"required socket {name!r} appears {len(matches)} times")
        index = matches[0]
        require("mesh" not in nodes[index], f"socket {name!r} must be a transform node")
        if "parent" in rules:
            parent_name = None if parents[index] is None else nodes[parents[index]].get("name")
            require(
                parent_name == rules["parent"],
                f"socket {name!r} expected parent {rules['parent']!r}, found {parent_name!r}",
            )
        if "position" in rules:
            desired = components(rules["position"], 3, "socket position")
            tolerance = rules.get("tolerance", 0.001)
            require(
                type(tolerance) in (float, int) and 0 < tolerance <= 0.01,
                "socket tolerance exceeds 1 cm",
            )
            actual = transform_point(poses[index], (0, 0, 0))
            require(
                math.dist(actual, desired) <= tolerance,
                f"socket {name!r} is at {actual}, expected {desired}",
            )
    return len(sockets)


def validate_materials(
    glb: Glb,
    root: Path,
    path: Path,
    used: set[int],
    record: Json,
    textures: dict[str, tuple[Path, Json]],
) -> None:
    expected = record.get("material_textures", {})
    names = set()
    for index in used:
        material = item(glb.doc.get("materials", []), index, "material")
        name = material.get("name")
        require(
            isinstance(name, str) and bool(name) and name not in names,
            "used material requires a unique name",
        )
        names.add(name)
        extensions = material.get("extensions", {})
        require(
            extensions.keys() <= {"KHR_materials_emissive_strength", "KHR_materials_unlit"},
            f"{name}: unsupported material extension",
        )
        pbr = material.get("pbrMetallicRoughness", {})
        orm = pbr.get("metallicRoughnessTexture")
        ao = material.get("occlusionTexture")
        require(
            (ao is None) == (orm is None) and (ao is None or ao["index"] == orm["index"]),
            f"{name}: occlusion and metallic-roughness must bind the same ORM texture",
        )
        bindings = {
            "basecolor": pbr.get("baseColorTexture"),
            "normal": material.get("normalTexture"),
            "orm": orm,
            "emissive": material.get("emissiveTexture"),
        }
        declared = expected.get(name, {})
        require(
            declared.keys() == {role for role, info in bindings.items() if info is not None},
            f"{name}: texture roles differ from manifest",
        )
        for role, info in bindings.items():
            if info is None:
                continue
            key = declared[role]
            require(key in textures, f"{name} {role}: undeclared texture file {key}")
            expected_path, texture = textures[key]
            require(
                texture["role"] == role, f"{name}: exact role mismatch for {key}, wanted {role}"
            )
            actual, external = glb.texture_source(root, path, info)
            if role == "orm":
                ao_data, ao_path = glb.texture_source(root, path, ao)
                require(
                    ao_data == actual and ao_path == external, f"{name}: shared ORM binding differs"
                )
            require(
                (external is None or external == expected_path)
                and digest(actual) == texture["sha256"],
                f"{name}: {role} texture binary/path does not match {key}",
            )
            limit = record["limits"].get("texture_size")
            if limit is not None:
                require(
                    max(texture["width"], texture["height"])
                    <= unsigned(limit, "texture size budget", 1),
                    f"{name}: texture size over budget",
                )
    require(expected.keys() <= names, f"unused material bindings {expected.keys() - names}")


def check_skin(glb: Glb, attributes: Json, joint_count: int, vertex_count: int) -> None:
    if joint_count == 0:
        require(
            "JOINTS_0" not in attributes and "WEIGHTS_0" not in attributes,
            "skinning attributes without a skin",
        )
        return
    require(
        not ({"JOINTS_1", "WEIGHTS_1"} & attributes.keys()),
        "more than four skin influences unsupported",
    )
    require(
        {"JOINTS_0", "WEIGHTS_0"} <= attributes.keys(),
        "skinned primitive missing joints or weights",
    )
    joints = glb.read(attributes["JOINTS_0"], "VEC4", (5121, 5123))
    weights = glb.read(attributes["WEIGHTS_0"], "VEC4", (5121, 5123, 5126), normalized=True)
    require(
        len(joints) == len(weights) == vertex_count, "skin attribute count differs from POSITION"
    )
    require(
        all(0 <= j < joint_count for row in joints for j in row),
        "vertex joint index outside the skin",
    )
    require(
        all(all(0 <= w <= 1 for w in row) and abs(sum(row) - 1) <= 0.012 for row in weights),
        "skin vertex weights do not sum to one",
    )


def validate_model(root: Path, record: Json, textures: dict[str, tuple[Path, Json]]) -> ModelStats:
    path = asset_path(root, record["file"], ".glb")
    data = path.read_bytes()
    require(digest(data) == record["sha256"], "GLB SHA-256 mismatch")
    glb = Glb(data)
    poses, parents = glb.scene()
    nodes = glb.doc["nodes"]
    meshes = glb.doc["meshes"]
    planars = {
        (p["node"], unsigned(p["primitive"], "planar primitive index")): p.get("max_degrees", 2.0)
        for p in record.get("planar_primitives", [])
    }
    require(
        len(planars) == len(record.get("planar_primitives", [])),
        "duplicate planar primitive checks",
    )
    planar_seen = set()
    used: set[int] = set()
    uses_default_material = False
    bones = set()
    faces = []
    stats = {"triangles": 0, "vertices": 0, "file_bytes": len(data)}
    for index, pose in poses.items():
        node = nodes[index]
        if "mesh" not in node:
            require("skin" not in node, "skin bound to a node with no mesh")
            continue
        mesh = item(meshes, node["mesh"], "mesh")
        joints = glb.joints(node["skin"], poses) if "skin" in node else []
        bones.update(joints)
        cofactors = normal_matrix(pose)
        for primitive_id, primitive in enumerate(mesh["primitives"]):
            label = f"{node.get('name', index)}/primitive {primitive_id}"
            try:
                require(
                    primitive.get("mode", 4) == 4 and not primitive.get("extensions"),
                    "expected uncompressed TRIANGLES",
                )
                attributes = primitive["attributes"]
                require(
                    {"POSITION", "NORMAL", "TEXCOORD_0"} <= attributes.keys(),
                    "missing POSITION, NORMAL or UV0 (TEXCOORD_0)",
                )
                position_index = attributes["POSITION"]
                positions = glb.read(position_index, "VEC3", (5126,))
                normals = glb.read(attributes["NORMAL"], "VEC3", (5126,))
                uv = glb.read(attributes["TEXCOORD_0"], "VEC2", (5121, 5123, 5126), normalized=True)
                count = len(positions)
                require(
                    len(normals) == len(uv) == count,
                    "NORMAL or UV0 attribute count differs from POSITION",
                )
                require(
                    all(0.98**2 <= dot(n, n) <= 1.02**2 for n in normals), "non-unit vertex normals"
                )
                accessor = glb.accessors[position_index]
                for name, measure in (("min", min), ("max", max)):
                    declared = components(accessor[name], 3, f"POSITION {name}")
                    require(
                        all(
                            abs(measure(p[i] for p in positions) - declared[i]) <= 1e-5
                            for i in range(3)
                        ),
                        f"POSITION {name} does not match the vertex data",
                    )
                check_skin(glb, attributes, len(joints), count)

                material = primitive.get("material")
                bound = {}
                if material is None:
                    uses_default_material = True
                else:
                    bound = item(glb.doc.get("materials", []), material, "material")
                    used.add(material)
                if "TANGENT" in attributes:
                    tangents = glb.read(attributes["TANGENT"], "VEC4", (5126,))
                    require(
                        len(tangents) == count
                        and all(
                            abs(abs(t[3]) - 1) <= 1e-4
                            and 0.98**2 <= dot(t[:3], t[:3]) <= 1.02**2
                            and abs(dot(n, t[:3])) <= 0.03
                            for n, t in zip(normals, tangents, strict=True)
                        ),
                        "invalid tangent basis",
                    )
                elif bound.get("normalTexture"):
                    raise ValueError("normal map requires exported TANGENT")
                pbr = bound.get("pbrMetallicRoughness", {})
                textured = bool(
                    {"baseColorTexture", "metallicRoughnessTexture"} & pbr.keys()
                    or {"occlusionTexture", "normalTexture", "emissiveTexture"} & bound.keys()
                )

                if "indices" in primitive:
                    indices = [
                        i for (i,) in glb.read(primitive["indices"], "SCALAR", (5121, 5123, 5125))
                    ]
                    require(
                        all(0 <= i < count for i in indices), "triangle index outside the vertices"
                    )
                else:
                    indices = list(range(count))
                require(
                    len(indices) >= 3 and len(indices) % 3 == 0, "incomplete TRIANGLES index data"
                )
                stats["triangles"] += len(indices) // 3
                stats["vertices"] += count
                require(
                    stats["triangles"] <= record["limits"]["triangles"], "triangles over budget"
                )
                points = [transform_point(pose, point) for point in positions]
                planar_key = (node.get("name"), primitive_id)
                threshold = planars.get(planar_key)
                if threshold is not None:
                    require(
                        type(threshold) in (float, int) and 0 < threshold <= 15,
                        "invalid planar normal tolerance",
                    )
                    require(
                        planar_key not in planar_seen,
                        f"duplicate node name for planar check {planar_key}",
                    )
                    planar_seen.add(planar_key)
                cutoff = math.cos(math.radians(threshold)) if threshold is not None else None
                for face_index, (a, b, c) in enumerate(
                    zip(indices[::3], indices[1::3], indices[2::3], strict=True)
                ):
                    if textured:
                        require(
                            abs(edge(uv[a], uv[b], uv[c])) > 1e-12,
                            f"zero-area UV0 triangle {face_index}",
                        )
                    tri = (points[a], points[b], points[c])
                    n = unit(cross(subtract(tri[1], tri[0]), subtract(tri[2], tri[0])))
                    if cutoff is not None:
                        for vertex in (a, b, c):
                            corner = unit(tuple(dot(row, normals[vertex]) for row in cofactors))
                            require(
                                dot(n, corner) >= cutoff,
                                f"planar corner normal deviates by >{threshold}°",
                            )
                    faces.append((tri, n, f"{label} triangle {face_index}"))
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f"{label}: {error}") from error

    require(
        bool(faces) and planar_seen == planars.keys(),
        f"no faces or missing planar primitives: {planars.keys() - planar_seen}",
    )
    stats.update(
        materials=len(used) + int(uses_default_material),
        bones=len(bones),
        sockets=validate_sockets(glb, record, poses, parents),
    )
    for key in ("triangles", "materials", "bones", "sockets", "file_bytes", "vertices"):
        if key not in record["limits"] and key in ("file_bytes", "vertices"):
            continue
        limit = unsigned(record["limits"][key], f"{key} budget")
        require(stats[key] <= limit, f"{key} over budget: {stats[key]} > {limit}")
    if "animations" in record:
        actual = [clip["name"] for clip in glb.doc.get("animations", [])]
        require(
            sorted(actual) == sorted(record["animations"]) and len(set(actual)) == len(actual),
            f"animation clip names differ from manifest: {actual}",
        )
    validate_materials(glb, root, path, used, record, textures)
    check_overlap(faces)
    return stats


def verify_manifest(path: Path, decoder: Decoder | None) -> tuple[int, int]:
    document = json.loads(path.read_text(encoding="utf-8"))
    require(
        type(document["version"]) is int and document["version"] == 1,
        "expected asset manifest version 1",
    )
    textures: dict[str, tuple[Path, Json]] = {}
    root = path.resolve().parent
    seen_paths = set()
    series: dict[str, dict[int, tuple[ModelStats, Json]]] = {}
    for record in document["textures"]:
        name = record["file"]
        address = asset_path(root, name, ".ktx2")
        require(address not in seen_paths and name not in textures, f"duplicate texture {name!r}")
        try:
            validate_texture(address.read_bytes(), record, decoder)
        except (KeyError, TypeError, ValueError, OSError) as error:
            raise ValueError(f"{name}: {error}") from error
        textures[name] = (address, record)
        seen_paths.add(address)
        if decoder is not None and record["role"] == "orm" and not record.get("samples"):
            print(f"{name}: decoded ORM without independent channel reference samples")

    for model in document["models"]:
        name = model["id"]
        level = unsigned(model["lod"], "LOD")
        siblings = series.setdefault(name, {})
        address = asset_path(root, model["file"], ".glb")
        require(
            level not in siblings and address not in seen_paths,
            f"duplicate GLB or {name} LOD{level}",
        )
        try:
            stats = validate_model(root, model, textures)
        except (KeyError, TypeError, ValueError, OSError) as error:
            raise ValueError(f"{name} LOD{level}: {error}") from error
        siblings[level] = (stats, model)
        seen_paths.add(address)
        print(
            f"{name} LOD{level}: {stats['triangles']} tris, {stats['materials']} materials, "
            f"{stats['bones']} bones, {stats['sockets']} sockets"
        )

    for name, siblings in series.items():
        levels = sorted(siblings)
        require(
            levels == list(range(len(levels))),
            f"{name}: LOD chain must start at 0 and be contiguous",
        )
        for low, high in itertools.pairwise(levels):
            near, near_record = siblings[low]
            far, far_record = siblings[high]
            require(
                far["triangles"] < near["triangles"],
                f"{name}: LOD{high} does not reduce triangle count",
            )
            require(
                far_record.get("sockets", {}) == near_record.get("sockets", {}),
                f"{name}: LOD{high} changes the socket contract",
            )
    require(bool(seen_paths), "empty asset manifest")
    return len(document["models"]), len(textures)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest", action="append", type=Path, help="Check this local manifest (repeatable)."
    )
    parser.add_argument(
        "--ktx", type=Path, default=DEFAULT_KTX, help="Path to the pinned 4.4.2 ktx executable."
    )
    parser.add_argument(
        "--headers-only",
        action="store_true",
        help="Check GLB geometry and KTX2 headers without pixel claims.",
    )
    args = parser.parse_args()
    manifests = args.manifest or [path for path in DEFAULT_MANIFESTS if path.exists()]
    if not manifests:
        print("No staged model or material manifests. Use --manifest PATH for an asset.")
        return

    decoder = None
    if not args.headers_only:
        # A GLB without textures only needs Python. Resolve the pinned tool on first use.
        @functools.lru_cache(maxsize=1)
        def executable() -> Path:
            return checked_ktx(args.ktx)

        def decoder(data: bytes) -> bytes:
            return decode_ktx2(executable(), data)

    for path in manifests:
        models, textures = verify_manifest(path, decoder)
        detail = (
            "headers only, pixels unverified"
            if args.headers_only
            else "including KTX2 RGBA8 pixel checks"
        )
        print(f"{path}: {models} GLBs and {textures} KTX2 textures passed ({detail}).")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, OSError) as error:
        sys.exit(str(error))
