import * as THREE from "three";
import {
  GRAVITY,
  JUMP_HIT_DAMAGE,
  JUMP_HIT_REACH,
  JUMP_SPEED,
  KICK_DAMAGE,
  KICK_REACH,
  PLAYER_MAX_HP,
  PLAYER_REGEN,
  PLAYER_REGEN_DELAY,
  LOOK_AT_OFFSET_Y,
  MOVE_ACCEL,
  MOVE_DECEL,
  KICK_TIME_SCALE,
  ROLL_DISTANCE,
  ROLL_TIME_SCALE,
  STREET_BOUNDS,
  PLAYER_STAND_Y,
  PLAYER_START,
  PLAYER_TURN_SPEED,
  RUN_CLIP_SPEED,
  SPRINT_SPEED,
  WALK_CLIP_SPEED,
  WADE_SINK,
  WADE_SLOW,
  WALK_SPEED,
} from "./constants";
import type { SoundHook } from "./Audio";
import type { Input } from "./Input";
import type { WaterQuery } from "./Nature";

/** Metres travelled per footstep at the Mixamo run cadence. */
const STEP_LENGTH = 2.1;

const UP = new THREE.Vector3(0, 1, 0);

/** Radians to fold Mixamo T-pose arms down beside the torso. */
const ARM_DROP = THREE.MathUtils.degToRad(70);

const CLIP_ALIASES: ReadonlyArray<[string, string[]]> = [
  ["idle", ["idle", "stand", "breath", "waiting"]],
  ["walk", ["walk", "walking"]],
  ["run", ["run", "running", "sprint", "jog"]],
  ["jumphit", ["jumphit", "jumpattack", "jump-hit", "flyingkick"]],
  ["jump", ["runjump", "jump", "falling", "inair"]],
  ["roll", ["roll", "dodge", "tumble"]],
  ["kick", ["kick", "roundhouse", "roundhousekick"]],
  ["punch", ["punch", "jab", "strike"]],
];

export type PlayerAttack = {
  /** New id per strike so each strike damages an enemy at most once. */
  id: number;
  kind: "kick" | "jumphit";
  reach: number;
  damage: number;
};

/**
 * Player transform lives on `group` (origin at the feet).
 * Call `setModel()` after loading a fitted GLB; movement code stays the same.
 */
export class Player {
  readonly group = new THREE.Group();
  readonly velocity = new THREE.Vector3();

  private grounded = true;
  private sprinting = false;
  private rolling = false;
  private kicking = false;
  private jumpAttacking = false;
  private attackSerial = 0;
  private slamTimer = 0;
  private kickWhooshed = false;
  private kickEffectPlayed = false;
  private stepDistance = 0;
  private stepFoot = 0;
  onSound: SoundHook | null = null;
  onAttackEffect: ((kind: "kick" | "slam", at: THREE.Vector3, facing: number) => void) | null = null;
  private hp = PLAYER_MAX_HP;
  private invulnTimer = 0;
  private stunTimer = 0;
  private sinceHit = Infinity;
  /** Called whenever HP changes; `damaged` is true for hits, false for regen / respawn. */
  onHealthChange: ((hp: number, max: number, damaged: boolean) => void) | null = null;
  private collisionMeshes: THREE.Mesh[] = [];
  water: WaterQuery | null = null;
  /** 0 on land, 1 at full pond depth. */
  private wade = 0;
  private rippleTimer = 0;
  private model: THREE.Object3D | null = null;
  private modelBaseY = 0;
  private modelBaseRotationY = 0;
  private rollSpeed = 0;
  private readonly rollDir = new THREE.Vector3();

  private mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  /** Mixamo-style files often ship a single take instead of named clips. */
  private singleClip = false;
  private lastAnim = "idle";
  private clipRoot: THREE.Object3D | null = null;
  private readonly restPose: Array<{ bone: THREE.Bone; quat: THREE.Quaternion }> = [];

