import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import shrineUrl from "../../assets/environment/japanese_shrine.glb?url";
import { assetUrl } from "./assetUrl";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const manager = new THREE.LoadingManager();
manager.setURLModifier((url) => {
  const lower = url.split("?")[0].toLowerCase();
  if (lower.includes("normal") || lower.includes("bake1")) return PIXEL;
  return url;
});

const fbxLoader = new FBXLoader(manager);
const texLoader = new THREE.TextureLoader();

/** Axis-aligned footprint the player cannot walk through. */
export type WorldBox = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

type Pack = {
  fbx: string;
  tex: string;
  metal?: boolean;
  alpha?: boolean;
  alphaTest?: number;
};

const BASE = assetUrl("ancientvillage").replace(/\/$/, "");

const PACKS = {
  hut: {
    fbx: `${BASE}/Hut/SM_Hut.fbx`,
    tex: `${BASE}/Hut/TextureMaps/T_Hut`,
  },
  barracks: {
    fbx: `${BASE}/Barracks/SM_Barracks.fbx`,
    tex: `${BASE}/Barracks/TextureMaps/T_Barracks`,
    metal: true,
  },
  town: {
    fbx: `${BASE}/TownCenter/SM_TownCenter.fbx`,
    tex: `${BASE}/TownCenter/TextureMaps/T_TownCenter`,
    metal: true,
  },
  watch: {
    fbx: `${BASE}/WatchTower/SM_WatchTower.fbx`,
    tex: `${BASE}/WatchTower/TextureMaps/T_WatchTower`,
    metal: true,
  },
  mill: {
    fbx: `${BASE}/Windmill/SM_Windmill.fbx`,
    tex: `${BASE}/Windmill/TextureMaps/T_Windmill`,
    metal: true,
  },
  sails: {
    fbx: `${BASE}/Windmill/SM_Windmill_Sails.fbx`,
    tex: `${BASE}/Windmill/TextureMaps/T_Windmill`,
    metal: true,
  },
  wallTower: {
    fbx: `${BASE}/Walls/Tower/SM_Tower.fbx`,
    tex: `${BASE}/Walls/Tower/TextureMaps/T_Tower`,
    metal: true,
  },
  wallMid: {
    fbx: `${BASE}/Walls/WallMid/SM_WallMid.fbx`,
    tex: `${BASE}/Walls/WallMid/TextureMaps/T_WallMid`,
  },
  props: {
    fbx: "",
    tex: `${BASE}/MiscProps/TextureMaps/T_Props`,
    metal: true,
  },
} as const satisfies Record<string, Pack>;

const PROP_FBX = {
  barrel: `${BASE}/MiscProps/SM_Barrel.fbx`,
  crate: `${BASE}/MiscProps/SM_WoodCrate.fbx`,
  fence: `${BASE}/MiscProps/SM_WoodFence.fbx`,
  crop: `${BASE}/MiscProps/SM_CropField.fbx`,
  grass1: `${BASE}/MiscProps/SM_Grass_01.fbx`,
  grass2: `${BASE}/MiscProps/SM_Grass_02.fbx`,
  grass3: `${BASE}/MiscProps/SM_Grass_03.fbx`,
  axe: `${BASE}/MiscProps/SM_Axe.fbx`,
  shield: `${BASE}/MiscProps/SM_Shield.fbx`,
} as const;

/** Authored FBX units vary; fit each kit piece to a playable metre height. */
const TARGET_HEIGHT: Record<string, number> = {
  hut: 4.4,
  barracks: 6.6,
  town: 8.8,
  watch: 11.2,
  mill: 12,
  wallTower: 7.4,
  wallMid: 4.1,
  barrel: 0.95,
  crate: 0.72,
  fence: 1.2,
  crop: 0.58,
  grass1: 0.48,
  grass2: 0.42,
  grass3: 0.52,
  axe: 0.68,
  shield: 0.95,
};

const YARD = {
  xMin: -17,
  xMax: 17,
  zMin: -21,
  zMax: 13,
} as const;

const GATE_HALF = 4.6;
const PLAYER_KEEP_CLEAR = 2.4;

type Prototype = {
  root: THREE.Group;
  size: THREE.Vector3;
};

/**
 * Loads the ancientvillage kit and stamps a walled hamlet around the ninja.
 */
