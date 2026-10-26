"""Create a self-contained particle preset from the supplied static GLB.

This reads the source without saving it, reduces its geometry, retains UVs and
base color, and excludes shading-only maps which the particle sampler never uses.
Run with Blender, e.g.:
  blender --background --disable-autoexec --python scripts/export-uploaded-model.py -- \
    --source C:/path/to/source.glb --target-triangles 400000 --texture-size 4096
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import struct
import sys

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def read_glb(path):
    with path.open('rb') as stream:
        magic, version, length = struct.unpack('<4sII', stream.read(12))
        if magic != b'glTF' or version != 2 or length != path.stat().st_size:
            raise ValueError('Invalid GLB header')
        length, kind = struct.unpack('<II', stream.read(8))
        if kind != 0x4e4f534a:
            raise ValueError('Missing GLB JSON chunk')
        return json.loads(stream.read(length))


def triangles(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def scene_bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    return {'min': [min(p[i] for p in points) for i in range(3)],
            'max': [max(p[i] for p in points) for i in range(3)]}


def base_texture(shader):
    # Follow links from Base Color only, so normal and metallic maps cannot be
    # accidentally selected when an imported material has several image nodes.
    pending = [link.from_node for link in shader.inputs['Base Color'].links]
    visited = set()
    while pending:
        node = pending.pop()
        if node in visited:
            continue
        visited.add(node)
        if node.type == 'TEX_IMAGE' and node.image:
            return node
        for socket in node.inputs:
            pending.extend(link.from_node for link in socket.links)
    return None


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT/'public/examples/uploaded-model.glb')
    parser.add_argument('--target-triangles', type=int, default=400000)
    parser.add_argument('--texture-size', type=int, default=4096)
    parser.add_argument('--jpeg-quality', type=int, default=90)
    args = parser.parse_args(argv)
    source, output = args.source.resolve(), args.output.resolve()
    if source == output or output.suffix.lower() != '.glb':
        raise ValueError('Output must be a different .glb file')
    if not 1000 <= args.target_triangles <= 1000000 or not 64 <= args.texture_size <= 4096 or not 1 <= args.jpeg_quality <= 100:
        raise ValueError('Invalid export target, texture size, or JPEG quality')
    source_hash = sha256(source)
    source_spec = read_glb(source)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if not objects:
        raise ValueError('Source contains no mesh')
    original_bounds = scene_bounds(objects)
    original_triangles = sum(triangles(obj) for obj in objects)
    ratio = min(1, args.target_triangles / original_triangles)
    bpy.ops.object.select_all(action='DESELECT')
    material_cache, image_cache = {}, {}
    texture_metadata = []
    for obj in objects:
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        if ratio < 1:
            modifier = obj.modifiers.new('Web preset reduction', 'DECIMATE')
            modifier.decimate_type = 'COLLAPSE'
            modifier.ratio = ratio
            modifier.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        for slot in obj.material_slots:
            original = slot.material
            if original is None:
                continue
            if original.name not in material_cache:
                shader = next((node for node in original.node_tree.nodes if node.type == 'BSDF_PRINCIPLED'), None)
                if shader is None:
                    raise ValueError('Material has no imported base color shader')
                image_node = base_texture(shader)
                material = bpy.data.materials.new(original.name+' | Particle preset')
                material.use_nodes = True
                material.use_backface_culling = original.use_backface_culling
                material.diffuse_color = shader.inputs['Base Color'].default_value
                material.node_tree.nodes.clear()
                new_shader = material.node_tree.nodes.new('ShaderNodeBsdfPrincipled')
                new_shader.inputs['Base Color'].default_value = shader.inputs['Base Color'].default_value
                new_shader.inputs['Metallic'].default_value = 0
                new_shader.inputs['Roughness'].default_value = 0.8
                surface = material.node_tree.nodes.new('ShaderNodeOutputMaterial')
                material.node_tree.links.new(new_shader.outputs['BSDF'], surface.inputs['Surface'])
                if image_node:
                    source_image = image_node.image
                    if source_image.name not in image_cache:
                        image = source_image.copy()
                        image.name = source_image.name+' | Particle base color'
                        width, height = source_image.size
                        scale = min(1, args.texture_size / max(width, height))
                        resized = (max(1, round(width*scale)), max(1, round(height*scale)))
                        if resized != (width, height):
                            image.scale(*resized)
                        image.pack()
                        image_cache[source_image.name] = image
                        texture_metadata.append({'source':source_image.name, 'sourceSize':[width,height], 'exportSize':list(resized), 'encoding':'image/jpeg', 'quality':args.jpeg_quality})
                    texture = material.node_tree.nodes.new('ShaderNodeTexImage')
                    texture.image = image_cache[source_image.name]
                    texture.extension = image_node.extension
                    texture.interpolation = image_node.interpolation
                    uv = material.node_tree.nodes.new('ShaderNodeUVMap')
                    uv.uv_map = obj.data.uv_layers.active.name if obj.data.uv_layers.active else 'UVMap'
                    material.node_tree.links.new(uv.outputs['UV'], texture.inputs['Vector'])
                    material.node_tree.links.new(texture.outputs['Color'], new_shader.inputs['Base Color'])
                material_cache[original.name] = material
            slot.material = material_cache[original.name]
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output), export_format='GLB', use_selection=True,
        export_yup=True, export_apply=True, export_cameras=False,
        export_lights=False, export_animations=False, export_extras=False,
        export_normals=False, export_tangents=False,
        export_materials='EXPORT', export_image_format='JPEG',
        export_jpeg_quality=args.jpeg_quality, export_image_quality=args.jpeg_quality,
        export_unused_images=False, export_unused_textures=False,
        export_draco_mesh_compression_enable=False)
    spec = read_glb(output)
    primitives = [primitive for mesh in spec.get('meshes',[]) for primitive in mesh['primitives']]
    final_triangles = sum(spec['accessors'][p['indices']]['count']//3 for p in primitives)
    final_vertices = sum(spec['accessors'][p['attributes']['POSITION']]['count'] for p in primitives)
    self_contained = all('uri' not in item for item in spec.get('buffers',[])) and all('bufferView' in item for item in spec.get('images',[]))
    if not self_contained or final_triangles > args.target_triangles or output.stat().st_size > 20*1024*1024:
        raise RuntimeError('Preset exceeds target, file size, or self-contained requirement')
    if sha256(source) != source_hash:
        raise RuntimeError('Source file unexpectedly changed')
    metadata = {
        'name':'百合花束', 'kind':'model', 'sourceFile':source.name,
        'sourceSha256':source_hash, 'sourceBytes':source.stat().st_size,
        'generatedAt':datetime.now(timezone.utc).isoformat(), 'blenderVersion':bpy.app.version_string,
        'sourceMeshCount':len(source_spec.get('meshes',[])),
        'originalTriangles':original_triangles, 'targetTriangles':args.target_triangles,
        'exportedTriangles':final_triangles, 'exportedVertices':final_vertices,
        'decimationRatio':ratio, 'originalBoundsZUp':original_bounds,
        'exportedBoundsZUp':scene_bounds(objects),
        'orientation':'glTF Y-up; front +Z toward Three.js default camera; no correction required',
        'textures':texture_metadata, 'exportedTextureCount':len(spec.get('images',[])),
        'preserved':['shape','UV','base color','double-sided material'],
        'omitted':['normal map','metallic/roughness map','specular shading','normals'],
        'selfContained':self_contained, 'sourceUnchanged':True,
        'fileBytes':output.stat().st_size, 'outputSha256':sha256(output),
    }
    metadata_path = output.with_name(output.stem+'-metadata.json')
    metadata_path.write_text(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print('WEB_MODEL_EXPORT:'+json.dumps(metadata,ensure_ascii=False))


if __name__ == '__main__':
    main()
