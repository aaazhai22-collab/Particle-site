"""Read-only verification of the exported GLB bytes and their embedded photo atlas."""
from pathlib import Path
from collections import Counter
import hashlib
import io
import json
import struct
import numpy as np
from PIL import Image

root=Path(__file__).resolve().parents[1]/'public/examples'
data=(root/'lily-model.glb').read_bytes()
magic,version,total=struct.unpack_from('<III',data,0)
size,kind=struct.unpack_from('<II',data,12)
assert magic==0x46546c67 and version==2 and total==len(data) and kind==0x4e4f534a
document=json.loads(data[20:20+size])
binary_size,binary_kind=struct.unpack_from('<II',data,20+size)
binary=data[28+size:28+size+binary_size]
assert binary_kind==0x004e4942
assert len(document['nodes'])==len(document['meshes'])==44
assert all('uri' not in item for item in document['buffers']+document['images'])
assert not document.get('extensionsRequired') and not document.get('animations')
assert all(material['pbrMetallicRoughness']['baseColorFactor']==[1,1,1,1] for material in document['materials'])

def array(index):
    accessor=document['accessors'][index]
    view=document['bufferViews'][accessor['bufferView']]
    width={'SCALAR':1,'VEC2':2,'VEC3':3}[accessor['type']]
    dtype={5126:'<f4',5123:'<u2',5125:'<u4'}[accessor['componentType']]
    offset=view.get('byteOffset',0)+accessor.get('byteOffset',0)
    return np.frombuffer(binary,dtype=dtype,count=accessor['count']*width,offset=offset).reshape(accessor['count'],width)

positions=[];triangle_count=0;minimum_area=float('inf');minimum_volume=float('inf');normal_error=0;opposed_normals=0
for mesh_index,mesh in enumerate(document['meshes']):
    primitive=mesh['primitives'][0];attributes=primitive['attributes']
    xyz=array(attributes['POSITION']);normals=array(attributes['NORMAL']);triangles=array(primitive['indices']).reshape(-1,3)
    assert np.isfinite(xyz).all() and np.isfinite(normals).all()
    assert triangles.max()<len(xyz)
    a,b,c=xyz[triangles[:,0]],xyz[triangles[:,1]],xyz[triangles[:,2]]
    cross=np.cross(b-a,c-a)
    areas=np.linalg.norm(cross,axis=1)*.5
    assert areas.min()>1e-12,(mesh['name'],'degenerate triangle')
    volume=float(np.sum(np.einsum('ij,ij->i',a,np.cross(b,c)))/6)
    assert volume>0,(mesh['name'],'inward shell')
    minimum_area=min(minimum_area,float(areas.min()));minimum_volume=min(minimum_volume,volume)
    normal_error=max(normal_error,float(np.abs(np.linalg.norm(normals,axis=1)-1).max()))
    opposed_normals+=int((np.einsum('ij,ij->i',cross,normals[triangles].mean(axis=1)) < -1e-9).sum())
    _,welded=np.unique(np.round(xyz,6),axis=0,return_inverse=True)
    counts=Counter();orientations=Counter()
    for face in welded[triangles]:
        for left,right in ((face[0],face[1]),(face[1],face[2]),(face[2],face[0])):
            edge=tuple(sorted((int(left),int(right))));counts[edge]+=1;orientations[edge]+=1 if left<right else -1
    assert all(value==2 for value in counts.values()),(mesh['name'],'open/nonmanifold edge')
    assert all(value==0 for value in orientations.values()),(mesh['name'],'inconsistent neighbouring face winding')
    if 'TEXCOORD_0' in attributes:
        uv=array(attributes['TEXCOORD_0']);assert np.isfinite(uv).all() and uv.min()>=0 and uv.max()<=1
        front_count=33*49
        front,back=uv[:front_count],uv[front_count:front_count*2]
        assert abs(float(back[:,0].mean()-front[:,0].mean())-.25)<1e-6
        assert abs(float(back[:,1].mean()-front[:,1].mean()))<1e-6
        assert normals[:front_count,2].mean()>0 and normals[front_count:front_count*2,2].mean()<0
    if 'COLOR_0' in attributes:
        colours=array(attributes['COLOR_0']);assert np.isfinite(colours).all() and colours.min()>=0 and colours.max()<=1
    positions.append(xyz);triangle_count+=len(triangles)

view=document['bufferViews'][document['images'][0]['bufferView']]
embedded=binary[view.get('byteOffset',0):view.get('byteOffset',0)+view['byteLength']]
texture=Image.open(io.BytesIO(embedded));texture.load()
assert texture.mode=='RGB' and texture.size==(1024,1536)
assert embedded==(root/'lily-texture-atlas.png').read_bytes()
metadata=json.loads((root/'lily-model-metadata.json').read_text(encoding='utf-8'))
assert hashlib.sha256((root/'lily-reference.jpg').read_bytes()).hexdigest()==metadata['source']['sha256']
assert metadata['meshCount']==len(document['meshes']) and metadata['triangles']==triangle_count
extent=np.ptp(np.concatenate(positions),axis=0)
assert extent[2]/extent[0]>.2
assert normal_error<1e-5
assert opposed_normals==0
print(json.dumps(dict(containerBytes=len(data),meshCount=len(document['meshes']),triangles=triangle_count,
                     minTriangleArea=minimum_area,minPositiveSignedVolume=minimum_volume,
                     maxNormalLengthError=normal_error,trianglesOpposingAveragedNormals=opposed_normals,
                     allShellsClosedAndOutward=True,frontBackUVAttached=True,textureSize=texture.size,
                     embeddedPNGMatchesAtlas=True,sourceHashMatches=True,depthToWidth=float(extent[2]/extent[0]),
                     noExternalResources=True,noCompression=True),ensure_ascii=False))
