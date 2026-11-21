# Model and material checks

Run the scoped offline check from the repository root. The GLB validator and synthetic tests
use Python 3.10+ and its standard library. Full texture checks also use the pinned KTX-Software
4.4.2 build, installed at `~/.local/opt/ktx-software-4.4.2/bin/ktx` by default.

```sh
make model-check
make model-check MODEL_CHECK_ARGS='--manifest path/to/manifest.json'
make model-check MODEL_CHECK_ARGS='--headers-only'
RIFT_MODEL_CHECK_KTX="$HOME/.local/opt/ktx-software-4.4.2/bin/ktx" make model-check
```

With no arguments, the validator uses the model and material manifests under
`assets-source/models` and `assets-source/materials` if they exist. `--manifest` may be specified
more than once. Set `--ktx /path/to/ktx` in `MODEL_CHECK_ARGS` if the pinned binary is installed
elsewhere. The environment variable enables the extra test against the real encoder and decoder.
The header-only mode is for work on geometry or layout without KTX installed. An export gate
requires the default decoded-pixel checks wherever it uses textures.

## Encode a map

```sh
python3 -B scripts/assets/encode_ktx2.py --role normal normal.png staging/normal.ktx2
```

The explicit roles are `basecolor`, `emissive`, `normal`, and `orm`. Base color and emissive PNGs
must contain sRGB-encoded RGB. Normal and ORM PNGs contain linear data. The encoder assigns the
matching transfer function without changing encoded color values. It writes 4×4 UASTC with
Zstandard, a full mip chain, and top-left `rd` orientation for `KHR_texture_basisu`. It normalizes
tangent vectors and uses a tighter rate-distortion target for normals. The source stays intact
and the destination must be new. The encoder reports the derivative hash and size.

Keep source PNGs and standalone KTX2 staged together with their authoring and bake evidence.
Check normal, ORM and sRGB maps in Blender and in the actual runtime under matched lights.

## Manifest

Version 1 supports a texture-only manifest with an empty `models` array, or a model set with its
texture records. All paths are relative to the manifest. A GLB may embed a KTX2 or use a local
relative URI. For an embedded map, the manifest's staged KTX2 must match the embedded bytes.

```json
{
  "version": 1,
  "textures": [
    {
      "file": "maps/ceramic-orm.ktx2",
      "role": "orm",
      "sha256": "<64 lowercase hexadecimal characters>",
      "width": 1024,
      "height": 1024,
      "samples": [
        { "x": 20, "y": 30, "rgb": [241, 118, 9], "tolerance": 12 }
      ]
    }
  ],
  "models": [
    {
      "id": "core-bastion",
      "lod": 0,
      "file": "core-lod0.glb",
      "sha256": "<64 lowercase hexadecimal characters>",
      "limits": { "triangles": 14000, "materials": 2, "bones": 0, "sockets": 1, "texture_size": 2048 },
      "sockets": { "coreAnchor": { "parent": "Base", "position": [0, 0, 0], "tolerance": 0.001 } },
      "planar_primitives": [{ "node": "Foot", "primitive": 0, "max_degrees": 2 }],
      "material_textures": { "Ceramic": { "orm": "maps/ceramic-orm.ktx2" } }
    }
  ]
}
```

- Use the planned asset budgets for `limits`. `triangles`, `materials`, `bones`, and `sockets` are
  required maxima. `vertices`, `file_bytes`, and `texture_size` are optional maxima. Separate
  per-LOD GLBs use the same `id` and increasing `lod` starting at zero, progressively fewer actual
  triangles, and the same socket contract.
- A socket is a named transform node. List each socket by exact name. Mark known socket nodes with
  `extras.socket: true` so the validator can detect extra sockets. The optional `parent` is the
  direct node name, with `null` for a root. `position` uses the composed scene transform in glTF
  metres. The default tolerance is 1 mm.
- Add each intentionally planar receiving surface to `planar_primitives` by exact node and
  primitive index. A model with a mix of flat and curved shading can export the planar surface
  as its own primitive or node. The checker measures its transformed corner normals against face
  normals. Coplanar overlap is checked across the complete exported scene, including triangles
  within a single primitive. Shared edges and vertices have zero area and pass.
- Material names and map roles must agree with the GLB bindings and the exact manifest path or
  embedded hash. Metallic-roughness and occlusion must point to the same ORM texture on UV0.
  Geometry must export UV0 on every primitive. Textured triangles must have positive UV area, and
  normal-mapped primitives must export tangents.
  An optional `animations` array checks the exact exported clip names.
- For channel evidence, author `samples` from reference channel data or independent material
  field values before encoding. Use top-left level-zero texel coordinates. ORM expects
  AO in red, roughness in green, metallic in blue. Reference samples should distinguish the
  channels where the recipe gives them different values. On a fully flat normal map, add
  `"flat_normal": true` to verify the entire level is approximately `[128, 128, 255]`. On a mixed
  map, add samples at known neutral locations. The validator decodes level zero and checks the
  unit vector length and positive Z of all normal texels. The KTX2 header alone cannot establish
  the semantic content of a channel.

The gate checks runtime structure and measured data. Keep Blender re-import, fixed rendered views,
motion playback, visual acceptance, and runtime device checks in each asset's review evidence.

Format references: [KTX2 specification](https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html),
[glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html), and
[KHR_texture_basisu](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_texture_basisu).
