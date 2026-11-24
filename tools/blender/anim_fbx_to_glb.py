# Export the skeleton + animation of an FBX (meshes dropped) as a GLB clip,
# for retargeting at runtime.
# blender -b -P tools/blender/anim_fbx_to_glb.py -- <in.fbx> <out.glb> <clip name>
import sys

import bpy

src, out, name = sys.argv[sys.argv.index("--") + 1:][:3]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src, automatic_bone_orientation=False, ignore_leaf_bones=True)
for o in list(bpy.data.objects):
    if o.type != "ARMATURE":
        bpy.data.objects.remove(o, do_unlink=True)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
arm.animation_data.action.name = name
scene = bpy.context.scene
start, end = (int(f) for f in arm.animation_data.action.frame_range)
scene.frame_start, scene.frame_end = start, end
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_animations=True,
                          export_animation_mode="ACTIONS", export_force_sampling=True, export_frame_step=4)
print("exported", out, start, end, "fps", scene.render.fps)
