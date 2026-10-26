"""Build a closed, vertex-coloured white lily from the supplied photograph.

The six visible petal silhouettes guide independent curved solids; colours are
sampled locally from the source, excluding its black background and anthers.
Depth, the reverse surfaces and hidden anatomy are explicitly artistic inferences.
No image plane or external texture is included in the self-contained GLB.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import shutil
import struct

import numpy as np
from PIL import Image, ImageFilter

PROJECT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('closed_flower_tools', Path(__file__).with_name('generate-petal-model.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
SCALE = 350.0
CENTER = np.array([650.0, 1075.0])

# Independent, asymmetric centre lines measured from the supplied image.
PETALS = [
    dict(name='upper-back', curve=[[650, 1075], [535, 910], [500, 635], [705, 548]], width=131, z=-.53, cup=.23, tip=.66, roll=.27, twist=.10),
    dict(name='upper-right', curve=[[650, 1075], [786, 987], [817, 625], [1034, 824]], width=126, z=-.47, cup=.51, tip=.20, roll=.38, twist=-.17),
    dict(name='lower-right-front', curve=[[650, 1075], [745, 1090], [854, 1192], [951, 1258]], width=139, z=-.27, cup=.43, tip=-.10, roll=.40, twist=.18),
    dict(name='lower-long', curve=[[650, 1075], [520, 1139], [327, 1305], [575, 1499]], width=112, z=-.38, cup=.42, tip=-.18, roll=.27, twist=-.15),
    dict(name='lower-left', curve=[[650, 1075], [432, 1047], [144, 957], [141, 1291]], width=143, z=-.45, cup=.48, tip=.19, roll=.42, twist=.13),
    dict(name='upper-left-back', curve=[[650, 1075], [485, 1051], [391, 742], [175, 892]], width=124, z=-.54, cup=.32, tip=.32, roll=.23, twist=-.13),
]


def world(xy, z):
    return np.column_stack([(xy[:, 0] - CENTER[0]) / SCALE,
                           (CENTER[1] - xy[:, 1]) / SCALE, z])


def colour_field(photo):
    rgb = np.asarray(photo.convert('RGB'), dtype=np.float64)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    valid = (rgb.max(axis=-1) > 48) & ~((r > g * 1.35) & (r > b * 1.45) & (g < 150))
    filled = rgb.copy()
    unresolved = ~valid
    mask = Image.fromarray(np.uint8(valid) * 255)
    numerator = Image.fromarray(np.uint8(rgb * valid[..., None]))
    for radius in [2, 8, 24, 60, 120]:
        weights = np.asarray(mask.filter(ImageFilter.GaussianBlur(radius)), dtype=float) / 255
        values = np.asarray(numerator.filter(ImageFilter.GaussianBlur(radius)), dtype=float)
        usable = unresolved & (weights > .015)
        filled[usable] = values[usable] / weights[usable, None]
        unresolved[usable] = False
    filled[unresolved] = [218, 222, 208]
    return np.clip(filled, 0, 255)


def petal(index, colours):
    config = PETALS[index]
    rho, theta, faces = base.disk_grid(36, 144)
    longitudinal, across = rho * np.cos(theta), rho * np.sin(theta)
    v = (longitudinal + 1) / 2
    vv = v[:, None]
    control = np.asarray(config['curve'], dtype=float)
    center = (1-vv)**3*control[0] + 3*(1-vv)**2*vv*control[1] + 3*(1-vv)*vv*vv*control[2] + vv**3*control[3]
    derivative = 3*(1-vv)**2*(control[1]-control[0]) + 6*(1-vv)*vv*(control[2]-control[1]) + 3*vv*vv*(control[3]-control[2])
    direction = base.unit(derivative)
    sideways = np.column_stack([direction[:, 1], -direction[:, 0]])
    width = config['width'] * (.70 + .43*v)
    edge_distance = np.maximum(np.abs(across) - .60, 0) * width / SCALE
    roll = config['roll'] * base.smooth(.50, 1.0, np.abs(across))
    # A rolled rim turns partly out of the image plane; it is never a sheet
    # extrusion of the photographed black rectangle.
    shift = across * width - np.sign(across) * edge_distance * SCALE * (1-np.cos(roll))
    shift += 7*np.sin(v*math.pi)*np.sin(index*1.4 + v*2.3)*(1-across**2)
    xy = center + sideways * shift[:, None]
    z = (config['z'] + config['tip']*v + config['cup']*np.sin(math.pi*v)
         + config['twist']*across*np.sin(math.pi*v)
         + edge_distance*np.sin(roll)
         + .075*across**2*np.sin(math.pi*v)
         + .008*np.sin(across*31/(.6+v)+v*3.2)*np.sin(math.pi*v)
         + .019*np.sin(across*9+v*5+index)*np.sin(math.pi*v)*across**2)
    points = world(xy, z)
    ix = np.clip(np.rint(xy[:, 0]).astype(int), 0, colours.shape[1]-1)
    iy = np.clip(np.rint(xy[:, 1]).astype(int), 0, colours.shape[0]-1)
    photographic = colours[iy, ix]
    green = 1-base.smooth(.04, .38, v)
    ivory = np.tile([226., 229., 219.], (len(v), 1))
    ivory = ivory*(1-green[:, None]*.54) + np.array([161, 181, 103])*green[:, None]*.54
    # Preserve photographic pale-grey/ivory variation without baking in strong
    # photographic shadows twice (the particle renderer also lights the solid).
    rgb = photographic*.48 + ivory*.52
    vein = (.5+.5*np.cos(across*65/(.55+v)+v*4+index*.7))*np.sin(math.pi*v)
    rgb -= vein[:, None]*[4.5, 4.7, 3.1]
    rgb += base.smooth(.72, 1, rho)[:, None]*[1.0, 2.4, 2.7]
    return base.closed_sheet(f'white-lily-petal-{index+1:02d}-{config["name"]}', points, faces, rho, np.clip(rgb, 0, 255),
                             index/5, 0, .017 + index%3*.002, 'closed-petal',
                             description='Photo-guided long white lily petal, closed back, longitudinal pleats and individually rolled rim')


def p(x, y, z):
    return np.array([(x-CENTER[0])/SCALE, (CENTER[1]-y)/SCALE, z], dtype=float)


def tube(name, control, radius, color_start, color_end, organ, category, rings=12, sides=10, region=.5):
    """Closed Bezier tube using a continuous frame, including the curved back stem."""
    control = np.asarray(control, dtype=float)
    t = np.linspace(0, 1, rings+1)[:, None]
    centers = (1-t)**3*control[0]+3*(1-t)**2*t*control[1]+3*(1-t)*t*t*control[2]+t**3*control[3]
    tangents = base.unit(np.gradient(centers, axis=0))
    reference = np.eye(3)[np.argmin(np.abs(tangents[0]))]
    previous = base.unit(np.cross(reference, tangents[0]))
    positions, colors, surface, faces = [], [], [], []
    for ring, (center, tangent) in enumerate(zip(centers, tangents)):
        normal = base.unit(previous-tangent*np.dot(previous, tangent))
        binormal = np.cross(tangent, normal)
        previous = normal
        v = ring/rings
        for side in range(sides):
            angle = side/sides*math.tau
            positions.append(center+(normal*math.cos(angle)+binormal*math.sin(angle))*radius*(.88+.12*math.sin(v*math.pi)))
            colors.append(base.linear(np.asarray(color_start)*(1-v)+np.asarray(color_end)*v))
            surface.append([region, .15+.45*v if organ == 1 else .18, organ])
    for ring in range(rings):
        for side in range(sides):
            a, b = ring*sides+side, ring*sides+(side+1)%sides
            c, d = a+sides, b+sides
            faces.extend([[a, b, d], [a, d, c]])
    for end in [0, rings]:
        cap = len(positions)
        positions.append(centers[end]); colors.append(base.linear(color_start if end == 0 else color_end)); surface.append([region, .1 if end == 0 else .65, organ])
        for side in range(sides):
            a, b = end*sides+side, end*sides+(side+1)%sides
            faces.append([cap, b, a] if end == 0 else [cap, a, b])
    return base.finish(name, positions, faces, colors, surface, category, organ=organ, region=region)


def flower(colours):
    meshes = [petal(index, colours) for index in range(6)]
    meshes.append(base.ellipsoid('pale-green-flower-throat', [0, 0, -.40], [.18, .17, .14], [143, 163, 73], 1, .5, latitudes=14, segments=32, category='throat'))
    # The reference has six long, distinct brown anthers; their filaments lean
    # left/up and project in front of the throat, rather than forming a flat disk.
    tips = [(383, 828, .63), (525, 822, .78), (581, 809, .62),
            (551, 901, .88), (369, 920, .82), (447, 970, .99)]
    bases = [(640, 1062), (647, 1061), (658, 1064), (647, 1071), (634, 1072), (638, 1077)]
    for index, ((x, y, z), (bx, by)) in enumerate(zip(tips, bases)):
        start, tip = p(bx, by, -.28), p(x, y, z)
        along = tip-start
        end = tip-base.unit(along)*.045
        control = [start, start+along*.30+[.015, 0, .055], start+along*.70+[.015, -.025, .04], end]
        meshes.append(tube(f'pale-green-filament-{index+1:02d}', control, .0125, [157, 180, 91], [213, 224, 156], 1, 'filament', rings=24, sides=12, region=index/5))
        # A long narrow ellipsoid approximates the photographed two pollen sacs.
        # Small asymmetric secondary lobe makes it read as an anther from behind.
        anther_axis = base.unit([-.55 + index*.025, .75, .20])
        meshes.append(base.ellipsoid(f'brown-pollen-anther-{index+1:02d}', tip, [.034, .027, .093], [141+index*3, 64+index*2, 27+index], 1, index/5,
                                    axis=anther_axis, latitudes=15, segments=24))
    pistil_start, pistil_top = p(649, 1074, -.25), p(514, 914, .96)
    axis = base.unit(pistil_top-pistil_start)
    meshes.append(tube('central-green-pistil-style', [pistil_start, pistil_start+[ -.07, .10, .30], pistil_top-axis*.18, pistil_top],
                            .019, [112, 144, 49], [174, 198, 98], 1, 'pistil', rings=25, sides=16))
    for index in range(3):
        angle = math.tau*index/3
        center = pistil_top+np.array([math.cos(angle)*.022, math.sin(angle)*.022, .018])
        meshes.append(base.ellipsoid(f'central-stigma-lobe-{index+1}', center, [.034, .034, .038], [183, 204, 111], 1, .5,
                                    latitudes=12, segments=20, category='stigma'))
    meshes.append(base.ellipsoid('inferred-green-back-receptacle', [0, -.015, -.54], [.19, .18, .20], [84, 119, 48], 2, .5,
                                latitudes=14, segments=28, category='receptacle'))
    meshes.append(tube('short-inferred-green-pedicel', [[0, -.015, -.58], [.025, -.07, -.75], [.07, -.12, -.93], [.12, -.2, -1.04]],
                            .037, [85, 121, 47], [104, 142, 58], 2, 'pedicel', rings=18, sides=14))
    return meshes


def write_glb(meshes, path):
    base.write_glb(meshes, path)
    data = path.read_bytes()
    length = struct.unpack_from('<I', data, 12)[0]
    document = json.loads(data[20:20+length])
    document['asset']['generator'] = 'Local photo-guided closed white lily model v1'
    document['asset']['extras'] = dict(method='Reference-guided artistic 3D approximation', exactReconstruction=False, unseenBackInferred=True)
    document['scenes'][0]['name'] = 'White lily — six solid petals and individually modelled stamens'
    encoded = json.dumps(document, separators=(',', ':'), ensure_ascii=True).encode()
    encoded += b' ' * (-len(encoded)%4)
    binary_chunk = data[20+length:]
    total = 20+len(encoded)+len(binary_chunk)
    path.write_bytes(struct.pack('<III', 0x46546c67, 2, total)+struct.pack('<II', len(encoded), 0x4e4f534a)+encoded+binary_chunk)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reference', type=Path, default=PROJECT/'public/examples/white-lily-reference.png')
    parser.add_argument('--output', type=Path, default=PROJECT/'public/examples')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    photo = Image.open(args.reference).convert('RGB')
    if photo.size != (1152, 2048):
        photo = photo.resize((1152, 2048), Image.Resampling.LANCZOS)
    meshes = flower(colour_field(photo))
    reports = base.validate(meshes)
    path = args.output/'white-lily-model.glb'
    write_glb(meshes, path)
    reference_copy = args.output/'white-lily-reference.png'
    if args.reference.resolve() != reference_copy.resolve():
        shutil.copyfile(args.reference, reference_copy)
    positions = np.concatenate([mesh['positions'] for mesh in meshes])
    low, high = positions.min(0), positions.max(0)
    metadata = dict(name='白百合 · 参考照片的立体近似', version=1, petalCount=6,
                    source=dict(kind='photo-guided-artistic-approximation', reference='white-lily-reference.png', referenceSha256=hashlib.sha256(reference_copy.read_bytes()).hexdigest(), exactReconstruction=False, unseenBackInferred=True),
                    meshCount=len(meshes), categories=dict(Counter(mesh['category'] for mesh in meshes)),
                    vertices=sum(report['vertices'] for report in reports), triangles=sum(report['triangles'] for report in reports),
                    bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                    bounds=dict(min=low.tolist(), max=high.tolist(), size=(high-low).tolist(), depthToWidth=float((high[2]-low[2])/(high[0]-low[0]))),
                    attributes=dict(POSITION='VEC3 Float32', NORMAL='VEC3 Float32 outward', COLOR_0='VEC3 Float32 linear RGB, locally sampled photograph / ivory blend', _SURFACE=dict(x='stable petal region 0..1', y='edge release weight 0..1', z='0 petal / 1 stamens and pistil / 2 back receptacle and pedicel')),
                    validation=dict(allValuesFinite=True, allTrianglesNondegenerate=True, allMeshesClosed=True, allSignedVolumesPositive=True, outwardNormals=True, noImagePlane=True, noExternalResources=True),
                    limitations=['依据单张参考图手工补建立体结构，非精确三维重建；背面及遮挡区域为艺术近似。', '花瓣原色依据照片局部采样与乳白底色混合，排除背景和花药遮挡；没有照片背景矩形。', '软件预览用于几何检查，实际粒子外观由浏览器着色器决定。'], meshes=reports)
    (args.output/'white-lily-model-metadata.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    for label, yaw, pitch in [('front', 0, 0), ('three-quarter', 42, -8), ('side', 90, 0), ('back', 180, 0)]:
        target = args.output/f'white-lily-preview-{label}.png'
        base.preview(meshes, target, yaw, pitch)
        pixels = np.asarray(Image.open(target)).copy()
        pixels[np.all(pixels == [7, 8, 12], axis=-1)] = 0
        Image.fromarray(pixels).save(target, optimize=True)
    print(json.dumps({key:metadata[key] for key in ['name', 'meshCount', 'petalCount', 'vertices', 'triangles', 'bytes', 'bounds', 'validation']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
