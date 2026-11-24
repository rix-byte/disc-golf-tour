# Print armature bones, actions and frame ranges of FBX files.
# blender -b -P tools/blender/inspect_fbx.py -- <a.fbx> [<b.fbx> ...]
import sys

import bpy

for path in sys.argv[sys.argv.index("--") + 1:]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False, ignore_leaf_bones=True)
    for o in bpy.data.objects:
        if o.type == "ARMATURE":
            act = o.animation_data.action if o.animation_data else None
            names = [b.name for b in o.data.bones]
            print(f"## {path}\n  armature={o.name} scale={tuple(round(s, 3) for s in o.scale)} bones={len(names)}")
            print("  first bones:", names[:8])
            print("  action:", act.name if act else None, tuple(act.frame_range) if act else None,
                  "fps", bpy.context.scene.render.fps)
        elif o.type == "MESH":
            print("  mesh:", o.name, len(o.data.vertices))
