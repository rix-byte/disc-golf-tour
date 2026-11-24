# Colour an untextured image-to-3D mesh from its source picture by projecting
# the picture onto it from the front (and a detail-free copy from behind).
# Scales to a 1.8 m person standing on z=0, facing -Y (Blender front).
#
# blender -b -P tools/blender/colour_golfer.py -- <in.glb> <atlas.png> <bbox.txt> <out_dir> [height_m]
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
src, atlas_path, bbox_path, out_dir = argv[:4]
height = float(argv[4]) if len(argv) > 4 else 1.8
out = Path(out_dir)
out.mkdir(parents=True, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
obj = meshes[0]
bpy.context.view_layer.objects.active = obj
for o in bpy.context.scene.objects:
    o.select_set(o is obj)
bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Normalise: feet on z=0, centred, 1.8 m tall.
me = obj.data
xs = [v.co.x for v in me.vertices]
ys = [v.co.y for v in me.vertices]
zs = [v.co.z for v in me.vertices]
s = height / (max(zs) - min(zs))
cx, cy, z0 = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs)
for v in me.vertices:
    v.co = Vector(((v.co.x - cx) * s, (v.co.y - cy) * s, (v.co.z - z0) * s))

bm = bmesh.new()
bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bm.to_mesh(me)
bm.free()

# Projection: mesh x/z bounds <-> the figure's bounding box in the picture.
px0, px1, py0, py1 = (float(t) for t in Path(bbox_path).read_text().split())
xs = [v.co.x for v in me.vertices]
zs = [v.co.z for v in me.vertices]
mx0, mx1, mz0, mz1 = min(xs), max(xs), min(zs), max(zs)
IMG = 1024.0


def pixel(co):
    u = px0 + (co.x - mx0) / (mx1 - mx0) * (px1 - px0)
    v = py1 - (co.z - mz0) / (mz1 - mz0) * (py1 - py0)  # image y grows downward
    return u, v


uv = me.uv_layers.new(name="UVMap")
for poly in me.polygons:
    # Front-facing (towards -Y) samples the picture; back-facing the smoothed copy.
    back = poly.normal.y > 0.05
    for li in poly.loop_indices:
        co = me.vertices[me.loops[li].vertex_index].co
        u, v = pixel(co)
        u = min(max(u, 0.5), IMG - 0.5)
        v = min(max(v, 0.5), IMG - 0.5)
        uv.data[li].uv = (((u + (IMG if back else 0.0)) / (2 * IMG)), 1.0 - v / IMG)

for p in me.polygons:
    p.use_smooth = True

mat = bpy.data.materials.new("Golfer")
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
bsdf.inputs["Roughness"].default_value = 0.75
tex = nt.nodes.new("ShaderNodeTexImage")
tex.image = bpy.data.images.load(atlas_path)
tex.image.pack()
tex.interpolation = "Linear"
nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
me.materials.clear()
me.materials.append(mat)
obj.name = "Golfer"

bpy.ops.export_scene.gltf(filepath=str(out / "golfer_static.glb"), export_format="GLB", use_selection=False)
bpy.ops.export_scene.fbx(filepath=str(out / "golfer_for_mixamo.fbx"), path_mode="COPY", embed_textures=True,
                         apply_scale_options="FBX_SCALE_ALL", axis_forward="-Z", axis_up="Y")
print("triangles", sum(len(p.vertices) - 2 for p in me.polygons), "height", round(mz1 - mz0, 3))
