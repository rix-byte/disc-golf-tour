# Print rest-pose directions of a few arm bones, and whether they are animated.
# blender -b -P tools/blender/rest_dirs.py -- <a.fbx> [...]
import sys

import bpy

for path in sys.argv[sys.argv.index("--") + 1:]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False, ignore_leaf_bones=True)
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    act = arm.animation_data.action
    animated = {fc.data_path.split('"')[1] for fc in act.fcurves if fc.data_path.startswith("pose.bones")}
    print("##", path.split("\\")[-1], "curves", len(act.fcurves))
    for name in ("mixamorig:LeftArm", "mixamorig:RightArm", "mixamorig:RightForeArm", "mixamorig:Hips"):
        b = arm.data.bones.get(name)
        if b:
            d = (b.tail_local - b.head_local).normalized()
            print(f"  {name:24s} rest dir=({d.x:+.2f},{d.y:+.2f},{d.z:+.2f}) animated={name in animated}")
