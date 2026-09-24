import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import mapleUrl from "../../assets/environment/japanese_maple_tree.glb?url";

/**
 * Everything outside the village footprint: trees, bamboo, grass, rocks,
 * ponds and falling leaves. Built at runtime from one maple GLB plus
 * procedural meshes; every repeated thing is an InstancedMesh.
 */

/** Village earth + houses + shrine. Grass and trees stay out of here. */
const VILLAGE = { xMin: -17, xMax: 17, zMin: -37, zMax: 5 };
/** Open earth in front of the houses, right of the path. */
const FRONT_YARD_POND = { x: 10.8, z: -4.2, radius: 3.4 };
const MEADOW_POND = { x: -25, z: -9, radius: 5.2 };
const PONDS = [FRONT_YARD_POND, MEADOW_POND];

const MAPLE_HEIGHT = 7.5;
const MAPLES: ReadonlyArray<[number, number, number]> = [
  // x, z, scale
  [15.2, -9.2, 0.9],
  [-12.8, -4.2, 0.85],
  [-22, -19, 1.1],
  [22.5, -25, 1.05],
  [-20, -33, 1],
  [19, -34.5, 0.95],
  [6.5, -36.2, 0.8],
  [-24.5, 6.5, 1],
  [25, 8, 1.1],
  [-7, 13.5, 0.9],
  [10, 15, 1],
  [-30.5, -12, 0.85],
];

const BAMBOO_GROVES: ReadonlyArray<[number, number, number]> = [
  // x, z, radius
  [-31, -26, 3.2],
  [30, -15, 3],
  [-28, 18, 2.6],
  [31, 22, 2.8],
];

const WORLD_EDGE = 37;
const RIPPLE_LIFE = 1.3;

/** What characters need to know to wade through the ponds. */
export interface WaterQuery {
  depthAt(x: number, z: number): number;
  ripple(x: number, z: number, size: number): void;
}

export class Nature implements WaterQuery {
  private readonly root = new THREE.Group();
  private readonly colliderParts: THREE.BufferGeometry[] = [];
  private collider: THREE.Mesh | null = null;
  private readonly rng = mulberry32(20260923);
  private readonly windUniform = { value: 0 };
  private readonly waterUniforms: Array<{ value: number }> = [];
  private readonly koi: Array<{
    mesh: THREE.Mesh;
    y: number;
    cx: number;
    cz: number;
    r: number;
    speed: number;
    angle: number;
  }> = [];
  private readonly pondSurface = new Map<(typeof PONDS)[number], number>();
  private readonly ripples: Array<{ mesh: THREE.Mesh; age: number; size: number }> = [];
  private leaves: FallingLeaves | null = null;
  private time = 0;
  /** Trunk spots used to keep other props (and grass) from overlapping. */
  private readonly occupied: Array<{ x: number; z: number; r: number }> = [];

  constructor(scene: THREE.Scene) {
    this.root.name = "Nature";
    scene.add(this.root);
  }

  async build(): Promise<void> {
    for (const pond of PONDS) this.occupied.push({ x: pond.x, z: pond.z, r: pond.radius + 1.2 });
    for (const [x, z, r] of BAMBOO_GROVES) this.occupied.push({ x, z, r: r + 0.6 });
    for (const [x, z] of MAPLES) this.occupied.push({ x, z, r: 2.2 });

    this.buildPonds();
    this.buildBamboo();
    this.buildCedars();
    this.buildRocks();
    this.buildGrass();
    await this.buildMaples();
    this.finishColliders();
  }

  /** One invisible merged mesh of trunks, groves and big boulders. */
  getColliders(): THREE.Mesh[] {
    return this.collider ? [this.collider] : [];
  }

  update(delta: number): void {
    this.time += delta;
    this.windUniform.value = this.time;
    for (const u of this.waterUniforms) u.value = this.time;
    this.updateRipples(delta);
    for (const fish of this.koi) {
      fish.angle += fish.speed * delta;
      const a = fish.angle;
      fish.mesh.position.set(fish.cx + Math.cos(a) * fish.r, fish.y, fish.cz + Math.sin(a) * fish.r);
      const dir = Math.sign(fish.speed);
      fish.mesh.rotation.y = Math.atan2(-Math.sin(a) * dir, Math.cos(a) * dir) + Math.sin(this.time * 7 + fish.r) * 0.15;
    }
    this.leaves?.update(delta);
  }