export class Village {
  readonly root = new THREE.Group();
  readonly boxes: WorldBox[] = [];

  private readonly placed = new THREE.Group();
  private readonly foliage = new THREE.Group();
  private readonly sailPivots: THREE.Group[] = [];
  private readonly prototypes = new Map<string, Prototype>();
  private readonly stampCounts = new Map<string, number>();

  constructor(scene: THREE.Scene) {
    this.root.name = "AncientVillage";
    this.placed.name = "Village";
    this.foliage.name = "Foliage";
    this.root.add(this.placed);
    this.root.add(this.foliage);
    scene.add(this.root);
  }

  async load(): Promise<void> {
    const rebuild = new URLSearchParams(window.location.search).has("rebuildVillage");
    try {
      if (!rebuild) {
        await this.loadAssembledGlb(shrineUrl);
        console.info("[village] loaded", shrineUrl);
        return;
      }
      await this.loadPrototypes();
      this.stampYard();
      console.info("[village] stamped from FBX kit");
    } catch (err) {
      console.error("Failed to load village", err);
      if (!rebuild) {
        try {
          await this.loadPrototypes();
          this.stampYard();
        } catch (fallbackErr) {
          console.error("FBX village fallback failed", fallbackErr);
        }
      }
    }
  }

  private async loadAssembledGlb(url: string): Promise<void> {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(assetUrl("draco/"));
    loader.setDRACOLoader(draco);
    const gltf = await loader.loadAsync(url);
    this.placed.clear();
    this.placed.add(gltf.scene);
    this.placed.updateMatrixWorld(true);
    nudgeHousesOffPath(this.placed);

    this.placed.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.material = brightenGltfMaterial(obj.material);
      const name = groundLabel(obj);
      const isGround = /(ground|plaza|path|plane|grid)/.test(name);
      obj.castShadow = !isGround;
      obj.receiveShadow = true;
      if (!isGround) return;
      // Earth, gravel, and the grass plane were coplanar, which flickers.
      // The stone path stays the top layer.
      if (name.includes("earth")) obj.position.y += 0.02;
      else if (name.includes("gravel")) obj.position.y += 0.035;
      const slots = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const slot of slots) {
        slot.polygonOffset = true;
        slot.polygonOffsetFactor = -2;
        slot.polygonOffsetUnits = -2;
      }
    });
  }

  getCollisionMeshes(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    const size = new THREE.Vector3();
    this.placed.updateMatrixWorld(true);
    this.placed.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || !obj.visible) return;
      const name = obj.name.toLowerCase();
      if (/(plaza|path|ground|grass|plane|foliage)/.test(name)) return;
      const box = new THREE.Box3().setFromObject(obj);
      box.getSize(size);
      if (size.y < 0.45) return;
      meshes.push(obj);
    });
    return meshes;
  }

  update(delta: number): void {
    for (const pivot of this.sailPivots) {
      pivot.rotation.z += delta * 0.55;
    }
  }

  private async loadPrototypes(): Promise<void> {
    const buildingJobs: Array<[string, Pack]> = [
      ["hut", PACKS.hut],
      ["barracks", PACKS.barracks],
      ["town", PACKS.town],
      ["watch", PACKS.watch],
      ["wallTower", PACKS.wallTower],
      ["wallMid", PACKS.wallMid],
    ];

    await Promise.all([
      ...buildingJobs.map(async ([name, pack]) => {
        this.prototypes.set(name, await this.makePrototype(name, pack.fbx, pack));
      }),
      this.makeWindmillPrototype(),
      ...Object.entries(PROP_FBX).map(async ([name, url]) => {
        this.prototypes.set(
          name,
          await this.makePrototype(name, url, PACKS.props, name.startsWith("grass")),
        );
      }),
    ]);
  }

  private async makePrototype(
    name: string,
    url: string,
    pack: Pack,
    foliage = false,
  ): Promise<Prototype> {
    const fbx = await loadFbx(url);
    const material = await makeVillageMaterial(pack, foliage);
    paintMeshes(fbx, material, foliage);

    const wrapper = new THREE.Group();
    wrapper.add(fbx);
    fitToHeight(wrapper, TARGET_HEIGHT[name] ?? 2);
    const size = new THREE.Box3().setFromObject(wrapper).getSize(new THREE.Vector3());
    wrapper.visible = false;
    this.root.add(wrapper);
    return { root: wrapper, size };
  }

  private async makeWindmillPrototype(): Promise<void> {
    const millFbx = await loadFbx(PACKS.mill.fbx);
    const sailsFbx = await loadFbx(PACKS.sails.fbx);
    const material = await makeVillageMaterial(PACKS.mill, false);
    paintMeshes(millFbx, material, false);
    paintMeshes(sailsFbx, material, false);

    const wrapper = new THREE.Group();
    wrapper.add(millFbx);
    wrapper.add(sailsFbx);
    fitToHeight(wrapper, TARGET_HEIGHT.mill);

    sailsFbx.updateMatrixWorld(true);
    const center = new THREE.Box3().setFromObject(sailsFbx).getCenter(new THREE.Vector3());
    wrapper.worldToLocal(center);
    const pivot = new THREE.Group();
    pivot.name = "SailPivot";
    wrapper.add(pivot);
    pivot.position.copy(center);
    pivot.attach(sailsFbx);

    const size = new THREE.Box3().setFromObject(wrapper).getSize(new THREE.Vector3());
    wrapper.visible = false;
    this.root.add(wrapper);
    this.prototypes.set("mill", { root: wrapper, size });
  }

  private stampYard(): void {
    this.addGroundDressing();

    this.place("town", 0, -15.2, 0, true);
    this.place("barracks", 11.2, -12.4, -Math.PI * 0.08, true);
    this.place("watch", -13.4, -16.6, Math.PI * 0.18, true);
    this.placeWindmill(-22.5, 1.8, Math.PI * 0.55);

    this.place("hut", -9.4, -6.2, 0.35, true);
    this.place("hut", -11.2, 3.6, -0.7, true);
    this.place("hut", 9.6, -4.1, 2.6, true);
    this.place("hut", 10.4, 6.4, -2.3, true);

    this.place("crop", -21.2, 8.4, 0.1, true);
    this.place("crop", -16.6, 10.2, -0.2, true);
    this.place("crop", -24.4, 6.1, 0.4, true);

    this.place("fence", -18.6, 6.6, 0.12);
    this.place("fence", -18.8, 9.8, 0.08);
    this.place("fence", -14.4, 8.8, Math.PI * 0.5);
    this.place("fence", 10.4, -8.8, 1.4);
    this.place("fence", -8.2, -9.4, 0.2);

    this.place("barrel", 3.4, -12.2, 0.4);
    this.place("barrel", 4.1, -11.6, 1.1);
    this.place("crate", 4.8, -12.6, 0.3);
    this.place("crate", -3.6, -12.8, 0.7);
    this.place("barrel", -10.6, -7.4, 0.2);
    this.place("axe", -8.6, -7.8, 0.9);
    this.place("shield", 9.6, -10.8, -0.4);
    this.place("crate", 10.2, 4.2, 0.15);

    this.buildWalls();
    this.scatterGrass();
  }

  private addGroundDressing(): void {
    const plaza = new THREE.Mesh(
      new THREE.PlaneGeometry(22, 20),
      new THREE.MeshStandardMaterial({
        color: 0x7a6b52,
        roughness: 0.96,
        metalness: 0.02,
      }),
    );
    plaza.name = "Plaza";
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set(0, 0.015, -2);
    plaza.receiveShadow = true;
    this.placed.add(plaza);

    const path = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 36),
      new THREE.MeshStandardMaterial({
        color: 0x6a5a44,
        roughness: 0.97,
        metalness: 0.02,
      }),
    );
    path.name = "Path";
    path.rotation.x = -Math.PI / 2;
    path.position.set(0, 0.02, -4);
    path.receiveShadow = true;
    this.placed.add(path);
  }

  private buildWalls(): void {
    const { xMin, xMax, zMin, zMax } = YARD;
    const tower = this.prototypes.get("wallTower");
    // Seat palisade ends into the towers so the L at each corner doesn't open a hole.
    const inset = tower ? Math.max(tower.size.x, tower.size.z) * 0.28 : 0.9;

    this.fillWallRun(xMin + inset, zMin, xMax - inset, zMin, true);
    this.fillWallRun(xMin + inset, zMax, xMax - inset, zMax, true);
    this.fillWallRun(xMin, zMin + inset, xMin, zMax - inset, false);
    this.fillWallRun(xMax, zMin + inset, xMax, zMax - inset, false);

    this.place("wallTower", xMin, zMin, 0, true);
    this.place("wallTower", xMax, zMin, Math.PI * 0.5, true);
    this.place("wallTower", xMin, zMax, -Math.PI * 0.5, true);
    this.place("wallTower", xMax, zMax, Math.PI, true);

    this.plugCorners();
  }

  /** Extra palisade bites along both axes so corner towers aren't standing in a gap. */
  private plugCorners(): void {
    const wall = this.prototypes.get("wallMid");
    if (!wall) return;
    const along = wall.size.x * 0.32;
    const { xMin, xMax, zMin, zMax } = YARD;
    const corners = [
      { x: xMin, z: zMin },
      { x: xMax, z: zMin },
      { x: xMin, z: zMax },
      { x: xMax, z: zMax },
    ];
    for (const corner of corners) {
      const towardX = Math.sign(-corner.x) || 1;
      const towardZ = Math.sign(-corner.z) || 1;
      this.place("wallMid", corner.x + towardX * along, corner.z, 0, true);
      this.place("wallMid", corner.x, corner.z + towardZ * along, Math.PI / 2, true);
    }
  }

  /** South wall (max Z) keeps a gate opening on the road. */
  private fillWallRun(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    alongX: boolean,
  ): void {
    const wall = this.prototypes.get("wallMid");
    if (!wall) return;
    const pieceLen = Math.max(wall.size.x, 0.8);
    const dx = x1 - x0;
    const dz = z1 - z0;
    const length = Math.hypot(dx, dz);
    if (length < 0.4) return;

    const ux = dx / length;
    const uz = dz / length;
    const yaw = alongX ? 0 : Math.PI / 2;
    const gateOnSouth =
      alongX && Math.abs(z0 - YARD.zMax) < 0.01 && Math.abs(z1 - YARD.zMax) < 0.01;

    // First/last centres sit half a piece in from the ends so the run actually
    // covers the corners instead of leaving a remainder gap from rounding.
    const first = Math.min(pieceLen * 0.5, length * 0.5);
    const last = Math.max(length - pieceLen * 0.5, first);
    const span = last - first;
    const stride = pieceLen * 0.62;
    const steps = span < 0.05 ? 0 : Math.max(1, Math.ceil(span / stride));

    for (let i = 0; i <= steps; i++) {
      const along = first + (steps === 0 ? 0 : (span * i) / steps);
      const x = x0 + ux * along;
      const z = z0 + uz * along;
      if (gateOnSouth && Math.abs(x) < GATE_HALF + pieceLen * 0.12) continue;
      this.place("wallMid", x, z, yaw, true);
    }
  }

  private scatterGrass(): void {
    const kinds = ["grass1", "grass2", "grass3"] as const;
    let planted = 0;
    let guard = 0;
    while (planted < 72 && guard < 400) {
      guard += 1;
      const x = rand(-32, 32);
      const z = rand(-34, 28);
      if (Math.hypot(x, z) < PLAYER_KEEP_CLEAR) continue;
      if (Math.abs(x) < 1.8 && z < 12 && z > -18) continue;
      const kind = kinds[planted % kinds.length];
      this.stampClone(kind, x, z, rand(0, Math.PI * 2), rand(0.85, 1.35), this.foliage);
      planted += 1;
    }
  }

  private placeWindmill(x: number, z: number, yaw: number): void {
    const mill = this.place("mill", x, z, yaw, true);
    mill?.traverse((obj) => {
      if (obj.name === "SailPivot" && obj instanceof THREE.Group) {
        this.sailPivots.push(obj);
      }
    });
  }

  private place(
    key: string,
    x: number,
    z: number,
    yaw: number,
    blocking = false,
    scale = 1,
  ): THREE.Group | undefined {
    const clone = this.stampClone(key, x, z, yaw, scale);
    if (!clone) return undefined;
    if (blocking) this.addFootprint(key, clone);
    return clone;
  }

  private stampClone(
    key: string,
    x: number,
    z: number,
    yaw: number,
    scale: number,
    parent: THREE.Group = this.placed,
  ): THREE.Group | undefined {
    const proto = this.prototypes.get(key);
    if (!proto) return undefined;
    const clone = proto.root.clone(true);
    const n = (this.stampCounts.get(key) ?? 0) + 1;
    this.stampCounts.set(key, n);
    clone.name = `${key}_${n}`;
    clone.visible = true;
    clone.position.set(x, 0, z);
    clone.rotation.y = yaw;
    if (scale !== 1) clone.scale.multiplyScalar(scale);
    parent.add(clone);
    return clone;
  }

  private addFootprint(key: string, obj: THREE.Group): void {
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const pad = key === "wallMid" || key === "wallTower" ? 0.12 : 0.28;
    const minX = box.min.x + pad;
    const maxX = box.max.x - pad;
    const minZ = box.min.z + pad;
    const maxZ = box.max.z - pad;
    if (maxX - minX < 0.35 || maxZ - minZ < 0.35) {
      this.boxes.push({
        minX: box.min.x - 0.1,
        maxX: box.max.x + 0.1,
        minZ: box.min.z - 0.1,
        maxZ: box.max.z + 0.1,
      });
      return;
    }
    this.boxes.push({ minX, maxX, minZ, maxZ });
  }
}

