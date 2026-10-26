"""Make a local artistic 3D approximation of the supplied two-lily photograph.

Requires the bundled Pillow and NumPy only. No upload, training or image service.
The source photograph colours are projected onto separate curved, closed petals;
their unobserved depths, rear surfaces and hidden organs are explicitly inferred.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import shutil
import struct
from collections import Counter

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

PROJECT = Path(__file__).resolve().parents[1]
SCALE = 165.0
PATCH = 256
COLS = 4
ROWS = 6
NU, NV = 32, 48


def unit(vector):
    vector = np.asarray(vector, dtype=np.float64)
    return vector / np.maximum(np.linalg.norm(vector, axis=-1, keepdims=True), 1e-12)


def linear(rgb):
    value = np.asarray(rgb, dtype=np.float64) / 255.0
    return np.where(value <= 0.04045, value / 12.92, ((value + .055) / 1.055) ** 2.4)


def point(x, y, z):
    return np.array([(x - 368) / SCALE, (465 - y) / SCALE, z], dtype=np.float64)


def bezier(control, t):
    p = np.asarray(control, dtype=np.float64)
    t = np.asarray(t)[..., None]
    return (1-t)**3*p[0] + 3*(1-t)**2*t*p[1] + 3*(1-t)*t*t*p[2] + t**3*p[3]


def petal_coordinates(spec, u, v):
    center = bezier(spec['curve'], v)
    control = np.asarray(spec['curve'], dtype=np.float64)
    vv = np.asarray(v)[..., None]
    tangent = 3*(1-vv)**2*(control[1]-control[0]) + 6*(1-vv)*vv*(control[2]-control[1]) + 3*vv**2*(control[3]-control[2])
    tangent = unit(tangent)
    across = np.stack([tangent[..., 1], -tangent[..., 0]], axis=-1)
    width = 2.0 + spec['width'] * np.sin(np.pi * v) ** .74 * (.62 + .38*v)
    bend = spec.get('asymmetry', 0) * np.sin(np.pi*v) * u*u
    xy = center + across * ((u * width + bend)[..., None])
    curl = spec.get('curl', .24) * (u*u) * np.sin(np.pi*v)
    ripple = .022 * np.sin(u * np.pi * 3 + v * 6) * np.sin(np.pi*v) * np.abs(u)**3
    z = (spec['z'] + spec['tipDepth']*v + spec['cup']*np.sin(np.pi*v) + curl +
         spec.get('twist', .1)*u*v + .052*(1-u*u)*np.sin(np.pi*v) + ripple)
    world = np.stack([(xy[...,0]-368)/SCALE, (465-xy[...,1])/SCALE, z], axis=-1)
    return xy, world


def extend_petal_colours(photo):
    """Extend only colour, without creating foreground geometry from black pixels."""
    rgb = np.asarray(photo.convert('RGB'), dtype=np.float64)
    valid = (rgb.max(axis=-1) > 22).astype(np.uint8) * 255
    mask = Image.fromarray(valid, 'L')
    draw = ImageDraw.Draw(mask)
    # The photographed anthers occlude petals. Suppress those small regions in
    # the petal texture; the actual 3D anthers are separate geometry below.
    for box in [(399,285,427,366), (449,276,487,365), (496,313,536,391),
                (146,141,170,223), (171,118,203,217), (202,92,224,189), (221,84,249,170)]:
        draw.ellipse(box, fill=0)
    keep = np.asarray(mask) > 0
    result = rgb.copy()
    unresolved = ~keep
    numerator = Image.fromarray(np.uint8(rgb * keep[...,None]), 'RGB')
    for radius in [4, 12, 28, 60, 120, 220]:
        weight = np.asarray(mask.filter(ImageFilter.GaussianBlur(radius)), dtype=float)/255
        blurred = np.asarray(numerator.filter(ImageFilter.GaussianBlur(radius)), dtype=float)
        fill = unresolved & (weight > .014)
        result[fill] = np.clip(blurred[fill] / weight[fill,None], 0, 255)
        unresolved[fill] = False
    result[unresolved] = [150, 145, 195]
    return np.uint8(np.clip(result, 0, 255))


def bilinear(image, xy):
    x = np.clip(xy[...,0], 0, image.shape[1]-1.001)
    y = np.clip(xy[...,1], 0, image.shape[0]-1.001)
    xi, yi = x.astype(int), y.astype(int)
    fx, fy = (x-xi)[...,None], (y-yi)[...,None]
    return ((1-fy)*((1-fx)*image[yi,xi]+fx*image[yi,xi+1]) +
            fy*((1-fx)*image[yi+1,xi]+fx*image[yi+1,xi+1]))


def make_petal(spec, index, atlas, extended):
    u, v = np.meshgrid(np.linspace(-1,1,NU+1), np.linspace(0,1,NV+1))
    _, surface = petal_coordinates(spec,u,v)
    dv, du = np.gradient(surface, axis=(0,1))
    normal = unit(np.cross(du,dv))
    if normal[...,2].mean() < 0: normal *= -1
    thickness = spec.get('thickness', .024)
    upper, lower = surface + normal*thickness/2, surface-normal*thickness/2
    positions = [*upper.reshape(-1,3), *lower.reshape(-1,3)]
    normals = [*normal.reshape(-1,3), *(-normal).reshape(-1,3)]
    uv = []
    for side in range(2):
        patch = index*2+side
        col, row = patch % COLS, patch // COLS
        uv.extend(np.stack([(col*PATCH+2+(u+1)/2*(PATCH-4))/(COLS*PATCH),
                            (row*PATCH+2+v*(PATCH-4))/(ROWS*PATCH)],axis=-1).reshape(-1,2))
        pu,pv = np.meshgrid(np.linspace(-1,1,PATCH),np.linspace(0,1,PATCH))
        projected,_ = petal_coordinates(spec,pu,pv)
        colours = bilinear(extended,projected)
        if side: colours = colours*.90 + np.array([7,5,12])  # inferred rear continuation
        patch_img = Image.fromarray(np.uint8(np.clip(colours,0,255)), 'RGB')
        atlas.paste(patch_img,(col*PATCH,row*PATCH))
    faces = []
    offset = (NU+1)*(NV+1)
    for iy in range(NV):
        for ix in range(NU):
            a = iy*(NU+1)+ix; b=a+1; c=a+NU+1; d=c+1
            faces.extend([[a,b,d],[a,d,c],[offset+a,offset+d,offset+b],[offset+a,offset+c,offset+d]])
    boundary = [j for j in range(NU+1)]
    boundary += [i*(NU+1)+NU for i in range(1,NV+1)]
    boundary += [NV*(NU+1)+j for j in range(NU-1,-1,-1)]
    boundary += [i*(NU+1) for i in range(NV-1,0,-1)]
    flat_upper,flat_lower=upper.reshape(-1,3),lower.reshape(-1,3)
    top_uv=np.asarray(uv[:offset])
    for i,a in enumerate(boundary):
        b=boundary[(i+1)%len(boundary)]
        side_normal=unit(np.cross(flat_lower[a]-flat_upper[a],flat_lower[b]-flat_upper[a]))
        base=len(positions)
        positions.extend([flat_upper[a],flat_lower[a],flat_lower[b],flat_upper[b]])
        normals.extend([side_normal]*4)
        # Seam vertices keep the thin edge on its own front-colour patch.
        uv.extend([top_uv[a],top_uv[a],top_uv[b],top_uv[b]])
        faces.extend([[base,base+1,base+2],[base,base+2,base+3]])
    return dict(name=spec['name'], positions=np.array(positions), normals=np.array(normals),
                uv=np.array(uv), indices=np.array(faces), material=0, category='closed-petal',
                source_curve=spec['curve'], inferred_depth=True, thickness=thickness)


def tube(name, control, radius, colour, category='stem', rings=64, sides=12):
    centers=bezier(control,np.linspace(0,1,rings+1))
    tangents=unit(np.gradient(centers,axis=0))
    positions=[]; normals=[]; colors=[]; faces=[]
    for i,(center,tangent) in enumerate(zip(centers,tangents)):
        reference=np.array([0,0,1]) if abs(tangent[2])<.9 else np.array([0,1,0])
        n=unit(np.cross(reference,tangent)); b=np.cross(tangent,n)
        for j in range(sides):
            angle=j/sides*math.tau; norm=n*math.cos(angle)+b*math.sin(angle)
            r=radius*(.83+.17*math.sin(math.pi*i/rings))
            positions.append(center+norm*r);normals.append(norm)
            tint=np.asarray(colour)*(0.83+0.17*math.cos(angle-.4))
            colors.append(linear(tint))
    for i in range(rings):
        for j in range(sides):
            a=i*sides+j;b=i*sides+(j+1)%sides;c=(i+1)*sides+j;d=(i+1)*sides+(j+1)%sides
            faces.extend([[a,b,d],[a,d,c]])
    for end in (0,rings):
        cap=len(positions);positions.append(centers[end]);normals.append(tangents[end]*(1 if end else -1));colors.append(linear(colour))
        for j in range(sides):
            a=end*sides+j;b=end*sides+(j+1)%sides
            faces.append([cap,a,b] if end else [cap,b,a])
    return dict(name=name,positions=np.array(positions),normals=np.array(normals),colors=np.array(colors),
                indices=np.array(faces),material=1,category=category)


def ellipsoid(name,center,axis,length,radius,colour,category='anther',latitudes=10,sides=16):
    center=np.asarray(center); axis=unit(axis)
    reference=np.array([0,0,1]) if abs(axis[2])<.9 else np.array([0,1,0])
    n=unit(np.cross(reference,axis));b=np.cross(axis,n)
    positions=[center+axis*length/2];normals=[axis];colors=[linear(colour)];faces=[]
    for i in range(1,latitudes):
        phi=i/latitudes*math.pi
        for j in range(sides):
            theta=j/sides*math.tau
            p=axis*math.cos(phi)*length/2 + n*math.sin(phi)*math.cos(theta)*radius + b*math.sin(phi)*math.sin(theta)*radius*.82
            norm=unit(axis*math.cos(phi)/(length/2)+n*math.sin(phi)*math.cos(theta)/radius+b*math.sin(phi)*math.sin(theta)/(radius*.82))
            positions.append(center+p);normals.append(norm)
            noise=.84+.16*math.sin(i*17.3+j*11.7)**2
            colors.append(linear(np.asarray(colour)*noise))
    south=len(positions);positions.append(center-axis*length/2);normals.append(-axis);colors.append(linear(colour))
    for j in range(sides):
        faces.append([0,1+j,1+(j+1)%sides])
    for i in range(latitudes-2):
        for j in range(sides):
            a=1+i*sides+j;b0=1+i*sides+(j+1)%sides;c=a+sides;d=b0+sides
            faces.extend([[a,d,b0],[a,c,d]])
    last=1+(latitudes-2)*sides
    for j in range(sides):faces.append([south,last+(j+1)%sides,last+j])
    return dict(name=name,positions=np.array(positions),normals=np.array(normals),colors=np.array(colors),
                indices=np.array(faces),material=1,category=category)


def make_leaf(name,control,width,z,tilt):
    spec=dict(name=name,curve=control,width=width,z=z,tipDepth=tilt,cup=.16,curl=.05,twist=.08,thickness=.018)
    u,v=np.meshgrid(np.linspace(-1,1,17),np.linspace(0,1,33))
    _,surface=petal_coordinates(spec,u,v)
    dv,du=np.gradient(surface,axis=(0,1));norm=unit(np.cross(du,dv))
    if norm[...,2].mean()<0:norm*=-1
    count=surface.shape[0]*surface.shape[1]
    positions=np.concatenate([(surface+norm*.009).reshape(-1,3),(surface-norm*.009).reshape(-1,3)])
    normals=np.concatenate([norm.reshape(-1,3),-norm.reshape(-1,3)])
    rgb=np.stack([26+22*(1-u*u),52+38*(1-u*u),30+22*(1-u*u)],axis=-1)
    vein=np.exp(-(u/.055)**2)[...,None]*np.array([22,26,13])
    top=linear(rgb+vein).reshape(-1,3);colors=np.concatenate([top,top*.88])
    faces=[]
    for iy in range(32):
        for ix in range(16):
            a=iy*17+ix;b=a+1;c=a+17;d=c+1
            faces.extend([[a,b,d],[a,d,c],[count+a,count+d,count+b],[count+a,count+c,count+d]])
    boundary=list(range(17))+[i*17+16 for i in range(1,33)]+[32*17+j for j in range(15,-1,-1)]+[i*17 for i in range(31,0,-1)]
    for i,a in enumerate(boundary):
        b=boundary[(i+1)%len(boundary)];faces.extend([[a,count+a,count+b],[a,count+b,b]])
    return dict(name=name,positions=positions,normals=normals,colors=colors,indices=np.array(faces),material=1,category='closed-leaf',thickness=.018)


def petal_specs():
    # Curves and widths follow visible photo regions; Z, curl and rear topology
    # cannot be recovered from this single view and are artistic assumptions.
    front=[
        ('upper-left',[(376,458),(345,385),(316,293),(321,222)],68,.40,.51,.30,-.11),
        ('upper-right',[(389,453),(465,402),(518,306),(535,240)],63,.54,.28,.30,.13),
        ('right',[(388,464),(485,440),(579,409),(674,426)],83,.20,.36,.25,-.18),
        ('lower-right',[(385,478),(450,522),(502,595),(507,663)],62,.29,.48,.34,.15),
        ('lower-left',[(370,476),(348,514),(316,541),(286,520)],43,.58,.25,.32,-.12),
        ('left',[(369,450),(293,407),(255,345),(223,290)],61,.36,.40,.35,.16),
    ]
    rear=[
        ('top',[(235,253),(260,171),(341,82),(394,65)],46,.20,.40,.25,.10),
        ('upper-right',[(239,255),(280,190),(335,99),(416,124)],47,-.09,.40,.25,-.15),
        ('right',[(241,266),(305,264),(369,285),(382,335)],56,.21,.29,.29,.14),
        ('lower-right',[(239,269),(270,314),(278,375),(247,411)],52,.36,.36,.31,-.11),
        ('lower-left',[(221,265),(177,295),(108,355),(76,421)],48,.22,.30,.33,.13),
        ('left',[(223,253),(182,251),(137,257),(106,245)],47,.47,.23,.28,-.16),
    ]
    specs=[]
    for flower,values,z in [('front',front,.32),('rear',rear,-.46)]:
        for name,curve,width,tip,cup,curl,twist in values:
            specs.append(dict(name=f'lily-{flower}-petal-{name}',curve=curve,width=width,z=z,
                              tipDepth=tip,cup=cup,curl=curl,twist=twist))
    return specs


def flower_organs(name,center,tips,z):
    meshes=[];root=point(*center,z)
    for i,(x,y,front) in enumerate(tips):
        tip=point(x,y,z+front)
        axis=unit(np.array([(.12 if i%2 else -.12),1,.14+front*.13]))
        endpoint=tip-axis*.08
        curve=[root,root+np.array([(.04 if i%2 else -.05),.22,.14]),
               endpoint+np.array([-.035,-.22,-.08]),endpoint]
        meshes.append(tube(f'lily-{name}-filament-{i+1}',curve,.012,[132,151,93] if name=='front' else [173,164,127],category='filament',rings=26,sides=8))
        meshes.append(ellipsoid(f'lily-{name}-anther-{i+1}',tip,axis,.25 if i<3 else .20,.039,
                                [124,75,32] if name=='front' else [142,89,35]))
    pistil=point(center[0]+(-53 if name=='rear' else 59),center[1]-(142 if name=='rear' else 111),z+.66)
    meshes.append(tube(f'lily-{name}-style',[root,root+[.03,.22,.10],pistil+[.025,-.19,-.04],pistil],.017,[176,178,122],category='pistil',rings=30,sides=10))
    meshes.append(ellipsoid(f'lily-{name}-stigma',pistil,[0,1,.2],.063,.033,[176,165,87],category='stigma',latitudes=8,sides=12))
    return meshes


def orient_and_recalculate_normals(meshes):
    """Image Y points down; repair winding after converting to world Y-up."""
    for mesh in meshes:
        p=mesh['positions'];tri=mesh['indices']
        volume=np.sum(np.einsum('ij,ij->i',p[tri[:,0]],np.cross(p[tri[:,1]],p[tri[:,2]])))/6
        if volume<0:
            tri=tri[:,[0,2,1]].copy()
            mesh['indices']=tri
        cross=np.cross(p[tri[:,1]]-p[tri[:,0]],p[tri[:,2]]-p[tri[:,0]])
        normal=np.zeros_like(p)
        np.add.at(normal,tri.reshape(-1),np.repeat(cross,3,axis=0))
        normal=unit(normal)
        # A few very sharp curled-tip triangles need a normal seam instead of
        # averaging normals across the crease. Geometry and UV remain identical.
        agreement=np.einsum('ij,ij->i',cross,normal[tri].mean(axis=1))
        sharp=np.nonzero(agreement < -1e-12)[0]
        for triangle_index in sharp:
            face=tri[triangle_index].copy();base=len(p)
            p=np.concatenate([p,p[face]])
            normal=np.concatenate([normal,np.repeat(unit(cross[triangle_index])[None,:],3,axis=0)])
            for attribute in ('uv','colors'):
                if attribute in mesh:mesh[attribute]=np.concatenate([mesh[attribute],mesh[attribute][face]])
            tri[triangle_index]=[base,base+1,base+2]
        mesh['positions']=p;mesh['normals']=normal


def validate(meshes):
    reports=[]
    for mesh in meshes:
        p=mesh['positions'];tri=mesh['indices'];uv=mesh.get('uv')
        assert np.isfinite(p).all() and np.isfinite(mesh['normals']).all()
        assert tri.min()>=0 and tri.max()<len(p)
        a,b,c=p[tri[:,0]],p[tri[:,1]],p[tri[:,2]]
        areas=np.linalg.norm(np.cross(b-a,c-a),axis=1)/2
        assert areas.min()>1e-12,(mesh['name'],areas.min())
        signed_volume=float(np.sum(np.einsum('ij,ij->i',a,np.cross(b,c)))/6)
        assert signed_volume>0,(mesh['name'],signed_volume)
        normal_agreement=np.einsum('ij,ij->i',np.cross(b-a,c-a),mesh['normals'][tri].mean(axis=1))
        assert normal_agreement.min()>=-1e-10,(mesh['name'],'inconsistent smoothed normals')
        if uv is not None:assert np.isfinite(uv).all() and uv.min()>=0 and uv.max()<=1
        # Weld the deliberately duplicated normal/UV seam vertices before checking
        # closure. Each welded edge must be shared by exactly two triangles.
        rounded=np.round(p,7)
        _,inverse=np.unique(rounded,axis=0,return_inverse=True)
        edges=Counter()
        for face in inverse[tri]:
            for i,j in ((face[0],face[1]),(face[1],face[2]),(face[2],face[0])):edges[tuple(sorted((int(i),int(j))))]+=1
        nonmanifold=sum(value!=2 for value in edges.values())
        assert nonmanifold==0,(mesh['name'],nonmanifold)
        reports.append(dict(name=mesh['name'],category=mesh['category'],vertices=len(p),triangles=len(tri),
                            bounds={'min':p.min(axis=0).tolist(),'max':p.max(axis=0).tolist()},
                            minTriangleArea=float(areas.min()),closedAfterSeamWelding=True,
                            signedVolume=signed_volume,outwardWinding=True,
                            uv=uv is not None,thinThickness=mesh.get('thickness')))
    return reports


def write_glb(meshes,atlas,path):
    png=io.BytesIO();atlas.save(png,format='PNG',optimize=True)
    binary=bytearray();views=[];accessors=[]
    def add_view(data,target=None):
        while len(binary)%4:binary.append(0)
        start=len(binary);binary.extend(data)
        view=dict(buffer=0,byteOffset=start,byteLength=len(data))
        if target:view['target']=target
        views.append(view);return len(views)-1
    def accessor(array,kind,position=False):
        is_index=kind=='SCALAR';array=np.asarray(array,dtype='<u2' if is_index else '<f4')
        view=add_view(array.tobytes(),34963 if is_index else 34962)
        item=dict(bufferView=view,componentType=5123 if is_index else 5126,count=array.size if is_index else len(array),type=kind)
        if position:item.update(min=array.min(axis=0).tolist(),max=array.max(axis=0).tolist())
        accessors.append(item);return len(accessors)-1
    gltf_meshes=[];nodes=[]
    for mesh in meshes:
        attributes=dict(POSITION=accessor(mesh['positions'],'VEC3',True),NORMAL=accessor(mesh['normals'],'VEC3'))
        if 'uv'in mesh:attributes['TEXCOORD_0']=accessor(mesh['uv'],'VEC2')
        if 'colors'in mesh:attributes['COLOR_0']=accessor(mesh['colors'],'VEC3')
        indices=accessor(mesh['indices'].reshape(-1),'SCALAR')
        gltf_meshes.append(dict(name=mesh['name'],primitives=[dict(attributes=attributes,indices=indices,material=mesh['material'],mode=4)]))
        nodes.append(dict(name=mesh['name'],mesh=len(nodes)))
    image_view=add_view(png.getvalue())
    document=dict(asset={'version':'2.0','generator':'Local Pillow/NumPy lily artistic approximation'},
                  scene=0,scenes=[{'name':'Double lily – photo-coloured artistic approximation','nodes':list(range(len(nodes)))}],nodes=nodes,meshes=gltf_meshes,
                  materials=[{'name':'Photo projected petal RGB / inferred backs','pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1],'baseColorTexture':{'index':0},'metallicFactor':0,'roughnessFactor':.88}},
                             {'name':'Linear RGB plant organs','pbrMetallicRoughness':{'baseColorFactor':[1,1,1,1],'metallicFactor':0,'roughnessFactor':.95}}],
                  textures=[{'source':0,'sampler':0}],images=[{'name':'Lily per-petal atlas','bufferView':image_view,'mimeType':'image/png'}],
                  samplers=[{'magFilter':9729,'minFilter':9729,'wrapS':33071,'wrapT':33071}],
                  accessors=accessors,bufferViews=views,buffers=[{'byteLength':len(binary)}])
    js=json.dumps(document,separators=(',',':'),ensure_ascii=True).encode();js+=b' '*((-len(js))%4)
    binary+=b'\x00'*((-len(binary))%4)
    total=12+8+len(js)+8+len(binary)
    path.write_bytes(struct.pack('<III',0x46546c67,2,total)+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(binary),0x004e4942)+binary)
    return document,len(png.getvalue())


def diagnostic_preview(meshes,atlas,path,yaw):
    all_positions=np.concatenate([m['positions'] for m in meshes]);center=(all_positions.min(0)+all_positions.max(0))/2
    angle=math.radians(yaw);rot=np.array([[math.cos(angle),0,math.sin(angle)],[0,1,0],[-math.sin(angle),0,math.cos(angle)]])
    points=(all_positions-center)@rot.T;extent=max(np.ptp(points[:,0])*720/1280,np.ptp(points[:,1]))
    scale=620/max(extent,1e-9)
    polygons=[];texture=np.asarray(atlas)
    for mesh in meshes:
        p=(mesh['positions']-center)@rot.T
        tri=mesh['indices'];xy=p[:,:2]*scale;xy[:,0]+=640;xy[:,1]=360-xy[:,1]
        means=p[tri].mean(axis=1);normal=unit(mesh['normals'][tri].mean(axis=1))@rot.T
        if 'uv'in mesh:
            uv=mesh['uv'][tri].mean(1);xs=np.clip((uv[:,0]*atlas.width).astype(int),0,atlas.width-1);ys=np.clip((uv[:,1]*atlas.height).astype(int),0,atlas.height-1);col=texture[ys,xs].astype(float)
        else:
            rgb=mesh['colors'][tri].mean(1);col=np.where(rgb<=.0031308,rgb*12.92,1.055*np.power(rgb,1/2.4)-.055)*255
        light=.48+.52*np.clip(normal@unit(np.array([-.25,.55,1])),0,1)
        colours=np.uint8(np.clip(col*light[:,None],0,255))
        visible=normal[:,2]>-.10
        for i in np.nonzero(visible)[0]:polygons.append((means[i,2],xy[tri[i]].tolist(),tuple(colours[i])))
    result=Image.new('RGB',(1280,720),(5,6,10));draw=ImageDraw.Draw(result)
    for _,polygon,colour in sorted(polygons,key=lambda item:item[0]):draw.polygon([tuple(p) for p in polygon],fill=colour)
    result.save(path)


def main():
    original=Path('C:/Users/17993/Desktop/6e150adb7b1ac6b34b4715def9a8f0fd.jpg')
    default_source=original if original.exists() else PROJECT/'public/examples/lily-reference.jpg'
    parser=argparse.ArgumentParser();parser.add_argument('--source',type=Path,default=default_source);parser.add_argument('--output',type=Path,default=PROJECT/'public/examples')
    args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    with Image.open(args.source) as source:photo=source.convert('RGB')
    if photo.size!=(736,736):raise ValueError('The hand-authored photographic contours expect the original 736 × 736 source.')
    if args.source.resolve()!=(args.output/'lily-reference.jpg').resolve():
        shutil.copyfile(args.source,args.output/'lily-reference.jpg')
    extended=extend_petal_colours(photo)
    atlas=Image.new('RGB',(COLS*PATCH,ROWS*PATCH),(150,145,190));meshes=[]
    for i,spec in enumerate(petal_specs()):meshes.append(make_petal(spec,i,atlas,extended))
    meshes+=flower_organs('front',(380,461),[(412,324,.90),(466,318,1.0),(512,351,.85),(413,390,.42),(444,400,.34),(474,391,.40)],.34)
    meshes+=flower_organs('rear',(235,260),[(161,181,.75),(187,158,.88),(217,132,.84),(237,127,.64),(199,209,.35),(250,211,.32)],-.43)
    meshes.append(tube('lily-main-curved-stem',[point(349,733,-.63),point(345,649,-.57),point(350,552,-.28),point(381,471,.23)],.027,[34,65,32],rings=84,sides=14))
    meshes.append(tube('lily-rear-branch-stem',[point(353,629,-.53),point(326,501,-.71),point(252,384,-.78),point(235,272,-.52)],.024,[33,59,29],rings=88,sides=14))
    meshes.append(make_leaf('lily-leaf-left',[(351,613),(315,605),(294,551),(283,515)],29,-.46,.21))
    meshes.append(make_leaf('lily-leaf-right',[(347,672),(385,635),(423,569),(396,537)],22,-.72,.22))
    orient_and_recalculate_normals(meshes)
    reports=validate(meshes)
    document,png_size=write_glb(meshes,atlas,args.output/'lily-model.glb')
    atlas.save(args.output/'lily-texture-atlas.png',optimize=True)
    all_positions=np.concatenate([mesh['positions'] for mesh in meshes]);minimum=all_positions.min(0);maximum=all_positions.max(0)
    categories=Counter(mesh['category'] for mesh in meshes)
    metadata=dict(name='照片配色双朵百合 · 立体近似',version=2,method='hand-authored curved parametric petals, photo-projected UV atlas and closed organ meshes',
                  source={'name':args.source.name,'copiedAs':'lily-reference.jpg','width':736,'height':736,'sha256':hashlib.sha256(args.source.read_bytes()).hexdigest(),'intactCopy':True},
                  meshCount=len(meshes),categories=dict(categories),triangles=sum(r['triangles']for r in reports),vertices=sum(r['vertices']for r in reports),
                  bounds={'min':minimum.tolist(),'max':maximum.tolist(),'size':(maximum-minimum).tolist(),'depthToWidth':float((maximum[2]-minimum[2])/(maximum[0]-minimum[0]))},
                  textures={'embeddedPNG':True,'atlasSize':[atlas.width,atlas.height],'bytes':png_size,'baseColorFactor':[1,1,1,1],'alphaUsed':False},
                  validation={'allTrianglesNondegenerate':True,'allValuesFinite':True,'allMeshesClosedAfterSeamWelding':True,'allMeshSignedVolumesPositive':True,'allUVsInRange':True,'externalResources':False,'compression':False},
                  assumptions=['这不是单图精确三维重建：Z 深度、弯曲、薄厚度和被遮挡结构均为人工近似。','两朵花各六片独立闭合花瓣；可见布局按照片定位，其余形状依据百合外观推定。','正面每片花瓣用其原图区域投色，黑背景不生成几何；贴图边缘及花蕊遮挡处以附近花瓣颜色延续。','背面使用同瓣颜色延续并轻微降低亮度，未声称是不可见背面的真实颜色。','花药、花丝、柱头、茎叶有真实三维网格；未见细节和部分内部花蕊配色为推定。','照片中的蓝紫及橙色照明已包含在基础色贴图中，并非重建真实材质或灯光。'],meshes=reports)
    (args.output/'lily-model-metadata.json').write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding='utf-8')
    for label,yaw in [('front',0),('three-quarter',45),('side',90),('back',180)]:diagnostic_preview(meshes,atlas,args.output/f'lily-preview-{label}.png',yaw)
    print(json.dumps({key:metadata[key]for key in ['meshCount','categories','triangles','vertices','bounds','validation']},ensure_ascii=False))


if __name__=='__main__':main()