  // ---------------------------------------------------------------- maples

  private async buildMaples(): Promise<void> {
    let gltf;
    try {
      gltf = await new GLTFLoader().loadAsync(mapleUrl);
    } catch (err) {
      console.warn("[nature] maple failed to load", err);
      return;
    }

    // The source file has one mesh per leaf cluster (~2700); merge per material.
    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material as THREE.Material;
      const geo = obj.geometry.clone();
      geo.applyMatrix4(obj.matrixWorld);
      for (const name of Object.keys(geo.attributes)) {
        if (name !== "position" && name !== "normal" && name !== "uv") geo.deleteAttribute(name);
      }
      if (!geo.attributes.normal) geo.computeVertexNormals();
      if (!geo.attributes.uv) {
        geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
      }
      if (!geo.index) {
        const idx = Array.from({ length: geo.attributes.position.count }, (_, i) => i);
        geo.setIndex(idx);
      }
      const list = byMaterial.get(mat) ?? [];
      list.push(geo);
      byMaterial.set(mat, list);
    });

    const merged: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material }> = [];
    const bounds = new THREE.Box3();
    for (const [mat, geos] of byMaterial) {
      const geo = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      if (!geo) continue;
      geo.computeBoundingBox();
      if (geo.boundingBox) bounds.union(geo.boundingBox);
      merged.push({ geo, mat });
    }
    if (merged.length === 0) return;

    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const scale = MAPLE_HEIGHT / Math.max(size.y, 1e-3);
    const normalize = new THREE.Matrix4()
      .makeScale(scale, scale, scale)
      .multiply(new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z));

    const matrices = MAPLES.map(([x, z, s]) => {
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, 0, z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * Math.PI * 2),
        new THREE.Vector3(s, s * (0.92 + this.rng() * 0.16), s),
      );
      return m;
    });

    for (const { geo, mat } of merged) {
      geo.applyMatrix4(normalize);
      const material = this.prepareFoliage(mat);
      const mesh = new THREE.InstancedMesh(geo, material, matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (material.alphaTest > 0 && "map" in material && material.map) {
        mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
          depthPacking: THREE.RGBADepthPacking,
          map: material.map as THREE.Texture,
          alphaTest: material.alphaTest,
        });
      }
      mesh.computeBoundingSphere();
      this.root.add(mesh);
    }

    for (const [x, z, s] of MAPLES) this.addCollider(x, z, 0.45 * s);
    this.leaves = new FallingLeaves(
      this.root,
      MAPLES.map(([x, z, s]) => new THREE.Vector3(x, MAPLE_HEIGHT * s * 0.8, z)),
    );
  }

  /** Blended leaf cards sort badly and cast square shadows; cut them out instead. */
  private prepareFoliage(source: THREE.Material): THREE.MeshStandardMaterial {
    const mat =
      source instanceof THREE.MeshStandardMaterial
        ? source
        : new THREE.MeshStandardMaterial({ color: 0x8a5a3a });
    if (mat.transparent) {
      mat.transparent = false;
      mat.depthWrite = true;
      mat.alphaTest = 0.45;
    }
    if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
    mat.metalness = Math.min(mat.metalness, 0.05);
    mat.roughness = Math.max(mat.roughness, 0.7);
    mat.side = THREE.DoubleSide;
    return mat;
  }

  // ---------------------------------------------------------------- cedars

  /** Tall dark conifers around the edge give the valley a backdrop. */
  private buildCedars(): void {
    const spots: Array<[number, number, number]> = [];
    let guard = 0;
    while (spots.length < 64 && guard++ < 4000) {
      const x = (this.rng() * 2 - 1) * WORLD_EDGE;
      const z = (this.rng() * 2 - 1) * WORLD_EDGE;
      const edge = Math.max(Math.abs(x), Math.abs(z));
      if (edge < 27) continue;
      if (!this.isFree(x, z, 2.4)) continue;
      const scale = 0.8 + this.rng() * 0.7;
      spots.push([x, z, scale]);
      this.occupied.push({ x, z, r: 2.4 * scale });
    }

    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 3, 7).translate(0, 1.5, 0);
    // Irregular overlapping boughs read more naturally beside the authored maples
    // than the previous stack of four geometric cones.
    const crownParts = [
      new THREE.IcosahedronGeometry(1, 1).scale(2.25, 1.45, 1.95).translate(-0.15, 4.0, 0.1),
      new THREE.IcosahedronGeometry(1, 1).scale(1.9, 1.35, 1.8).translate(0.2, 5.4, -0.1),
      new THREE.IcosahedronGeometry(1, 1).scale(1.55, 1.2, 1.45).translate(-0.12, 6.7, 0.08),
      new THREE.IcosahedronGeometry(1, 1).scale(1.1, 1.12, 1.02).translate(0.12, 7.85, 0),
    ];
    const crownGeo = mergeGeometries(crownParts, false);
    crownParts.forEach((g) => g.dispose());
    if (!crownGeo) return;

    const trunk = new THREE.InstancedMesh(
      trunkGeo,
      new THREE.MeshStandardMaterial({ color: 0x4a3426, roughness: 0.95 }),
      spots.length,
    );
    const crown = new THREE.InstancedMesh(
      crownGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 }),
      spots.length,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    spots.forEach(([x, z, s], i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * Math.PI * 2);
      m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(s, s * (0.9 + this.rng() * 0.3), s));
      trunk.setMatrixAt(i, m);
      crown.setMatrixAt(i, m);
      c.setHSL(0.3 + this.rng() * 0.06, 0.25 + this.rng() * 0.12, 0.07 + this.rng() * 0.045, THREE.SRGBColorSpace);
      crown.setColorAt(i, c);
      this.addCollider(x, z, 0.4 * s);
    });
    for (const mesh of [trunk, crown]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.root.add(mesh);
    }
  }

  // ---------------------------------------------------------------- bamboo

  private buildBamboo(): void {
    const stalks: THREE.Matrix4[] = [];
    const tufts: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (const [gx, gz, radius] of BAMBOO_GROVES) {
      const count = Math.round(radius * radius * 4.5);
      for (let i = 0; i < count; i++) {
        const a = this.rng() * Math.PI * 2;
        const r = Math.sqrt(this.rng()) * radius;
        const x = gx + Math.cos(a) * r;
        const z = gz + Math.sin(a) * r;
        const h = 5.5 + this.rng() * 3.5;
        e.set((this.rng() - 0.5) * 0.12, this.rng() * Math.PI * 2, (this.rng() - 0.5) * 0.12);
        q.setFromEuler(e);
        m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(1, h / 7, 1));
        stalks.push(m.clone());
        for (let k = 0; k < 3; k++) {
          const t = new THREE.Matrix4().compose(
            new THREE.Vector3(x + (this.rng() - 0.5) * 0.8, h * (0.7 + k * 0.12), z + (this.rng() - 0.5) * 0.8),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(this.rng() * 0.6, this.rng() * 6.28, this.rng() * 0.6)),
            new THREE.Vector3(0.9 + this.rng() * 0.5, 0.35, 0.9 + this.rng() * 0.5),
          );
          tufts.push(t);
        }
      }
      this.addCollider(gx, gz, radius * 0.85);
    }

    // Unit stalk is 7 m; segment rings come from the vertex colours.
    const stalkGeo = new THREE.CylinderGeometry(0.055, 0.075, 7, 6, 14).translate(0, 3.5, 0);
    const colors: number[] = [];
    const pos = stalkGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const ring = Math.abs(((y / 0.5) % 1) - 0.5) < 0.04 ? 0.72 : 1;
      colors.push(0.3 * ring, 0.42 * ring, 0.12 * ring);
    }
    stalkGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const stalkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
    this.addWind(stalkMat, 7, 0.28);
    const stalkMesh = new THREE.InstancedMesh(stalkGeo, stalkMat, stalks.length);
    stalks.forEach((mat, i) => stalkMesh.setMatrixAt(i, mat));

    const tuftGeo = new THREE.IcosahedronGeometry(0.7, 0);
    const tuftMat = new THREE.MeshStandardMaterial({ color: 0x5d8a3a, roughness: 0.85, flatShading: true });
    const tuftMesh = new THREE.InstancedMesh(tuftGeo, tuftMat, tufts.length);
    tufts.forEach((mat, i) => tuftMesh.setMatrixAt(i, mat));

    for (const mesh of [stalkMesh, tuftMesh]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      this.root.add(mesh);
    }
  }

  // ---------------------------------------------------------------- rocks

  private buildRocks(): void {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      const n = 1 + (hash3(v.x, v.y, v.z) - 0.5) * 0.35;
      pos.setXYZ(i, v.x * n, Math.max(v.y * n, -0.35), v.z * n);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, flatShading: true });

    const rocks: Array<{ m: THREE.Matrix4; c: THREE.Color }> = [];
    const place = (x: number, z: number, sx: number, sy: number, sz: number, collide: boolean) => {
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, sy * 0.25, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.rng() * 6.28, (this.rng() - 0.5) * 0.3)),
        new THREE.Vector3(sx, sy, sz),
      );
      const c = new THREE.Color().setHSL(
        0.08 + this.rng() * 0.05,
        0.08,
        0.3 + this.rng() * 0.14,
        THREE.SRGBColorSpace,
      );
      rocks.push({ m, c });
      if (collide) this.addCollider(x, z, Math.min(sx, sz) * 0.8);
    };

    // Rim stones around each pond.
    for (const pond of PONDS) {
      const count = Math.round(pond.radius * 4.5);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + this.rng() * 0.2;
        const r = pond.radius * pondShape(a) + 0.15 + this.rng() * 0.25;
        const s = 0.28 + this.rng() * 0.35;
        place(pond.x + Math.cos(a) * r, pond.z + Math.sin(a) * r, s * 1.3, s * 0.7, s, false);
      }
    }

    // Boulders scattered through the meadows.
    let guard = 0;
    let placed = 0;
    while (placed < 34 && guard++ < 3000) {
      const x = (this.rng() * 2 - 1) * WORLD_EDGE;
      const z = (this.rng() * 2 - 1) * WORLD_EDGE;
      if (this.inVillage(x, z, 1) || !this.isFree(x, z, 1.5)) continue;
      const big = this.rng() < 0.3;
      const s = big ? 0.9 + this.rng() * 0.8 : 0.3 + this.rng() * 0.4;
      place(x, z, s * (1 + this.rng() * 0.4), s * (0.6 + this.rng() * 0.4), s, big);
      if (big) this.occupied.push({ x, z, r: s * 1.3 });
      placed++;
    }

    const mesh = new THREE.InstancedMesh(geo, mat, rocks.length);
    rocks.forEach(({ m, c }, i) => {
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c);
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.root.add(mesh);
  }

  // ---------------------------------------------------------------- grass

  private buildGrass(): void {
    // Curved, uneven leaves break up the straight triangular lawn silhouette.
    const blade = (angle: number): THREE.BufferGeometry => {
      const w = 0.09;
      const h = 0.68;
      const g = new THREE.BufferGeometry();
      const verts = [
        -w, 0, 0, w, 0, 0,
        -w * 0.65, h * 0.46, 0.08, w * 0.65, h * 0.46, 0.08,
        -w * 0.2, h * 0.8, 0.18, w * 0.2, h * 0.8, 0.18,
        0, h, 0.26,
      ];
      const uvs = [0, 0, 1, 0, 0, 0.46, 1, 0.46, 0, 0.8, 1, 0.8, 0.5, 1];
      g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6]);
      g.rotateY(angle);
      g.translate(Math.cos(angle) * 0.06, 0, Math.sin(angle) * 0.06);
      return g;
    };
    const parts = [blade(0), blade(Math.PI / 3), blade((2 * Math.PI) / 3), blade(Math.PI * 0.85)];
    const geo = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    if (!geo) return;
    // Straight-up normals light the whole meadow evenly, like a real lawn.
    const normals = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < normals.length; i += 3) normals[i + 1] = 1;
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    const uv = geo.attributes.uv;
    const colors: number[] = [];
    for (let i = 0; i < uv.count; i++) {
      const t = uv.getY(i);
      colors.push(0.09 + t * 0.24, 0.16 + t * 0.31, 0.04 + t * 0.11);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 0.95,
    });
    this.addWind(mat, 0.55, 0.22);

    const count = 18000;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    let n = 0;
    let guard = 0;
    while (n < count && guard++ < count * 6) {
      const x = (this.rng() * 2 - 1) * 39;
      const z = (this.rng() * 2 - 1) * 39;
      if (this.inVillage(x, z, -0.5)) continue;
      if (PONDS.some((p) => Math.hypot(x - p.x, z - p.z) < p.radius + 0.5)) continue;
      // Denser patches with sparse gaps between them.
      const patch = 0.5 + 0.5 * Math.sin(x * 0.21 + Math.cos(z * 0.17) * 2) * Math.cos(z * 0.23);
      if (this.rng() > 0.35 + patch * 0.65) continue;
      const s = 0.7 + this.rng() * 0.8 + patch * 0.4;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * Math.PI * 2);
      m.compose(new THREE.Vector3(x, -0.08, z), q, new THREE.Vector3(s, s * (0.8 + this.rng() * 0.6), s));
      mesh.setMatrixAt(n, m);
      // Instance colour multiplies the blade gradient, so keep it a light tint.
      c.setHSL(0.18 + this.rng() * 0.08, 0.3, 0.72 + this.rng() * 0.2, THREE.SRGBColorSpace);
      mesh.setColorAt(n, c);
      n++;
    }
    mesh.count = n;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.root.add(mesh);
  }

  // ---------------------------------------------------------------- ponds

  private buildPonds(): void {
    for (const pond of PONDS) {
      const surfaceY = pond === FRONT_YARD_POND ? 0.06 : 0.0;
      const shape = new THREE.Shape();
      const steps = 48;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const r = pond.radius * pondShape(a);
        // Shape Y is negated so that after rotateX(-90°) world z = sin(a) * r, matching the rim stones.
        if (i === 0) shape.moveTo(Math.cos(a) * r, -Math.sin(a) * r);
        else shape.lineTo(Math.cos(a) * r, -Math.sin(a) * r);
      }

      const bed = new THREE.Mesh(
        new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({
          color: 0x2b3527,
          roughness: 1,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -3,
        }),
      );
      bed.position.set(pond.x, surfaceY - 0.03, pond.z);
      bed.receiveShadow = true;
      this.root.add(bed);

      const uTime = { value: 0 };
      this.waterUniforms.push(uTime);
      const water = new THREE.Mesh(
        new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2),
        createWaterMaterial(uTime, pond.radius),
      );
      water.position.set(pond.x, surfaceY, pond.z);
      water.renderOrder = 2;
      this.root.add(water);

      // Lily pads: flat discs with a notch.
      const padGeo = new THREE.CircleGeometry(0.32, 14, 0.35, Math.PI * 2 - 0.7).rotateX(-Math.PI / 2);
      const padMat = new THREE.MeshStandardMaterial({ color: 0x3f7a35, roughness: 0.7, side: THREE.DoubleSide });
      const padCount = Math.round(pond.radius * 2.2);
      const pads = new THREE.InstancedMesh(padGeo, padMat, padCount);
      const m = new THREE.Matrix4();
      for (let i = 0; i < padCount; i++) {
        const a = this.rng() * Math.PI * 2;
        const r = pond.radius * (0.35 + this.rng() * 0.5);
        const s = 0.7 + this.rng() * 0.7;
        m.compose(
          new THREE.Vector3(pond.x + Math.cos(a) * r, surfaceY + 0.012, pond.z + Math.sin(a) * r),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * 6.28),
          new THREE.Vector3(s, 1, s),
        );
        pads.setMatrixAt(i, m);
      }
      pads.receiveShadow = true;
      pads.computeBoundingSphere();
      this.root.add(pads);

      // Koi circling under the surface.
      const koiGeo = new THREE.CapsuleGeometry(0.07, 0.26, 4, 8).rotateX(Math.PI / 2);
      const koiCount = Math.round(pond.radius * 1.4);
      for (let i = 0; i < koiCount; i++) {
        const color = [0xff6a1f, 0xf4f0e6, 0xe8401c, 0xffa033][i % 4];
        const fish = new THREE.Mesh(koiGeo, new THREE.MeshStandardMaterial({ color, roughness: 0.4 }));
        this.root.add(fish);
        this.koi.push({
          mesh: fish,
          y: surfaceY - 0.012,
          cx: pond.x,
          cz: pond.z,
          r: pond.radius * (0.3 + this.rng() * 0.45),
          speed: (0.25 + this.rng() * 0.35) * (this.rng() < 0.5 ? -1 : 1),
          angle: this.rng() * Math.PI * 2,
        });
      }
      this.pondSurface.set(pond, surfaceY);
    }

    const ringGeo = new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2);
    for (let i = 0; i < 28; i++) {
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: 0xe8f4f4, transparent: true, opacity: 0, depthWrite: false }),
      );
      ring.visible = false;
      ring.renderOrder = 3;
      this.root.add(ring);
      this.ripples.push({ mesh: ring, age: Infinity, size: 1 });
    }
  }

  /** 0 on dry land, easing to 1 about a third of the way into a pond. */
  depthAt(x: number, z: number): number {
    for (const pond of PONDS) {
      const dx = x - pond.x;
      const dz = z - pond.z;
      const d = Math.hypot(dx, dz);
      if (d > pond.radius * 1.2) continue;
      const edge = pond.radius * pondShape(Math.atan2(dz, dx));
      return 1 - THREE.MathUtils.smoothstep(d / edge, 0.66, 0.98);
    }
    return 0;
  }

  /** Expanding ring on the water surface; `size` is the final radius in metres. */
  ripple(x: number, z: number, size: number): void {
    const pond = PONDS.find((p) => Math.hypot(x - p.x, z - p.z) < p.radius * 1.1);
    if (!pond) return;
    let slot = this.ripples[0];
    for (const r of this.ripples) if (r.age > slot.age) slot = r;
    slot.age = 0;
    slot.size = size;
    slot.mesh.position.set(x, (this.pondSurface.get(pond) ?? 0) + 0.006, z);
    slot.mesh.visible = true;
  }

  private updateRipples(delta: number): void {
    for (const r of this.ripples) {
      if (!r.mesh.visible) continue;
      r.age += delta;
      const t = r.age / RIPPLE_LIFE;
      if (t >= 1) {
        r.mesh.visible = false;
        continue;
      }
      const s = r.size * (0.25 + 0.75 * (1 - (1 - t) * (1 - t)));
      r.mesh.scale.set(s, 1, s);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - t);
    }
  }

  // ---------------------------------------------------------------- helpers

  /** Bend vertices sideways by height; `height` is the model height where sway is full. */
  private addWind(mat: THREE.MeshStandardMaterial, height: number, strength: number): void {
    const uTime = this.windUniform;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uWindTime = uTime;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uWindTime;")
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          {
            vec4 anchor = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            float k = clamp(position.y / ${height.toFixed(2)}, 0.0, 1.0);
            k *= k;
            float gust = sin(uWindTime * 1.3 + anchor.x * 0.21 + anchor.z * 0.17) * 0.6
                       + sin(uWindTime * 2.9 + anchor.x * 0.73) * 0.25;
            transformed.x += gust * k * ${strength.toFixed(2)} * ${height.toFixed(2)};
            transformed.z += gust * k * ${(strength * 0.6).toFixed(2)} * ${height.toFixed(2)};
          }`,
        );
    };
    mat.customProgramCacheKey = () => `wind-${height}-${strength}`;
  }

  private addCollider(x: number, z: number, radius: number): void {
    const g = new THREE.CylinderGeometry(radius, radius, 3, 14, 1, true);
    g.translate(x, 1.5, z);
    g.deleteAttribute("uv");
    this.colliderParts.push(g);
  }

  private finishColliders(): void {
    const merged = mergeGeometries(this.colliderParts, false);
    this.colliderParts.forEach((g) => g.dispose());
    this.colliderParts.length = 0;
    if (!merged) return;
    // FrontSide only: rays from inside a rim (e.g. after a leap) pass out freely.
    this.collider = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ side: THREE.FrontSide }));
    this.collider.name = "NatureColliders";
    this.collider.visible = false;
    this.root.add(this.collider);
    this.collider.updateMatrixWorld(true);
  }

  private inVillage(x: number, z: number, margin: number): boolean {
    return (
      x > VILLAGE.xMin - margin &&
      x < VILLAGE.xMax + margin &&
      z > VILLAGE.zMin - margin &&
      z < VILLAGE.zMax + margin
    );
  }

  private isFree(x: number, z: number, radius: number): boolean {
    if (this.inVillage(x, z, radius * 0.5)) return false;
    return this.occupied.every((o) => Math.hypot(x - o.x, z - o.z) > o.r + radius);
  }
}

/** Slightly irregular pond outline, same for water, bed and rim stones. */
function pondShape(angle: number): number {
  return 1 + Math.sin(angle * 3 + 0.7) * 0.09 + Math.sin(angle * 5 + 2.1) * 0.05;
}

function createWaterMaterial(uTime: { value: number }, radius: number): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uRadius: { value: radius },
        uDeep: { value: new THREE.Color(0x0b3446) },
        uShallow: { value: new THREE.Color(0x2f6f78) },
        uSky: { value: new THREE.Color(0xbcd6de) },
        uSunDir: { value: new THREE.Vector3(22, 34, 16).normalize() },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      varying vec2 vLocal;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vLocal = position.xz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uRadius;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      uniform vec3 uSky;
      uniform vec3 uSunDir;
      varying vec3 vWorld;
      varying vec2 vLocal;
      #include <fog_pars_fragment>
      void main() {
        float r = clamp(length(vLocal) / uRadius, 0.0, 1.0);
        vec3 col = mix(uDeep, uShallow, smoothstep(0.25, 1.0, r));

        vec2 p = vWorld.xz;
        vec3 n = normalize(vec3(
          cos(p.x * 3.1 + uTime * 1.3) * 0.05 + cos((p.x + p.y) * 5.3 + uTime * 2.1) * 0.03,
          1.0,
          cos(p.y * 2.7 - uTime * 1.1) * 0.05 + cos((p.x - p.y) * 4.7 - uTime * 1.7) * 0.03
        ));
        vec3 v = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
        col = mix(col, uSky, clamp(fres * 0.95 + 0.12, 0.0, 1.0));

        vec3 h = normalize(uSunDir + v);
        col += vec3(1.0, 0.96, 0.88) * pow(max(dot(n, h), 0.0), 180.0) * 1.6;

        float alpha = mix(0.9, 0.62, smoothstep(0.55, 1.0, r));
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
  // UniformsUtils.merge clones values; re-link the shared time uniform.
  mat.uniforms.uTime = uTime;
  return mat;
}

/** Red maple leaves drifting down under each tree canopy. */
class FallingLeaves {
  private readonly points: THREE.Points;
  private readonly velocities: Float32Array;
  private readonly origins: THREE.Vector3[];
  private readonly count: number;
  private time = 0;

  constructor(parent: THREE.Object3D, origins: THREE.Vector3[]) {
    this.origins = origins;
    this.count = origins.length * 22;
    const positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count * 3);
    for (let i = 0; i < this.count; i++) this.respawn(positions, i, true);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const colors = new Float32Array(this.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < this.count; i++) {
      c.setHSL(0.01 + Math.random() * 0.06, 0.8, 0.42 + Math.random() * 0.15, THREE.SRGBColorSpace);
      colors.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.13,
        vertexColors: true,
        map: leafSprite(),
        alphaTest: 0.5,
        transparent: false,
      }),
    );
    this.points.frustumCulled = false;
    parent.add(this.points);
  }

  update(delta: number): void {
    this.time += delta;
    const pos = this.points.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      const flutter = Math.sin(this.time * 2.2 + i) * 0.6;
      arr[k] += (this.velocities[k] + flutter) * delta;
      arr[k + 1] += this.velocities[k + 1] * delta;
      arr[k + 2] += (this.velocities[k + 2] + Math.cos(this.time * 1.7 + i) * 0.4) * delta;
      if (arr[k + 1] < 0.02) this.respawn(arr, i, false);
    }
    pos.needsUpdate = true;
  }

  private respawn(arr: Float32Array, i: number, anyHeight: boolean): void {
    const o = this.origins[i % this.origins.length];
    const k = i * 3;
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 3.2;
    arr[k] = o.x + Math.cos(a) * r;
    arr[k + 1] = anyHeight ? Math.random() * o.y : o.y * (0.7 + Math.random() * 0.3);
    arr[k + 2] = o.z + Math.sin(a) * r;
    this.velocities[k] = 0.25 + Math.random() * 0.3;
    this.velocities[k + 1] = -(0.45 + Math.random() * 0.4);
    this.velocities[k + 2] = (Math.random() - 0.5) * 0.3;
  }
}

function leafSprite(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.ellipse(16, 16, 14, 8, Math.PI / 4, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