function paintMeshes(
  root: THREE.Object3D,
  material: THREE.Material,
  foliage: boolean,
): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.material = material;
    obj.castShadow = !foliage;
    obj.receiveShadow = true;
  });
}

function fitToHeight(root: THREE.Object3D, targetHeight: number): void {
  root.updateMatrixWorld(true);
  const raw = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  const height = Math.max(raw.y, 1e-4);
  root.scale.multiplyScalar(targetHeight / height);
  plantOnGround(root);
}
function plantOnGround(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  root.updateMatrixWorld(true);
}

async function makeVillageMaterial(pack: Pack, foliage: boolean): Promise<THREE.MeshStandardMaterial> {
  const [map, roughnessMap, alphaMap] = await Promise.all([
    loadTex(`${pack.tex}_diffuse.png`, true),
    loadTex(`${pack.tex}_roughness.png`, false),
    pack.alpha || foliage ? loadTex(`${pack.tex}_alpha.png`, false) : Promise.resolve(null),
  ]);

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map,
    roughnessMap,
    alphaMap: alphaMap ?? undefined,
    roughness: 0.7,
    metalness: 0.05,
  });

  if (alphaMap || foliage) {
    mat.alphaTest = pack.alphaTest ?? 0.42;
    mat.transparent = false;
    mat.depthWrite = true;
    mat.side = THREE.DoubleSide;
  }

  return mat;
}