  private readonly moveIntent = new THREE.Vector3();
  private readonly desiredVelocity = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();
  private readonly cameraRight = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly collideDir = new THREE.Vector3();
  private readonly collideOrigin = new THREE.Vector3();
  private readonly collideNormal = new THREE.Vector3();

  constructor() {
    this.group.name = "Player";
    this.group.position.set(PLAYER_START.x, PLAYER_START.y, PLAYER_START.z);
  }

  /** Replace the capsule with a fitted character and bind locomotion clips. */
  setModel(
    model: THREE.Object3D,
    clips: THREE.AnimationClip[] = [],
    preferredClip: "idle" | "walk" | "run" | "jump" | "roll" | "kick" | "punch" | "jumphit" = "idle",
  ): void {
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.actions.clear();
    this.singleClip = false;
    this.lastAnim = "idle";
    this.rolling = false;
    this.kicking = false;
    this.jumpAttacking = false;
    this.restPose.length = 0;
    this.clipRoot = null;

    this.group.clear();
    this.group.add(model);
    this.model = model;
    this.modelBaseY = model.position.y;
    this.modelBaseRotationY = model.rotation.y;

    model.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
      if (obj instanceof THREE.SkinnedMesh) {
        obj.frustumCulled = false;
      }
    });

    const animRoot =
      model.userData.animRoot instanceof THREE.Object3D
        ? model.userData.animRoot
        : model;
    this.clipRoot = animRoot;
    const hasAuthoredIdle = clips.some((clip) =>
      /idle|stand|breath|waiting/i.test(clip.name),
    );
    if (!hasAuthoredIdle) this.bakeStandingRest(animRoot);
    this.bindClips(animRoot, clips, preferredClip);
    if (!this.actions.has("idle")) this.applyStandingRest();
  }

  /** Bind more Mixamo takes onto the already-visible skeleton (idle, jump, …). */
  addClips(clips: THREE.AnimationClip[]): void {
    const playable = clips.filter((clip) => clip.duration > 0.15 && clip.tracks.length > 0);
    if (playable.length === 0) return;

    if (!this.mixer) {
      if (this.clipRoot) this.bindClips(this.clipRoot, playable, "idle");
      return;
    }

    flattenRootMotion(playable);
    const mixer = this.mixer;
    for (const [name, aliases] of CLIP_ALIASES) {
      if (this.actions.has(name)) continue;
      const clip = findClip(playable, aliases);
      if (!clip) continue;
      const weight = name === "idle" && this.lastAnim === "idle" ? 1 : 0;
      this.attachClip(name, clip, weight);
      if (name === "idle") {
        this.restPose.length = 0;
        if (weight === 1) mixer.update(0);
      }
    }
    if (this.actions.size > 1) this.singleClip = false;
  }

  /** Fallback body if the hero FBX fails to load. */
  showPlaceholder(): void {
    if (this.group.children.length > 0) return;
    this.group.add(this.createPlaceholderMesh());
  }

  getLookAtPoint(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.group.position).setY(this.group.position.y + LOOK_AT_OFFSET_Y);
  }

  setCollisionMeshes(meshes: readonly THREE.Mesh[]): void {
    this.collisionMeshes = [...meshes];
  }

  /** A strike that has started (wind-up included), so enemies can react before it lands. */
  getAttackIntent(): { id: number; kind: "kick" | "jumphit" } | null {
    if (this.kicking) return { id: this.attackSerial, kind: "kick" };
    if (this.jumpAttacking) return { id: this.attackSerial, kind: "jumphit" };
    return null;
  }

  /** The strike currently able to deal damage, if any. */
  getActiveAttack(): PlayerAttack | null {
    if (this.kicking) {
      const kick = this.actions.get("kick");
      if (!kick) return null;
      const t = kick.time / kick.getClip().duration;
      if (t < 0.3 || t > 0.7) return null;
      return { id: this.attackSerial, kind: "kick", reach: KICK_REACH, damage: KICK_DAMAGE };
    }
    // Damage begins at impact, in sync with the visible ground shockwave.
    if (this.slamTimer > 0) {
      return {
        id: this.attackSerial,
        kind: "jumphit",
        reach: JUMP_HIT_REACH,
        damage: JUMP_HIT_DAMAGE,
      };
    }
    return null;
  }

  /** Snap facing toward a world XZ point (used to aim strikes at the nearest enemy). */
  faceTowards(x: number, z: number): void {
    if (this.rolling) return;
    const dx = x - this.group.position.x;
    const dz = z - this.group.position.z;
    if (dx * dx + dz * dz < 1e-4) return;
    this.group.rotation.y = Math.atan2(dx, dz);
  }

  getHealth(): { hp: number; max: number } {
    return { hp: this.hp, max: PLAYER_MAX_HP };
  }

  isDefeated(): boolean {
    return this.hp <= 0;
  }

  /** Returns false when the hit was dodged (rolling, i-frames, already down). */
  takeHit(damage: number, fromX: number, fromZ: number): boolean {
    if (this.rolling || this.invulnTimer > 0 || this.hp <= 0) return false;
    this.hp = Math.max(0, this.hp - damage);
    this.invulnTimer = 0.6;
    this.stunTimer = 0.22;
    this.sinceHit = 0;
    this.kicking = false;

    const dx = this.group.position.x - fromX;
    const dz = this.group.position.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    this.velocity.x = (dx / len) * 6.5;
    this.velocity.z = (dz / len) * 6.5;

    this.onSound?.("hit_player", this.group.position);
    this.onSound?.("player_hurt", this.group.position);
    this.onHealthChange?.(this.hp, PLAYER_MAX_HP, true);
    return true;
  }

  respawn(): void {
    this.group.position.set(PLAYER_START.x, PLAYER_START.y, PLAYER_START.z);
    this.group.rotation.set(0, Math.PI, 0);
    this.velocity.set(0, 0, 0);
    this.hp = PLAYER_MAX_HP;
    this.invulnTimer = 1.5;
    this.stunTimer = 0;
    this.sinceHit = Infinity;
    this.rolling = false;
    this.kicking = false;
    this.jumpAttacking = false;
    this.onHealthChange?.(this.hp, PLAYER_MAX_HP, false);
  }

  update(delta: number, input: Input, camera: THREE.Camera): void {
    this.updateCombatTimers(delta);
    this.applyLookRelativeMovement(delta, input, camera);
    this.applyJumpAndGravity(delta, input);
    this.group.position.addScaledVector(this.velocity, delta);
    this.constrainToGround();
    this.updateWater(delta);
    this.faceMoveDirection(delta);
    this.updateAnimation(delta);
    this.updateFootsteps(delta);
  }

  private updateWater(delta: number): void {
    const pos = this.group.position;
    this.wade = this.water?.depthAt(pos.x, pos.z) ?? 0;
    // Sink only near the ground so jumps out of the pond still clear the surface.
    const lift = THREE.MathUtils.clamp((pos.y - PLAYER_STAND_Y) / 0.5, 0, 1);
    if (this.model) this.model.position.y = this.modelBaseY - this.wade * WADE_SINK * (1 - lift);

    if (this.wade < 0.15 || !this.grounded) return;
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.rippleTimer -= delta;
    if (this.rippleTimer > 0) return;
    const moving = speed > 0.45;
    this.rippleTimer = moving ? 0.16 : 0.9;
    this.water?.ripple(pos.x, pos.z, moving ? 0.9 + speed * 0.06 : 0.6);
  }

  private updateFootsteps(delta: number): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (!this.grounded || this.rolling || speed < 0.45) {
      this.stepDistance = STEP_LENGTH * 0.6;
      return;
    }
    this.stepDistance += speed * delta;
    if (this.stepDistance < STEP_LENGTH) return;
    this.stepDistance -= STEP_LENGTH;
    this.stepFoot ^= 1;
    if (this.wade > 0.15) this.onSound?.(this.stepFoot ? "wade_1" : "wade_2", this.group.position);
    else this.onSound?.(this.stepFoot ? "footstep_1" : "footstep_2", this.group.position);
  }

  private updateCombatTimers(delta: number): void {
    this.slamTimer = Math.max(0, this.slamTimer - delta);
    this.invulnTimer = Math.max(0, this.invulnTimer - delta);
    this.stunTimer = Math.max(0, this.stunTimer - delta);
    this.sinceHit += delta;
    if (this.hp > 0 && this.hp < PLAYER_MAX_HP && this.sinceHit > PLAYER_REGEN_DELAY) {
      this.hp = Math.min(PLAYER_MAX_HP, this.hp + PLAYER_REGEN * delta);
      this.onHealthChange?.(this.hp, PLAYER_MAX_HP, false);
    }
  }

  /**
   * WASD is interpreted in the camera's yaw frame, not the player's.
   * Flattening look-direction onto XZ keeps movement horizontal on the ground plane.
   */
  private applyLookRelativeMovement(
    delta: number,
    input: Input,
    camera: THREE.Camera,
  ): void {
    const { x, z } = input.getMoveAxes();

    camera.getWorldDirection(this.cameraForward);
    this.cameraForward.y = 0;
    if (this.cameraForward.lengthSq() < 1e-6) {
      // Camera looking straight down/up — fall back to its yaw via the XZ right vector.
      this.cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
      this.cameraRight.y = 0;
      this.cameraRight.normalize();
      this.cameraForward.crossVectors(this.cameraRight, UP).normalize();
    } else {
      this.cameraForward.normalize();
      this.cameraRight.crossVectors(this.cameraForward, UP).normalize();
    }

    this.moveIntent
      .copy(this.cameraForward)
      .multiplyScalar(z)
      .addScaledVector(this.cameraRight, x);

    const hasInput = this.moveIntent.lengthSq() > 0;
    if (hasInput) this.moveIntent.normalize();

    const wantsRoll = input.consumeRoll();
    const wantsKick = input.consumeKick();

    if (this.stunTimer > 0 || this.hp <= 0) {
      const t = 1 - Math.exp(-6 * delta);
      this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, 0, t);
      this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, 0, t);
      this.sprinting = false;
      return;
    }

    if (
      !this.rolling &&
      !this.kicking &&
      this.grounded &&
      this.actions.has("roll") &&
      wantsRoll
    ) {
      this.rolling = true;
      if (hasInput) this.rollDir.copy(this.moveIntent);
      else {
        this.rollDir.set(
          Math.sin(this.group.rotation.y),
          0,
          Math.cos(this.group.rotation.y),
        );
      }
      const dur = this.actions.get("roll")?.getClip().duration ?? 1;
      this.rollSpeed =
        (ROLL_DISTANCE / Math.max(dur / ROLL_TIME_SCALE, 0.25)) * (1 - this.wade * WADE_SLOW);
      this.onSound?.(this.wade > 0.15 ? "splash" : "roll", this.group.position);
    }

    if (this.rolling) {
      this.sprinting = false;
      this.velocity.x = this.rollDir.x * this.rollSpeed;
      this.velocity.z = this.rollDir.z * this.rollSpeed;
      return;
    }

    if (
      !this.kicking &&
      !this.jumpAttacking &&
      this.grounded &&
      this.actions.has("kick") &&
      wantsKick
    ) {
      this.kicking = true;
      this.kickWhooshed = false;
      this.kickEffectPlayed = false;
      this.attackSerial++;
    }

    const speed = (input.isSprinting() ? SPRINT_SPEED : WALK_SPEED) * (1 - this.wade * WADE_SLOW);
    this.sprinting = hasInput && input.isSprinting();
    this.desiredVelocity.copy(this.moveIntent).multiplyScalar(hasInput ? speed : 0);

    const responsiveness = hasInput ? MOVE_ACCEL : MOVE_DECEL;
    const t = 1 - Math.exp(-responsiveness * delta);
    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, this.desiredVelocity.x, t);
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, this.desiredVelocity.z, t);
  }

  private applyJumpAndGravity(delta: number, input: Input): void {
    const wantsJumpHit = input.consumeJumpHit();
    if (this.stunTimer > 0 || this.hp <= 0) {
      input.consumeJump();
      this.velocity.y -= GRAVITY * delta;
      return;
    }
    if (
      wantsJumpHit &&
      !this.jumpAttacking &&
      !this.rolling &&
      !this.kicking &&
      this.actions.has("jumphit")
    ) {
      this.jumpAttacking = true;
      this.attackSerial++;
      if (this.grounded) {
        this.velocity.y = JUMP_SPEED;
        this.grounded = false;
        this.onSound?.("jump_whoosh", this.group.position);
      }
    } else if (
      this.grounded &&
      !this.rolling &&
      !this.kicking &&
      !this.jumpAttacking &&
      input.consumeJump()
    ) {
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
      this.onSound?.("jump_whoosh", this.group.position, 0.6);
    }

    this.velocity.y -= GRAVITY * delta;
  }

  private constrainToGround(): void {
    if (this.group.position.y <= PLAYER_STAND_Y && this.velocity.y <= 0) {
      this.group.position.y = PLAYER_STAND_Y;
      this.velocity.y = 0;
      if (!this.grounded) {
        if (this.wade > 0.15) {
          this.onSound?.("splash", this.group.position);
          const { x, z } = this.group.position;
          this.water?.ripple(x, z, this.jumpAttacking ? 2.6 : 1.8);
          this.water?.ripple(x, z, 1.1);
        } else {
          this.onSound?.(this.jumpAttacking ? "slam_impact" : "land", this.group.position);
        }
        if (this.jumpAttacking) this.onAttackEffect?.("slam", this.group.position, this.group.rotation.y);
      }
      this.grounded = true;
      if (this.jumpAttacking) this.slamTimer = 0.12;
      this.jumpAttacking = false;
    }
    this.group.position.x = THREE.MathUtils.clamp(
      this.group.position.x,
      STREET_BOUNDS.xMin,
      STREET_BOUNDS.xMax,
    );
    this.group.position.z = THREE.MathUtils.clamp(
      this.group.position.z,
      STREET_BOUNDS.zMin,
      STREET_BOUNDS.zMax,
    );
    this.resolveMeshWalls();
  }

  /**
   * Probe the actual triangle mesh, not bounding boxes, so gate holes and
   * courtyard space stay walkable.
   */
  private resolveMeshWalls(): void {
    if (this.collisionMeshes.length === 0) return;

    const radius = 0.4;
    const heights = [0.55, 1.15];
    const spokes = 12;
    const origin = this.collideOrigin;
    const dir = this.collideDir;
    const normal = this.collideNormal;
    const p = this.group.position;

    for (let pass = 0; pass < 2; pass++) {
      for (const height of heights) {
        origin.set(p.x, p.y + height, p.z);
        for (let i = 0; i < spokes; i++) {
          const angle = (i / spokes) * Math.PI * 2;
          dir.set(Math.cos(angle), 0, Math.sin(angle));
          this.raycaster.set(origin, dir);
          this.raycaster.near = 0;
          this.raycaster.far = radius;
          const hit = this.raycaster.intersectObjects(this.collisionMeshes, false)[0];
          if (!hit || hit.distance >= radius) continue;

          if (hit.face) {
            normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
          } else {
            normal.copy(dir).negate();
          }
          normal.y = 0;
          if (normal.lengthSq() < 1e-8) normal.copy(dir).negate();
          normal.normalize();

          const push = radius - hit.distance + 0.012;
          p.addScaledVector(normal, push);

          const into = this.velocity.x * normal.x + this.velocity.z * normal.z;
          if (into < 0) {
            this.velocity.x -= normal.x * into;
            this.velocity.z -= normal.z * into;
          }
        }
      }
    }
  }

  /** Rotate the group so local +Z faces the current horizontal velocity (GLTF-friendly). */
  private faceMoveDirection(delta: number): void {
    if (this.rolling) {
      this.group.rotation.y = Math.atan2(this.rollDir.x, this.rollDir.z);
      return;
    }

    const horizontalSpeedSq =
      this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    if (horizontalSpeedSq < 0.05) return;

    const targetYaw = Math.atan2(this.velocity.x, this.velocity.z);
    this.group.rotation.y = dampAngle(
      this.group.rotation.y,
      targetYaw,
      PLAYER_TURN_SPEED,
      delta,
    );
  }

  /**
   * Mixamo bind pose is a T-pose. Fold the arms down beside the body and
   * snapshot the skeleton so standing can restore it.
   */
  private bakeStandingRest(root: THREE.Object3D): void {
    this.restPose.length = 0;
    const holder: { skeleton?: THREE.Skeleton } = {};
    root.traverse((obj) => {
      if (obj instanceof THREE.SkinnedMesh) holder.skeleton = obj.skeleton;
    });
    const skeleton = holder.skeleton;
    if (!skeleton) return;

    skeleton.pose();
    this.group.updateMatrixWorld(true);

    const boneOf = (name: string) =>
      skeleton.bones.find((bone) => bone.name === name) ??
      skeleton.bones.find((bone) => bone.name.replace(/:/g, "") === name);

    // Local X is the Mixamo swing axis. Same-sign rotations fold both
    // T-pose arms in so they rest beside the body while standing.
    boneOf("mixamorigLeftArm")?.rotateX(ARM_DROP);
    boneOf("mixamorigRightArm")?.rotateX(ARM_DROP);

    for (const bone of skeleton.bones) {
      this.restPose.push({ bone, quat: bone.quaternion.clone() });
    }
  }

  private applyStandingRest(): void {
    for (const { bone, quat } of this.restPose) {
      bone.quaternion.copy(quat);
    }
  }

  private bindClips(
    root: THREE.Object3D,
    clips: THREE.AnimationClip[],
    preferredClip: "idle" | "walk" | "run" | "jump" | "roll" | "kick" | "punch" | "jumphit",
  ): void {
    const playable = clips.filter((clip) => clip.duration > 0.15 && clip.tracks.length > 0);
    if (playable.length === 0) return;

    flattenRootMotion(playable);
    this.mixer = new THREE.AnimationMixer(root);

    const byName = new Map<string, THREE.AnimationClip>();
    for (const [name, aliases] of CLIP_ALIASES) {
      const clip = findClip(playable, aliases);
      if (clip) byName.set(name, clip);
    }
    if (!byName.has("run") && preferredClip === "run" && playable[0]) {
      byName.set("run", playable[0]);
    }

    if (byName.size === 0 && playable[0]) {
      this.playSingleClip(playable[0], preferredClip);
      return;
    }

    for (const [name, clip] of byName) {
      this.attachClip(name, clip, name === "idle" ? 1 : 0);
    }

    this.mixer.update(0);
  }

  private attachClip(name: string, clip: THREE.AnimationClip, weight = 0): void {
    if (!this.mixer || this.actions.has(name)) return;
    const action = this.mixer.clipAction(clip);
    action.enabled = true;
    if (name === "jump" || name === "roll" || name === "kick" || name === "punch" || name === "jumphit") {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
    }
    action.setEffectiveWeight(weight);
    action.play();
    this.actions.set(name, action);
  }

  private playSingleClip(clip: THREE.AnimationClip, name: string): void {
    if (!this.mixer) return;
    this.singleClip = true;
    const action = this.mixer.clipAction(clip);
    action.enabled = true;
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.setEffectiveWeight(0);
    action.play();
    action.paused = true;
    this.actions.set(name, action);
  }

  private updateAnimation(delta: number): void {
    if (!this.mixer || this.actions.size === 0) {
      this.applyStandingRest();
      return;
    }

    if (this.singleClip) {
      const action =
        this.actions.get("run") ??
        this.actions.get("walk") ??
        this.actions.get("idle") ??
        [...this.actions.values()][0];
      if (action) {
        const speed = Math.hypot(this.velocity.x, this.velocity.z);
        const moving = this.grounded && speed > 0.45;
        if (moving) {
          action.paused = false;
          action.setEffectiveWeight(1);
          action.timeScale = this.sprinting ? 1.2 : 0.95;
          this.mixer.update(delta);
        } else {
          action.setEffectiveWeight(0);
          action.paused = true;
          this.mixer.update(delta);
          this.applyStandingRest();
        }
      } else {
        this.mixer.update(delta);
      }
      return;
    }

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    let target = "idle";
    if (this.rolling && this.actions.has("roll")) target = "roll";
    else if (this.jumpAttacking && this.actions.has("jumphit")) target = "jumphit";
    else if (this.kicking && this.actions.has("kick")) target = "kick";
    else if (!this.grounded) target = this.actions.has("jump") ? "jump" : "idle";
    else if (speed > 0.45) {
      if (this.sprinting && this.actions.has("run")) target = "run";
      else if (this.actions.has("walk")) target = "walk";
      else if (this.actions.has("run")) target = "run";
    }
    if (!this.actions.has(target)) target = "idle";

    const jump = this.actions.get("jump");
    if (target === "jump" && this.lastAnim !== "jump" && jump) {
      jump.reset();
      jump.play();
      jump.setEffectiveWeight(1);
      for (const [name, action] of this.actions) {
        if (name !== "jump") action.setEffectiveWeight(0);
      }
      const airTime = (2 * JUMP_SPEED) / GRAVITY;
      jump.timeScale = THREE.MathUtils.clamp(jump.getClip().duration / airTime, 0.85, 1.8);
    }

    const jumphit = this.actions.get("jumphit");
    if (target === "jumphit" && this.lastAnim !== "jumphit" && jumphit) {
      jumphit.reset();
      jumphit.play();
      jumphit.setEffectiveWeight(1);
      for (const [name, action] of this.actions) {
        if (name !== "jumphit") action.setEffectiveWeight(0);
      }
      const airTime = (2 * JUMP_SPEED) / GRAVITY;
      jumphit.timeScale = THREE.MathUtils.clamp(
        jumphit.getClip().duration / airTime,
        0.85,
        1.8,
      );
    }

    const roll = this.actions.get("roll");
    if (target === "roll" && this.lastAnim !== "roll" && roll) {
      roll.reset();
      roll.timeScale = ROLL_TIME_SCALE;
      roll.play();
      roll.setEffectiveWeight(1);
      for (const [name, action] of this.actions) {
        if (name !== "roll") action.setEffectiveWeight(0);
      }
    }

    const kick = this.actions.get("kick");
    if (target === "kick" && this.lastAnim !== "kick" && kick) {
      kick.reset();
      kick.timeScale = KICK_TIME_SCALE;
      kick.play();
      kick.setEffectiveWeight(1);
      for (const [name, action] of this.actions) {
        if (name !== "kick") action.setEffectiveWeight(0);
      }
    }

    const fadeRate =
      target === "jump" ||
      this.lastAnim === "jump" ||
      target === "roll" ||
      this.lastAnim === "roll" ||
      target === "kick" ||
      this.lastAnim === "kick" ||
      target === "jumphit" ||
      this.lastAnim === "jumphit"
        ? 18
        : 10;
    const fade = 1 - Math.exp(-fadeRate * delta);
    for (const [name, action] of this.actions) {
      const next = name === target ? 1 : 0;
      action.setEffectiveWeight(
        THREE.MathUtils.lerp(action.getEffectiveWeight(), next, fade),
      );
    }
    this.lastAnim = target;

    const walk = this.actions.get("walk");
    const run = this.actions.get("run");
    if (walk) {
      walk.timeScale = THREE.MathUtils.clamp(speed / WALK_CLIP_SPEED, 0.85, 2.2);
    }
    if (run) {
      run.timeScale = THREE.MathUtils.clamp(speed / RUN_CLIP_SPEED, 0.9, 1.55);
    }

    this.mixer.update(delta);
    if (this.rolling && roll) {
      const dur = roll.getClip().duration;
      if (!roll.isRunning() || roll.time >= dur * 0.92) this.rolling = false;
    }
    if (this.kicking && kick) {
      const dur = kick.getClip().duration;
      if (!this.kickWhooshed && kick.time >= dur * 0.18) {
        this.kickWhooshed = true;
        this.onSound?.("kick_whoosh", this.group.position);
      }
      if (!this.kickEffectPlayed && kick.time >= dur * 0.27) {
        this.kickEffectPlayed = true;
        this.onAttackEffect?.("kick", this.group.position, this.group.rotation.y);
      }
      if (this.model) {
        const t = THREE.MathUtils.smoothstep(kick.time / dur, 0.12, 0.82);
        this.model.rotation.y = this.modelBaseRotationY + t * Math.PI * 2;
      }
      if (!kick.isRunning() || kick.time >= dur * 0.9) this.kicking = false;
    }
    if (!this.kicking && this.model) this.model.rotation.y = this.modelBaseRotationY;
    if (target === "idle" && !this.actions.has("idle")) this.applyStandingRest();
  }

  private createPlaceholderMesh(): THREE.Group {
    const visual = new THREE.Group();
    visual.name = "PlayerPlaceholder";

    const ninjaMat = new THREE.MeshStandardMaterial({
      color: 0x1f3d32,
      roughness: 0.55,
      metalness: 0.08,
    });
    const wrapMat = new THREE.MeshStandardMaterial({
      color: 0x0e1a16,
      roughness: 0.7,
      metalness: 0.04,
    });

    // Capsule is Y-aligned and centered on its origin. Offset so feet sit near world y = 0
    // while the player group stays at (0, 1, 0) as requested.
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.72, 6, 12), ninjaMat);
    body.position.y = -0.18;
    body.castShadow = true;
    body.receiveShadow = true;

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), wrapMat);
    head.position.y = 0.52;
    head.castShadow = true;

    const sash = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.045, 8, 20), wrapMat);
    sash.rotation.x = Math.PI / 2;
    sash.position.y = -0.12;
    sash.castShadow = true;

    visual.add(body, head, sash);
    // Capsule was authored for a hip-height origin; group origin is now the feet.
    visual.position.y = 1;
    return visual;
  }
}

