"""Export a compact, self-contained fangding GLB without saving the source .blend.

Run with Blender (not system Python):
  blender --background --disable-autoexec --python scripts/export-ding-model.py -- \
    --source ../青铜方鼎_v002.blend

The source defaults to the file beside this repository. Only the GLB and JSON
metadata outputs are written; the source file is checked for accidental changes.
"""

import argparse
import hashlib
import json
from pathlib import Path
import struct
import sys
from datetime import datetime, timezone

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def triangle_count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def bounds(objects):
    points = [obj.matrix_world @ Vector(corner)
              for obj in objects for corner in obj.bound_box]
    return {
        "min": [min(point[axis] for point in points) for axis in range(3)],
        "max": [max(point[axis] for point in points) for axis in range(3)],
    }


def read_glb(path):
    with path.open("rb") as stream:
        magic, version, length = struct.unpack("<4sII", stream.read(12))
        if magic != b"glTF" or version != 2 or length != path.stat().st_size:
            raise RuntimeError("Invalid GLB header")
        chunk_length, chunk_type = struct.unpack("<II", stream.read(8))
        if chunk_type != 0x4E4F534A:
            raise RuntimeError("Missing GLB JSON chunk")
        return json.loads(stream.read(chunk_length))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path,
                        default=ROOT.parent / "青铜方鼎_v002.blend")
    parser.add_argument("--output", type=Path,
                        default=ROOT / "public/examples/ding-model.glb")
    parser.add_argument("--target-triangles", type=int, default=220000)
    parser.add_argument("--preserve-below", type=int, default=1000)
    parser.add_argument("--texture-size", type=int, default=2048)
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = parser.parse_args(argv)
    source = args.source.resolve()
    output = args.output.resolve()
    if source.suffix.lower() != ".blend" or not source.is_file():
        raise ValueError("--source must be an existing .blend file")
    if output.suffix.lower() != ".glb" or output == source:
        raise ValueError("--output must be a new .glb path")
    if args.texture_size < 64 or args.target_triangles < 1000:
        raise ValueError("Texture size or triangle target is too small")

    source_hash = sha256(source)
    bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
    objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    original_bounds = bounds(objects)
    counts = {obj.name: triangle_count(obj) for obj in objects}
    original_triangles = sum(counts.values())
    kept_triangles = sum(count for count in counts.values()
                         if count <= args.preserve_below)
    reducible_triangles = original_triangles - kept_triangles
    if kept_triangles >= args.target_triangles:
        raise ValueError("Preserved small meshes exceed the triangle target")
    ratio = min(1.0, (args.target_triangles - kept_triangles)
                / max(1, reducible_triangles))

    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.hide_render = False
        obj.select_set(True)
        if counts[obj.name] > args.preserve_below and ratio < 1.0:
            bpy.context.view_layer.objects.active = obj
            modifier = obj.modifiers.new("Web geometry reduction", "DECIMATE")
            modifier.decimate_type = "COLLAPSE"
            modifier.ratio = ratio
            modifier.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=modifier.name)

    # Build simple PBR materials in memory. Base color is the only texture needed
    # by the editor's particle sampler. No source datablock is saved back to disk.
    materials = {}
    textures = {}
    texture_metadata = []
    for obj in objects:
        for slot in obj.material_slots:
            source_material = slot.material
            if source_material is None:
                continue
            if source_material.name not in materials:
                material = bpy.data.materials.new(source_material.name + " | Web")
                material.use_nodes = True
                material.diffuse_color = source_material.diffuse_color
                material.node_tree.nodes.clear()
                shader = material.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
                surface = material.node_tree.nodes.new("ShaderNodeOutputMaterial")
                material.node_tree.links.new(shader.outputs["BSDF"], surface.inputs["Surface"])
                shader.inputs["Base Color"].default_value = source_material.diffuse_color
                shader.inputs["Metallic"].default_value = 0.15
                shader.inputs["Roughness"].default_value = 0.8
                image_node = next((node for node in source_material.node_tree.nodes
                                   if node.type == "TEX_IMAGE" and node.image
                                   and "basecolor" in node.image.name.lower()), None)
                if image_node is not None:
                    source_image = image_node.image
                    if source_image.name not in textures:
                        image = source_image.copy()
                        image.name = source_image.name + " | Web"
                        width, height = source_image.size
                        scale = min(1.0, args.texture_size / max(width, height))
                        resized = (max(1, round(width * scale)),
                                   max(1, round(height * scale)))
                        image.scale(*resized)
                        # Force the resized pixels to be used, even for packed
                        # source images with an existing PNG on disk.
                        image.pack()
                        textures[source_image.name] = image
                        texture_metadata.append({
                            "source": source_image.name,
                            "sourceSize": [width, height],
                            "exportSize": list(resized),
                            "encoding": "image/jpeg", "quality": 88,
                        })
                    texture = material.node_tree.nodes.new("ShaderNodeTexImage")
                    texture.image = textures[source_image.name]
                    uv = material.node_tree.nodes.new("ShaderNodeUVMap")
                    uv.uv_map = "UVMap"
                    material.node_tree.links.new(uv.outputs["UV"], texture.inputs["Vector"])
                    material.node_tree.links.new(texture.outputs["Color"],
                                                 shader.inputs["Base Color"])
                materials[source_material.name] = material
            slot.material = materials[source_material.name]

    final_triangles = sum(triangle_count(obj) for obj in objects)
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output), export_format="GLB", use_selection=True,
        export_yup=True, export_apply=True, export_cameras=False,
        export_lights=False, export_animations=False, export_extras=False,
        export_materials="EXPORT", export_image_format="JPEG",
        export_jpeg_quality=88, export_image_quality=88,
        export_unused_images=False, export_unused_textures=False,
        export_draco_mesh_compression_enable=False,
    )

    gltf = read_glb(output)
    if any("uri" in buffer for buffer in gltf.get("buffers", [])):
        raise RuntimeError("GLB unexpectedly references an external buffer")
    if any("bufferView" not in image for image in gltf.get("images", [])):
        raise RuntimeError("GLB unexpectedly references an external image")
    exported_triangles = sum(
        gltf["accessors"][primitive["indices"]]["count"] // 3
        for mesh in gltf["meshes"] for primitive in mesh["primitives"]
        if primitive.get("mode", 4) == 4
    )
    if exported_triangles >= 1000000:
        raise RuntimeError("GLB exceeds editor import limit")
    if sha256(source) != source_hash:
        raise RuntimeError("The source blend unexpectedly changed")

    metadata = {
        "sourceFile": source.name,
        "sourceSha256": source_hash,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "blenderVersion": bpy.app.version_string,
        "originalMeshCount": len(objects),
        "originalTriangles": original_triangles,
        "targetTriangles": args.target_triangles,
        "finalTriangles": final_triangles,
        "exportedTriangles": exported_triangles,
        "preservedSmallMeshCount": sum(count <= args.preserve_below
                                        for count in counts.values()),
        "decimationRatioForLargeMeshes": ratio,
        "originalBoundsZUp": original_bounds,
        "exportedBoundsYUp": {
            "min": [original_bounds["min"][0], original_bounds["min"][2],
                    -original_bounds["max"][1]],
            "max": [original_bounds["max"][0], original_bounds["max"][2],
                    -original_bounds["min"][1]],
        },
        "orientation": "glTF Y-up; source front -Y becomes +Z, toward Three.js camera",
        "textures": texture_metadata,
        "materials": len(gltf.get("materials", [])),
        "selfContained": True,
        "fileBytes": output.stat().st_size,
        "outputSha256": sha256(output),
        "sourceUnchanged": True,
    }
    metadata_path = output.with_name(output.stem + "-metadata.json")
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
                             encoding="utf-8")
    print("WEB_MODEL_EXPORT:" + json.dumps(metadata, ensure_ascii=False))


if __name__ == "__main__":
    main()