async function loadTex(url: string, srgb: boolean): Promise<THREE.Texture | null> {
  try {
    const tex = await texLoader.loadAsync(url);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = 4;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = false;
    const img = tex.image as { width?: number; height?: number } | undefined;
    const maxDim = Math.max(img?.width ?? 0, img?.height ?? 0);
    if (maxDim > 2048) {
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
    }
    return tex;
  } catch (err) {
    console.warn("[village] missing texture", url, err);
    return null;
  }
}

/** Push each farmhouse group sideways so roofs clear the stone path. */
const HOUSE_SETBACK: Record<string, number> = {
  minka: -3.2,
  minka_l2: -3.2,
  minka_r: 3.2,
};

function nudgeHousesOffPath(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const shift = HOUSE_SETBACK[obj.name];
    if (shift) obj.position.x += shift;
  });
}

function groundLabel(obj: THREE.Object3D): string {
  const names: string[] = [];
  let current: THREE.Object3D | null = obj;
  while (current) {
    names.push(current.name.toLowerCase());
    current = current.parent;
  }
  return names.join(" ");
}

function brightenGltfMaterial(
  material: THREE.Material | THREE.Material[],
): THREE.Material | THREE.Material[] {
  if (Array.isArray(material)) return material.map((slot) => polishGltfSlot(slot));
  return polishGltfSlot(material);
}

function polishGltfSlot(material: THREE.Material): THREE.Material {
  if (!(material instanceof THREE.MeshStandardMaterial)) return material;
  if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
  if (material.emissiveMap) material.emissiveMap.colorSpace = THREE.SRGBColorSpace;
  // Blender glTF often leaves a metalness map that turns wood/thatch into dark metal.
  material.metalnessMap = null;
  material.metalness = Math.min(material.metalness, 0.12);
  material.roughness = THREE.MathUtils.clamp(material.roughness, 0.35, 0.92);
  material.envMapIntensity = 1.15;
  return material;
}

function loadFbx(url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    fbxLoader.load(url, resolve, undefined, (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
