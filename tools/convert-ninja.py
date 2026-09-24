"""Build the web ninja rig and animation-only GLBs from the source Mixamo FBXs.

Run with Blender 5.x:
  blender --background --python tools/convert-ninja.py

The source files live in source/characters; only the small GLBs in
public/characters are published by Vite.
"""

from pathlib import Path
import shutil
import tempfile
import uuid
import bpy


ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "source" / "characters"
OUTPUT = ROOT / "public" / "characters"
TEMP = ROOT / "work" / "blender-temp"
TEMP.mkdir(parents=True, exist_ok=True)
tempfile.tempdir = str(TEMP)


class ExportTemp:
    """Give Blender's image encoder a directory with inherited permissions."""

    def __init__(self, *args, **kwargs):
        self.name = str(TEMP / f"image-{uuid.uuid4().hex}")
        Path(self.name).mkdir()

    def __enter__(self):
        return self.name

    def __exit__(self, *args):
        shutil.rmtree(self.name)


tempfile.TemporaryDirectory = ExportTemp
TAKES = ("run", "idle", "roll", "kick", "runjump", "jumphit", "punch")


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_take(name):
    path = SOURCE / f"NINJA{name}.fbx"
    bpy.ops.import_scene.fbx(filepath=str(path), use_anim=True)
    armature = next(obj for obj in bpy.data.objects if obj.type == "ARMATURE")
    action = armature.animation_data.action
    if action is None:
        raise RuntimeError(f"No animation in {path}")
    action.name = name
    print(f"Imported {name}: {len(armature.data.bones)} bones, {action.frame_range[:]} frames")
    return armature


def export(name, armature, include_mesh):
    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    if include_mesh:
        for obj in bpy.data.objects:
            if obj.type == "MESH":
                obj.select_set(True)
        # These textures repeat in every original FBX. One 1024px set is enough
        # for a roughly 1.7 m character seen from a third-person camera.
        for image in bpy.data.images:
            if image.type == "IMAGE" and max(image.size) > 1024:
                image.scale(1024, 1024)
    bpy.context.view_layer.objects.active = armature
    OUTPUT.mkdir(parents=True, exist_ok=True)
    path = OUTPUT / f"NINJA{name}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_animation_mode="ACTIVE_ACTIONS",
        export_skins=include_mesh,
        export_cameras=False,
        export_lights=False,
    )
    print(f"Exported {path}: {path.stat().st_size / 1024 / 1024:.2f} MB")


for take in TAKES:
    reset()
    rig = import_take(take)
    export(take, rig, include_mesh=(take == "run"))
