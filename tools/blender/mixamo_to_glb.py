# Combine Mixamo downloads of one character ("With Skin") into a single GLB
# with every animation as its own clip. The first file supplies the mesh and
# skeleton; later files only contribute their animation.
#
# blender -b -P tools/blender/mixamo_to_glb.py -- <out.glb> <name>=<file.fbx> [<name>=<file.fbx> ...]
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
out_path, pairs = argv[0], [a.split("=", 1) for a in argv[1:]]

bpy.ops.wm.read_factory_settings(use_empty=True)
main_arm = None
for i, (name, path) in enumerate(pairs):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=False, ignore_leaf_bones=True)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == "ARMATURE")
    action = arm.animation_data.action if arm.animation_data else None
    if action:
        action.name = name
        action.use_fake_user = True
    meshes = [o for o in new if o.type == "MESH"]
    print(f"[{name}] armature={arm.name} bones={len(arm.data.bones)} meshes={[m.name for m in meshes]} "
          f"frames={tuple(action.frame_range) if action else None} "
          f"images={[img.name for img in bpy.data.images]}")
    if i == 0:
        main_arm = arm
    else:
        # Keep only the first file's character.
        for o in new:
            bpy.data.objects.remove(o, do_unlink=True)

# Push every action onto its own NLA track so the glTF exporter writes them all.
ad = main_arm.animation_data or main_arm.animation_data_create()
ad.action = None
for name, _ in pairs:
    act = bpy.data.actions.get(name)
    if act:
        track = ad.nla_tracks.new()
        track.name = name
        track.strips.new(name, int(act.frame_range[0]), act)

bpy.ops.export_scene.gltf(filepath=out_path, export_format="GLB", export_animations=True,
                          export_animation_mode="NLA_TRACKS", export_force_sampling=True)
print("exported", out_path)