function findClip(
  clips: THREE.AnimationClip[],
  aliases: string[],
): THREE.AnimationClip | undefined {
  const lowered = clips.map((clip) => ({
    clip,
    name: clip.name.toLowerCase(),
  }));
  for (const alias of aliases) {
    const exact = lowered.find((entry) => entry.name === alias);
    if (exact) return exact.clip;
  }
  for (const alias of aliases) {
    const partial = lowered.find((entry) => {
      if (!entry.name.includes(alias)) return false;
      // "jumphit" contains "jump" — don't steal the aerial attack as the run-jump.
      if (alias === "jump" && /(hit|attack|kick)/.test(entry.name)) return false;
      return true;
    });
    if (partial) return partial.clip;
  }
  return undefined;
}

/** The exported GLB rig is X-rotated: local Z is vertical, X/Y are ground axes. */
export function flattenRootMotion(clips: THREE.AnimationClip[]): void {
  for (const clip of clips) {
    for (const track of clip.tracks) {
      if (!track.name.endsWith("Hips.position")) continue;
      const values = track.values;
      const groundX = values[0];
      const groundY = values[1];
      for (let i = 0; i < values.length; i += 3) {
        values[i] = groundX;
        values[i + 1] = groundY;
      }
    }
  }
}

/** Shortest-path angle damping, frame-rate independent. */
function dampAngle(
  current: number,
  target: number,
  lambda: number,
  dt: number,
): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return current + diff * (1 - Math.exp(-lambda * dt));
}
