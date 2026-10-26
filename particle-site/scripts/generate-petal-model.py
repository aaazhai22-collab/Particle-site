"""Build a self-contained, artistic pink flower for the local particle editor.

Only NumPy and Pillow are required. This is a hand-designed botanical
approximation, not a claim of reconstructing an unseen reference photograph.
All petals are closed curved solids with linear RGB and a custom _SURFACE
attribute. No image plane, texture rectangle, external asset or web service.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import struct

import numpy as np
from PIL import Image

PROJECT = Path(__file__).resolve().parents[1]
TAU = math.tau


def unit(values):
    values = np.asarray(values, dtype=np.float64)
    return values / np.maximum(np.linalg.norm(values, axis=-1, keepdims=True), 1e-14)


def linear(rgb):
    values = np.asarray(rgb, dtype=np.float64) / 255.0
    return np.where(values <= .04045, values / 12.92, ((values + .055) / 1.055) ** 2.4)


def srgb(values):
    values = np.maximum(values, 0)
    return np.where(values <= .0031308, values * 12.92, 1.055 * values ** (1 / 2.4) - .055)


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def normals_for(positions, indices):
    cross = np.cross(positions[indices[:, 1]] - positions[indices[:, 0]],
                     positions[indices[:, 2]] - positions[indices[:, 0]])
    normals = np.zeros_like(positions)
    for corner in range(3):
        np.add.at(normals, indices[:, corner], cross)
    return unit(normals)


def signed_volume(positions, indices):
    a, b, c = (positions[indices[:, axis]] for axis in range(3))
    return float(np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6)


def finish(name, positions, indices, colors, surface, category, **extra):
    positions = np.asarray(positions, dtype=np.float64)
    indices = np.asarray(indices, dtype=np.uint32)
    if signed_volume(positions, indices) < 0:
        indices = indices[:, [0, 2, 1]].copy()
    return dict(name=name, positions=positions, indices=indices,
                normals=normals_for(positions, indices),
                colors=np.asarray(colors, dtype=np.float64),
                surface=np.asarray(surface, dtype=np.float64), category=category, **extra)


def disk_grid(rings, segments):
    rho = [0.0]
    theta = [0.0]
    for ring in range(1, rings + 1):
        rho.extend([ring / rings] * segments)
        theta.extend(np.arange(segments) / segments * TAU)
    faces = [[0, 1 + j, 1 + (j + 1) % segments] for j in range(segments)]
    for ring in range(rings - 1):
        inner = 1 + ring * segments
        outer = inner + segments
        for j in range(segments):
            a, b = inner + j, outer + j
            c, d = outer + (j + 1) % segments, inner + (j + 1) % segments
            faces.extend([[a, b, c], [a, c, d]])
    return np.array(rho), np.array(theta), np.array(faces, dtype=np.uint32)


def closed_sheet(name, points, faces, rho, colors, region, organ, thickness, category, **extra):
    normal = normals_for(points, faces)
    if normal[:, 2].mean() < 0:
        faces = faces[:, [0, 2, 1]].copy()
        normal *= -1
    count = len(points)
    positions = np.concatenate([points + normal * thickness / 2, points - normal * thickness / 2])
    triangles = [*faces.tolist(), *(faces[:, [0, 2, 1]] + count).tolist()]
    boundary = np.nonzero(rho >= 1 - 1e-9)[0]
    for j, a in enumerate(boundary):
        b = boundary[(j + 1) % len(boundary)]
        triangles.extend([[a, count + a, count + b], [a, count + b, b]])
    rgb = linear(colors)
    back = linear(np.clip(colors * np.array([.98, .97, .99]) + [1, 2, 1], 0, 255))
    edge = smooth(.48, .98, rho)
    surface = np.column_stack([np.full(count, region), edge, np.full(count, organ)])
    return finish(name, positions, triangles, np.concatenate([rgb, back]),
                  np.concatenate([surface, surface]), category, thickness=thickness, region=region, organ=organ, **extra)


def petal(index, total):
    rho, theta, faces = disk_grid(28, 112)
    t = rho * np.cos(theta)
    u = rho * np.sin(theta)
    v = (t + 1) / 2
    angle = TAU * index / total + math.radians([-13, 7, -8, 12, -5, 5, 0][index])
    length = [2.03, 2.12, 1.82, 2.18, 1.94, 2.06, 2.01][index]
    width = [1.02, .92, 1.04, .90, .98, 1.03, .98][index]
    phase = index * 1.73
    # An ovate disk gives a round broad tip instead of a triangular windmill.
    across = width * u * (.98 + .10 * t)
    along = .18 + length * v
    across += .14 * np.sin(np.pi * v) * np.sin(phase + v * 2.2) * (1 - .35 * u * u)
    scallop = 1 + .025 * np.sin(theta * 7 + phase) * rho ** 5
    across *= scallop
    along += .035 * np.cos(theta * 6 + phase) * rho ** 6
    tip_lift = [.42, .95, .14, .58, .30, .68, .33][index]
    roll = [.95, 1.22, .72, -.58, 1.02, 1.12, .9][index]
    edge_angle = roll * smooth(.55, .99, np.abs(u)) * (.45 + .55 * np.sin(np.pi * v)) * np.where(u > 0, 1, .62)
    edge_distance = width * np.maximum(np.abs(u) - .55, 0)
    across -= np.sign(u) * edge_distance * (1 - np.cos(edge_angle))
    z = (.018 + .18 * v + tip_lift * v ** 3 + .10 * np.sin(np.pi * v)
         + .10 * u * u * np.sin(np.pi * v) + .18 * u * np.sin(np.pi * v)
         + .07 * u * v * math.sin(phase + .4) + edge_distance * np.sin(edge_angle)
         + .032 * np.sin(u * 12 + v * 4 + phase) * np.sin(np.pi * v) * (.8 - .4 * v)
         + .105 * rho ** 7 * (.58 + .42 * np.sin(theta * 3 + phase)) * (.3 + .7 * v)
         + .045 * math.sin(phase) * np.sin(np.pi * v))
    radial = np.array([math.cos(angle), math.sin(angle), 0])
    tangent = np.array([-math.sin(angle), math.cos(angle), 0])
    points = along[:, None] * radial + across[:, None] * tangent
    points[:, 2] = z
    # Inner throat is creamy pink; outer margins stay saturated after additive
    # particle rendering. The rim has extra pigment, never a bright white border.
    pink = np.clip(.80 * smooth(.10, .97, v) + .36 * smooth(.55, 1, rho) * smooth(.10, .50, v), 0, 1)
    colors = np.array([249, 219, 224]) * (1 - pink[:, None]) + np.array([227, 65, 119]) * pink[:, None]
    vein = (.5 + .5 * np.sin(u * 31 / (.45 + v) + v * 5 + phase)) * np.sin(np.pi * v) * (.25 + .75 * rho)
    colors -= vein[:, None] * np.array([1.8, 9.0, 4.2])
    colors += math.sin(phase) * np.array([0, 2.4, 1.8])
    return closed_sheet(f'petal-{index + 1:02d}-broad-curled-pink', points, faces, rho, colors,
                        index / (total - 1), 0, .026 + .003 * (index % 3), 'closed-petal',
                        description='Broad ovate petal, radial pleats, rolled scalloped rim and a real back surface')


def ellipsoid(name, center, radii, color, organ, region, axis=None, latitudes=9, segments=16, category='anther'):
    center = np.asarray(center, dtype=float)
    axis = unit(axis if axis is not None else [0, 0, 1])
    reference = np.array([0, 0, 1]) if abs(axis[2]) < .9 else np.array([0, 1, 0])
    right = unit(np.cross(reference, axis))
    up = np.cross(axis, right)
    rx, ry, rz = radii
    local = [[0, 0, rz]]
    for ring in range(1, latitudes):
        phi = math.pi * ring / latitudes
        for j in range(segments):
            theta = j * TAU / segments
            groove = 1 + (.035 if category == 'anther' else 0) * math.cos(theta * 5) * math.sin(phi)
            local.append([rx * math.sin(phi) * math.cos(theta) * groove,
                          ry * math.sin(phi) * math.sin(theta) * groove, rz * math.cos(phi)])
    south = len(local)
    local.append([0, 0, -rz])
    local = np.asarray(local)
    points = center + local[:, 0, None] * right + local[:, 1, None] * up + local[:, 2, None] * axis
    faces = [[0, 1 + j, 1 + (j + 1) % segments] for j in range(segments)]
    for ring in range(latitudes - 2):
        for j in range(segments):
            a = 1 + ring * segments + j
            b = 1 + ring * segments + (j + 1) % segments
            c, d = a + segments, b + segments
            faces.extend([[a, c, d], [a, d, b]])
    last = 1 + (latitudes - 2) * segments
    faces += [[south, last + (j + 1) % segments, last + j] for j in range(segments)]
    t = (local[:, 2] / rz + 1) / 2
    rgb = np.asarray(color) * (.86 + .14 * t[:, None])
    if category == 'anther':
        rgb += t[:, None] * np.array([5, 15, 4])
    surface = np.column_stack([np.full(len(points), region), .25 + .65 * t, np.full(len(points), organ)])
    return finish(name, points, faces, linear(np.clip(rgb, 0, 255)), surface, category, organ=organ, region=region)


def tube(name, control, radius, color_start, color_end, organ, category, rings=12, sides=10, region=.5):
    control = np.asarray(control, dtype=float)
    t = np.linspace(0, 1, rings + 1)[:, None]
    centers = (1-t)**3*control[0] + 3*(1-t)**2*t*control[1] + 3*(1-t)*t*t*control[2] + t**3*control[3]
    tangents = unit(np.gradient(centers, axis=0))
    positions, colors, surface, faces = [], [], [], []
    for ring, (center, tangent) in enumerate(zip(centers, tangents)):
        reference = np.array([0, 0, 1]) if abs(tangent[2]) < .9 else np.array([0, 1, 0])
        normal = unit(np.cross(reference, tangent))
        binormal = np.cross(tangent, normal)
        v = ring / rings
        for side in range(sides):
            angle = side / sides * TAU
            positions.append(center + (normal * math.cos(angle) + binormal * math.sin(angle)) * radius * (.88 + .12 * math.sin(v * math.pi)))
            colors.append(linear(np.asarray(color_start) * (1-v) + np.asarray(color_end) * v))
            surface.append([region, .15 + .45 * v if organ == 1 else .18, organ])
    for ring in range(rings):
        for side in range(sides):
            a = ring * sides + side
            b = ring * sides + (side + 1) % sides
            c, d = a + sides, b + sides
            faces.extend([[a, b, d], [a, d, c]])
    for end in [0, rings]:
        cap = len(positions)
        positions.append(centers[end])
        colors.append(linear(color_start if end == 0 else color_end))
        surface.append([region, .1 if end == 0 else .65, organ])
        for side in range(sides):
            a, b = end * sides + side, end * sides + (side + 1) % sides
            faces.append([cap, b, a] if end == 0 else [cap, a, b])
    return finish(name, positions, faces, colors, surface, category, organ=organ, region=region)


def leaf(name, origin, angle, length, width, z, region, category='closed-leaf'):
    rho, theta, faces = disk_grid(12, 48)
    t, u = rho * np.cos(theta), rho * np.sin(theta)
    v = (t + 1) / 2
    along = length * v
    across = width * u * (.75 + .2 * t)
    points = np.column_stack([origin[0] + along * math.cos(angle) - across * math.sin(angle),
                              origin[1] + along * math.sin(angle) + across * math.cos(angle),
                              z - .10 * np.sin(np.pi * v) + .06 * u * u + .003 * np.cos(u * 9) * np.sin(np.pi * v)])
    colors = np.tile(np.array([43, 96, 48], dtype=float), (len(points), 1))
    colors += (1 - np.abs(u))[:, None] * [18, 25, 5]
    return closed_sheet(name, points, faces, rho, colors, region, 2, .024, category)


def flower(petal_count, seed):
    rng = np.random.default_rng(seed)
    meshes = [petal(i, petal_count) for i in range(petal_count)]
    meshes.append(ellipsoid('center-01-golden-receptive-dome', [0, 0, .15], [.44, .44, .18], [241, 139, 18], 1, .5, category='center-dome', latitudes=15, segments=40))
    # A phyllotactic crown provides a dense, irregular yet coherent 3D center.
    for i in range(108):
        r = .49 * math.sqrt((i + .5) / 108)
        theta = i * math.pi * (3 - math.sqrt(5)) + .08 * math.sin(i * 2.3)
        radial = np.array([math.cos(theta), math.sin(theta), 0])
        start = radial * (r * .91)
        start[2] = .15 + .16 * math.sqrt(max(0, 1 - (r / .53)**2))
        height = .20 + .18 * (1 - r / .53) + float(rng.uniform(-.035, .045))
        tip = start + radial * (.025 + .06 * r / .53)
        tip[2] += height
        outward = unit(radial * .22 + [0, 0, 1])
        stem_top = tip - outward * .025
        meshes.append(tube(f'center-filament-{i + 1:03d}', [start, start + [0, 0, height * .3], stem_top - outward * .07, stem_top],
                           .0095 + float(rng.uniform(0, .003)), [237, 135, 18], [255, 190, 43], 1, 'filament', rings=6, sides=8))
        gold = [250, float(rng.uniform(124, 164)), float(rng.uniform(12, 29))]
        size = float(rng.uniform(.042, .057))
        meshes.append(ellipsoid(f'center-pollen-anther-{i + 1:03d}', tip, [size, size * .78, size * 1.25], gold, 1, .5,
                                axis=outward, latitudes=7, segments=12))
    meshes.append(ellipsoid('back-green-receptacle', [0, 0, -.075], [.46, .46, .22], [49, 95, 43], 2, .5, category='receptacle', latitudes=13, segments=36))
    for i in range(5):
        meshes.append(leaf(f'back-sepal-{i + 1:02d}', [0, 0], i * TAU / 5 + .35, .93, .23, -.19, i / 4, 'closed-sepal'))
    meshes.append(tube('short-curved-stem', [[0, 0, -.22], [.01, -.16, -.47], [.13, -.59, -.62], [.06, -.92, -.83]],
                       .048, [45, 91, 38], [53, 112, 45], 2, 'stem', rings=24, sides=12))
    meshes.append(leaf('short-stem-leaf-left', [.07, -.55], -2.7, .82, .27, -.61, .25))
    meshes.append(leaf('short-stem-leaf-right', [.07, -.62], -.30, .67, .23, -.68, .75))
    return meshes


def validate(meshes):
    reports = []
    for mesh in meshes:
        p, f = mesh['positions'], mesh['indices']
        assert np.isfinite(p).all() and np.isfinite(mesh['normals']).all()
        assert np.isfinite(mesh['colors']).all() and (mesh['colors'] >= 0).all() and (mesh['colors'] <= 1).all()
        assert f.max() < len(p) and f.min() >= 0
        face_cross = np.cross(p[f[:, 1]] - p[f[:, 0]], p[f[:, 2]] - p[f[:, 0]])
        areas = np.linalg.norm(face_cross, axis=1) / 2
        assert areas.min() > 1e-12, (mesh['name'], 'degenerate triangle')
        volume = signed_volume(p, f)
        assert volume > 0, (mesh['name'], 'inward winding')
        edges = Counter(tuple(sorted((int(a), int(b)))) for face in f for a, b in [(face[0], face[1]), (face[1], face[2]), (face[2], face[0])])
        assert all(value == 2 for value in edges.values()), (mesh['name'], 'unclosed topology')
        s = mesh['surface']
        assert s.shape == p.shape and np.isfinite(s).all()
        assert ((s[:, :2] >= 0) & (s[:, :2] <= 1)).all()
        assert np.isin(s[:, 2], [0, 1, 2]).all()
        agreement = np.einsum('ij,ij->i', unit(face_cross), mesh['normals'][f].mean(axis=1))
        assert agreement.min() > -.02, (mesh['name'], 'normal/winding disagreement', agreement.min())
        reports.append(dict(name=mesh['name'], category=mesh['category'], organ=mesh['organ'], vertices=len(p), triangles=len(f),
                            bounds=dict(min=p.min(0).tolist(), max=p.max(0).tolist()), area=float(areas.sum()),
                            signedVolume=volume, minTriangleArea=float(areas.min()), closed=True,
                            outwardWinding=True, normalAgreementMinimum=float(agreement.min()),
                            thickness=mesh.get('thickness'), surfaceRegion=mesh['region'],
                            edgeReleaseRange=[float(s[:, 1].min()), float(s[:, 1].max())]))
    return reports


def write_glb(meshes, path):
    binary = bytearray()
    views, accessors, nodes, gltf_meshes = [], [], [], []
    def accessor(array, indices=False, bounds=False):
        array = np.asarray(array, dtype='<u4' if indices else '<f4')
        if indices:
            maximum = int(array.max())
            array = np.asarray(array, dtype='<u2' if maximum < 65536 else '<u4')
        while len(binary) % 4:
            binary.append(0)
        start = len(binary)
        binary.extend(array.tobytes())
        views.append(dict(buffer=0, byteOffset=start, byteLength=array.nbytes, target=34963 if indices else 34962))
        item = dict(bufferView=len(views) - 1, componentType=(5123 if array.dtype.itemsize == 2 else 5125) if indices else 5126,
                    count=array.size if indices else len(array), type='SCALAR' if indices else 'VEC3')
        if bounds:
            item.update(min=array.min(0).tolist(), max=array.max(0).tolist())
        accessors.append(item)
        return len(accessors) - 1
    for mesh in meshes:
        attributes = {key: accessor(mesh[field], bounds=key == 'POSITION') for key, field in
                      [('POSITION', 'positions'), ('NORMAL', 'normals'), ('COLOR_0', 'colors'), ('_SURFACE', 'surface')]}
        gltf_meshes.append(dict(name=mesh['name'], primitives=[dict(attributes=attributes, indices=accessor(mesh['indices'].reshape(-1), True), material=0, mode=4)],
                                extras=dict(category=mesh['category'], organ=mesh['organ'], region=mesh['region'])))
        nodes.append(dict(name=mesh['name'], mesh=len(nodes)))
    document = dict(asset=dict(version='2.0', generator='Local NumPy/Pillow closed pink petal flower v1'), scene=0,
                    scenes=[dict(name='Pink broad-petal flower — artistic approximation', nodes=list(range(len(nodes))))],
                    nodes=nodes, meshes=gltf_meshes,
                    materials=[dict(name='Linear vertex-coloured matte plant surface', pbrMetallicRoughness=dict(baseColorFactor=[1, 1, 1, 1], metallicFactor=0, roughnessFactor=.7), doubleSided=False)],
                    accessors=accessors, bufferViews=views, buffers=[dict(byteLength=len(binary))])
    encoded = json.dumps(document, separators=(',', ':'), ensure_ascii=True).encode()
    encoded += b' ' * (-len(encoded) % 4)
    binary += b'\0' * (-len(binary) % 4)
    length = 12 + 8 + len(encoded) + 8 + len(binary)
    path.write_bytes(struct.pack('<III', 0x46546c67, 2, length) + struct.pack('<II', len(encoded), 0x4e4f534a) + encoded
                     + struct.pack('<II', len(binary), 0x004e4942) + binary)


def preview(meshes, path, yaw, pitch=0):
    yaw, pitch = math.radians(yaw), math.radians(pitch)
    ry = np.array([[math.cos(yaw), 0, math.sin(yaw)], [0, 1, 0], [-math.sin(yaw), 0, math.cos(yaw)]])
    rx = np.array([[1, 0, 0], [0, math.cos(pitch), -math.sin(pitch)], [0, math.sin(pitch), math.cos(pitch)]])
    rotation = rx @ ry
    all_positions = np.concatenate([mesh['positions'] for mesh in meshes])
    center = (all_positions.min(0) + all_positions.max(0)) / 2
    turned = (all_positions - center) @ rotation.T
    scale = 860 / max(float(np.ptp(turned[:, 0])), float(np.ptp(turned[:, 1])))
    depth_buffer = np.full((1024, 1024), -np.inf, dtype=np.float64)
    output = np.tile(np.array([7, 8, 12], dtype=np.uint8), (1024, 1024, 1))
    key, fill = unit([-.38, .55, 1]), unit([.7, -.05, .45])
    for mesh in meshes:
        points = (mesh['positions'] - center) @ rotation.T
        f = mesh['indices']
        normals = mesh['normals'] @ rotation.T
        xy = points[:, :2] * scale
        xy[:, 0] += 512
        xy[:, 1] = 512 - xy[:, 1]
        light = .24 + .66 * np.maximum(normals @ key, 0) + .16 * np.maximum(normals @ fill, 0)
        lit = mesh['colors'] * light[:, None]
        cross = np.cross(points[f[:, 1]] - points[f[:, 0]], points[f[:, 2]] - points[f[:, 0]])
        for face in f[cross[:, 2] > 1e-12]:
            triangle = xy[face]
            low = np.maximum(np.floor(triangle.min(0)).astype(int), 0)
            high = np.minimum(np.ceil(triangle.max(0)).astype(int), 1023)
            if np.any(high < low):
                continue
            a, b, c = triangle
            denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
            if abs(denominator) < 1e-10:
                continue
            xx, yy = np.meshgrid(np.arange(low[0], high[0] + 1) + .5, np.arange(low[1], high[1] + 1) + .5)
            wa = ((b[1] - c[1]) * (xx - c[0]) + (c[0] - b[0]) * (yy - c[1])) / denominator
            wb = ((c[1] - a[1]) * (xx - c[0]) + (a[0] - c[0]) * (yy - c[1])) / denominator
            wc = 1 - wa - wb
            z = wa * points[face[0], 2] + wb * points[face[1], 2] + wc * points[face[2], 2]
            depth = depth_buffer[low[1]:high[1] + 1, low[0]:high[0] + 1]
            visible = (wa >= -1e-7) & (wb >= -1e-7) & (wc >= -1e-7) & (z > depth)
            if not visible.any():
                continue
            interpolated = wa[visible, None] * lit[face[0]] + wb[visible, None] * lit[face[1]] + wc[visible, None] * lit[face[2]]
            patch = output[low[1]:high[1] + 1, low[0]:high[0] + 1]
            patch[visible] = np.uint8(np.clip(srgb(interpolated) * 255, 0, 255))
            depth[visible] = z[visible]
    Image.fromarray(output).save(path, optimize=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=PROJECT / 'public/examples')
    parser.add_argument('--petals', type=int, choices=[5, 6, 7], default=6)
    parser.add_argument('--seed', type=int, default=20261025)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    meshes = flower(args.petals, args.seed)
    reports = validate(meshes)
    path = args.output / 'petal-model.glb'
    write_glb(meshes, path)
    positions = np.concatenate([mesh['positions'] for mesh in meshes])
    lo, hi = positions.min(0), positions.max(0)
    metadata = dict(name='粉奶渐变宽瓣花 · 完整立体近似', version=2, seed=args.seed, petalCount=args.petals,
                    method='Hand-designed closed ovate petals, radial pleats, curled rims and phyllotactic 3D stamens',
                    source=dict(kind='procedural-artistic-approximation', exactReconstruction=False, externalResources=False),
                    meshCount=len(meshes), categories=dict(Counter(mesh['category'] for mesh in meshes)),
                    vertices=sum(report['vertices'] for report in reports), triangles=sum(report['triangles'] for report in reports),
                    bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                    bounds=dict(min=lo.tolist(), max=hi.tolist(), size=(hi-lo).tolist(), depthToWidth=float((hi[2]-lo[2])/(hi[0]-lo[0]))),
                    attributes=dict(POSITION='VEC3 Float32', NORMAL='VEC3 Float32 outward', COLOR_0='VEC3 Float32 linear RGB',
                                    _SURFACE=dict(type='VEC3 Float32', x='stable region 0..1; one distinct constant per petal', y='edge release weight 0..1; high at curled rims', z='organ: 0 petal / 1 center / 2 stem and leaves')),
                    validation=dict(allValuesFinite=True, allTrianglesNondegenerate=True, allMeshesClosed=True,
                                    allSignedVolumesPositive=True, outwardNormals=True, noImagePlane=True, noExternalResources=True),
                    limitations=['参考风格的人工近似花形，并非特定照片的精确三维重建。', '预览为本地软件灯光绘制；产品最终外观由浏览器粒子渲染决定。',
                                 '每瓣为独立闭合曲面，花瓣交叠为自然造型近似，未进行植物生长或碰撞仿真。'],
                    meshes=reports)
    (args.output / 'petal-model-metadata.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
    for label, yaw, pitch in [('front', 0, 0), ('three-quarter', 40, -8), ('side', 90, 0), ('back', 180, 0)]:
        preview(meshes, args.output / f'petal-preview-{label}.png', yaw, pitch)
    print(json.dumps({key: metadata[key] for key in ['meshCount', 'petalCount', 'vertices', 'triangles', 'bytes', 'bounds', 'validation']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
