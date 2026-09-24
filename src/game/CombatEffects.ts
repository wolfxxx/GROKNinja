import * as THREE from "three";

type Burst = { mesh: THREE.Mesh; age: number; life: number; start: number; end: number };

/** Short, readable attack cues built from geometry, with no extra downloads. */
export class CombatEffects {
  private readonly bursts: Burst[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  roundhouse(at: THREE.Vector3, facing: number): void {
    const geometry = new THREE.TorusGeometry(1.5, 0.065, 6, 48, Math.PI * 1.65);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffc872,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.set(-Math.PI / 2, 0, facing - Math.PI * 0.82);
    mesh.position.copy(at).add(new THREE.Vector3(0, 1.05, 0));
    this.scene.add(mesh);
    this.bursts.push({ mesh, age: 0, life: 0.28, start: 0.8, end: 1.4 });
  }

  slam(at: THREE.Vector3): void {
    for (const [color, delay, end] of [[0xffc46c, 0, 3.5], [0xffede0, -0.07, 2.7]] as const) {
      const geometry = new THREE.RingGeometry(0.88, 1.05, 64);
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.copy(at);
      mesh.position.y += 0.07;
      this.scene.add(mesh);
      this.bursts.push({ mesh, age: delay, life: 0.48, start: 0.25, end });
    }
  }

  update(delta: number): void {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      burst.age += delta;
      const progress = THREE.MathUtils.clamp(burst.age / burst.life, 0, 1);
      if (progress >= 1) {
        this.scene.remove(burst.mesh);
        burst.mesh.geometry.dispose();
        (burst.mesh.material as THREE.Material).dispose();
        this.bursts.splice(i, 1);
        continue;
      }
      const scale = THREE.MathUtils.lerp(burst.start, burst.end, progress);
      burst.mesh.scale.setScalar(scale);
      (burst.mesh.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - progress) ** 1.5;
    }
  }

  dispose(): void {
    for (const burst of this.bursts) {
      this.scene.remove(burst.mesh);
      burst.mesh.geometry.dispose();
      (burst.mesh.material as THREE.Material).dispose();
    }
    this.bursts.length = 0;
  }
}
