import * as THREE from "three";

const size = new THREE.Vector3();
const center = new THREE.Vector3();

/**
 * Scale any character (GLB or FBX) to a playable height and put the feet on
 * local y = 0, centered on XZ. The loaded graph is kept intact so Mixamo /
 * skinned clips still bind; mixer should use `wrapper.userData.animRoot`.
 */
export function fitCharacter(root: THREE.Object3D, targetHeight: number): THREE.Group {
  const wrapper = new THREE.Group();
  wrapper.add(root);
  wrapper.userData.animRoot = root;

  root.updateMatrixWorld(true);
  const box = meshBounds(root);
  box.getSize(size);
  const height = Math.max(size.y, 1e-4);
  root.scale.multiplyScalar(targetHeight / height);

  root.updateMatrixWorld(true);
  box.copy(meshBounds(root));
  box.getCenter(center);
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    if (obj instanceof THREE.SkinnedMesh) obj.frustumCulled = false;
    obj.material = normalizeMaterials(obj.material);
  });

  return wrapper;
}

function normalizeMaterials(
  material: THREE.Material | THREE.Material[],
): THREE.Material | THREE.Material[] {
  if (Array.isArray(material)) return material.map((slot) => toStandard(slot));
  return toStandard(material);
}

/** FBXLoader usually gives Phong/Lambert; convert so ACES lighting matches the GLBs. */
function toStandard(material: THREE.Material): THREE.MeshStandardMaterial {
  if (material instanceof THREE.MeshStandardMaterial) {
    polishStandard(material);
    return material;
  }

  const std = new THREE.MeshStandardMaterial();
  const anyMat = material as THREE.MeshPhongMaterial;
  if (anyMat.color) std.color.copy(anyMat.color);
  if (anyMat.map) std.map = anyMat.map;
  if (anyMat.normalMap) std.normalMap = anyMat.normalMap;
  if (anyMat.emissive) std.emissive.copy(anyMat.emissive);
  if (anyMat.emissiveMap) std.emissiveMap = anyMat.emissiveMap;
  if (anyMat.alphaMap) std.alphaMap = anyMat.alphaMap;
  std.transparent = anyMat.transparent;
  std.opacity = anyMat.opacity;
  std.name = anyMat.name;
  std.roughness = 0.65;
  std.metalness = 0.05;
  polishStandard(std);
  material.dispose();
  return std;
}

function polishStandard(slot: THREE.MeshStandardMaterial): void {
  if (slot.map) slot.map.colorSpace = THREE.SRGBColorSpace;
  slot.roughness = THREE.MathUtils.clamp(slot.roughness, 0.45, 0.9);
  slot.metalness = Math.min(slot.metalness, 0.15);
  slot.side = THREE.DoubleSide;
  slot.shadowSide = THREE.DoubleSide;
}

/** Ignore FBX cameras / lights so Mixamo extras don't flatten the scale. */
function meshBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.geometry) return;
    if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
    const geoBox = obj.geometry.boundingBox;
    if (!geoBox) return;
    box.union(geoBox.clone().applyMatrix4(obj.matrixWorld));
  });
  return box;
}
