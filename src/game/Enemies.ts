import * as THREE from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import {
  ENEMY_AGGRO_RANGE,
  ENEMY_ATTACK_RANGE,
  ENEMY_CIRCLE_RADIUS,
  ENEMY_DAMAGE,
  ENEMY_FIRST_WAVE_DELAY,
  ENEMY_HEIGHT,
  ENEMY_HP,
  ENEMY_LEAP_DAMAGE,
  ENEMY_MAX_ATTACKERS,
  ENEMY_MAX_WAVE_SIZE,
  ENEMY_REACH,
  ENEMY_SPEED,
  ENEMY_WAVE_BREAK,
  GRAVITY,
  JUMP_SPEED,
  ROLL_DISTANCE,
  ROLL_TIME_SCALE,
  RUN_CLIP_SPEED,
  STREET_BOUNDS,
  WADE_SINK,
  WADE_SLOW,
} from "./constants";
import type { SoundHook } from "./Audio";
import type { WaterQuery } from "./Nature";
import { flattenRootMotion, type Player } from "./Player";

type EnemyClip = "idle" | "run" | "punch" | "kick" | "roll" | "jump" | "jumphit";
type EnemyState =
  | "idle"
  | "chase"
  | "circle"
  | "attack"
  | "leap"
  | "evade"
  | "recover"
  | "hurt"
  | "dead";

const CLIP_NAMES: readonly EnemyClip[] = ["idle", "run", "punch", "kick", "roll", "jump", "jumphit"];
const ONE_SHOT: ReadonlySet<EnemyClip> = new Set(["punch", "kick", "roll", "jump", "jumphit"]);

/** Beside and along the shrine path, clear of the houses. */
const SPAWN_POINTS: ReadonlyArray<[number, number]> = [
  [-2.5, -12],
  [2.5, -17],
  [0, -22],
  [-3.5, -24],
  [3.5, -8],
];

const HERO_HEIGHT_REF = 1.7;
const AIR_TIME = (2 * JUMP_SPEED) / GRAVITY;

type Archetype = "brawler" | "acrobat" | "duelist";

/** Per-enemy personality. All chances are 0–1 per decision. */
type Traits = {
  archetype: Archetype;
  speed: number;
  /** Divides attack cooldowns: higher = attacks again sooner. */
  aggression: number;
  /** Chance to dodge a strike aimed at them. */
  dodge: number;
  /** Chance to open with a leaping slam when closing to mid-range. */
  leap: number;
  /** Otherwise, chance to close the gap with a forward roll into a strike. */
  rollIn: number;
  /** Chance to chain a second strike. */
  combo: number;
  /** Chance to roll or hop back out after a strike instead of standing there. */
  retreat: number;
};

const ARCHETYPES: Record<Archetype, Omit<Traits, "archetype">> = {
  brawler: { speed: 0.95, aggression: 1.25, dodge: 0.3, leap: 0.3, rollIn: 0.4, combo: 0.6, retreat: 0.15 },
  acrobat: { speed: 1.12, aggression: 0.95, dodge: 0.7, leap: 0.7, rollIn: 0.5, combo: 0.25, retreat: 0.55 },
  duelist: { speed: 1.0, aggression: 1.05, dodge: 0.5, leap: 0.45, rollIn: 0.4, combo: 0.4, retreat: 0.35 },
};

function rollTraits(wave: number): Traits {
  const kinds = Object.keys(ARCHETYPES) as Archetype[];
  const archetype = kinds[Math.floor(Math.random() * kinds.length)];
  const base = ARCHETYPES[archetype];
  const level = Math.min(Math.max(wave - 1, 0), 6);
  const jitter = () => 0.9 + Math.random() * 0.2;
  return {
    archetype,
    speed: ENEMY_SPEED * base.speed * jitter() * (1 + level * 0.03),
    aggression: base.aggression * jitter() * (1 + level * 0.08),
    dodge: Math.min(base.dodge * jitter() + level * 0.05, 0.85),
    leap: Math.min(base.leap * jitter() + level * 0.04, 0.85),
    rollIn: base.rollIn * jitter(),
    combo: Math.min(base.combo * jitter() + level * 0.05, 0.85),
    retreat: base.retreat * jitter(),
  };
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/**
 * Red Clan ninjas: clones of the hero's Mixamo rig with a crimson outfit.
 * Sharing the skeleton means every Mixamo take the hero loads also drives them.
 */
export class EnemyManager {
  private template: THREE.Object3D | null = null;
  private readonly clips = new Map<EnemyClip, THREE.AnimationClip>();
  private readonly enemies: Enemy[] = [];
  private collisionMeshes: THREE.Mesh[] = [];
  water: WaterQuery | null = null;
  private calmTimer = 0;
  private wave = 0;
  private lastAttackId = -1;
  private lastIntentId = -1;
  private kills = 0;
  private started = false;

  onKill: ((kills: number) => void) | null = null;
  onWave: ((wave: number) => void) | null = null;
  onSound: SoundHook | null = null;
  private readonly emit: SoundHook = (name, at, volume) => this.onSound?.(name, at, volume);

  constructor(private readonly scene: THREE.Scene) {}

  /** Pass the fitted hero's anim root before the player starts animating it. */
  setTemplate(heroRoot: THREE.Object3D): void {
    this.template = cloneSkinned(heroRoot);
    this.template.scale.multiplyScalar(ENEMY_HEIGHT / HERO_HEIGHT_REF);
    this.template.position.multiplyScalar(ENEMY_HEIGHT / HERO_HEIGHT_REF);
  }

  addClips(clips: readonly THREE.AnimationClip[]): void {
    const fresh: THREE.AnimationClip[] = [];
    for (const clip of clips) {
      const name = CLIP_NAMES.find((n) => clip.name === n);
      if (!name || this.clips.has(name)) continue;
      this.clips.set(name, clip);
      fresh.push(clip);
    }
    flattenRootMotion(fresh);
    for (const enemy of this.enemies) enemy.bindClips(this.clips);
  }

  setCollisionMeshes(meshes: readonly THREE.Mesh[]): void {
    this.collisionMeshes = [...meshes];
  }

  getKills(): number {
    return this.kills;
  }

  /** True while any enemy is fighting — drives the battle music. */
  isInCombat(): boolean {
    return this.enemies.some((enemy) => enemy.isEngaged());
  }

  update(delta: number, player: Player): void {
    if (!this.started) {
      // Wait for idle so they never appear in the Mixamo T-pose.
      if (!this.template || !this.clips.has("idle") || !this.clips.has("run")) return;
      this.started = true;
      this.calmTimer = ENEMY_FIRST_WAVE_DELAY;
    }

    this.warnOfPlayerAttack(player);
    this.applyPlayerAttack(player);
    this.assignAttackTokens(player);

    for (const enemy of this.enemies) enemy.update(delta, player, this.collisionMeshes, this.water);
    this.separate(player);

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      if (!enemy.isGone()) continue;
      enemy.dispose(this.scene);
      this.enemies.splice(i, 1);
    }

    if (this.enemies.some((e) => !e.isDead())) return;
    this.calmTimer -= delta;
    if (this.calmTimer > 0) return;
    this.calmTimer = ENEMY_WAVE_BREAK;
    this.spawnWave(player.group.position);
  }

  /** Called after the player respawns so the fight restarts at a distance. */
  resetAggro(): void {
    for (const enemy of this.enemies) enemy.calmDown();
  }

  /** Each wave is one bigger than the last, up to ENEMY_MAX_WAVE_SIZE. */
  private spawnWave(playerPos: THREE.Vector3): void {
    this.wave++;
    const size = Math.min(1 + this.wave, ENEMY_MAX_WAVE_SIZE, SPAWN_POINTS.length);
    const farthestFirst = [...SPAWN_POINTS].sort(
      (a, b) =>
        Math.hypot(b[0] - playerPos.x, b[1] - playerPos.z) -
        Math.hypot(a[0] - playerPos.x, a[1] - playerPos.z),
    );
    for (let i = 0; i < size; i++) this.spawn(farthestFirst[i]);
    this.onWave?.(this.wave);
  }

  private spawn(point: readonly [number, number]): void {
    if (!this.template) return;
    const enemy = new Enemy(
      cloneSkinned(this.template),
      this.clips,
      this.emit,
      rollTraits(this.wave),
    );
    enemy.group.position.set(point[0], 0, point[1]);
    enemy.group.rotation.y = Math.random() * Math.PI * 2;
    this.scene.add(enemy.group);
    this.enemies.push(enemy);
  }

  /** The closest few fighters press the attack; everyone else circles and waits. */
  private assignAttackTokens(player: Player): void {
    const p = player.group.position;
    // Wave 1: one at a time; then two; three from wave 4.
    const maxAttackers = Math.min(1 + Math.floor(this.wave / 2), ENEMY_MAX_ATTACKERS + 1);
    const fighters = this.enemies
      .filter((e) => e.isEngaged())
      .sort((a, b) => a.distanceTo(p) - b.distanceTo(p));
    fighters.forEach((enemy, i) => {
      enemy.hasToken = i < maxAttackers;
    });
  }

  /** A strike just started: nearby enemies may try to dodge it. */
  private warnOfPlayerAttack(player: Player): void {
    const intent = player.getAttackIntent();
    if (!intent || intent.id === this.lastIntentId) return;
    this.lastIntentId = intent.id;
    const p = player.group.position;
    const range = intent.kind === "kick" ? 3.4 : 5;
    for (const enemy of this.enemies) {
      if (enemy.isDead() || enemy.distanceTo(p) > range) continue;
      enemy.considerDodge(intent.kind, p);
    }
  }

  private applyPlayerAttack(player: Player): void {
    const attack = player.getActiveAttack();
    if (!attack) return;
    const p = player.group.position;

    if (attack.id !== this.lastAttackId) {
      this.lastAttackId = attack.id;
      const target = this.nearestAlive(p, 3.2);
      if (target) player.faceTowards(target.group.position.x, target.group.position.z);
    }

    for (const enemy of this.enemies) {
      if (enemy.isDead() || enemy.lastHitBy === attack.id) continue;
      const dx = enemy.group.position.x - p.x;
      const dz = enemy.group.position.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > attack.reach) continue;
      // A spinning roundhouse and a ground shockwave both sweep the full circle.
      if (Math.abs(p.y - enemy.group.position.y) > 1.6) continue;

      const result = enemy.hurt(attack.damage, p.x, p.z);
      if (result === "dodged") continue;
      enemy.lastHitBy = attack.id;
      if (result === "killed") {
        this.kills++;
        this.onKill?.(this.kills);
      }
    }
  }

  private nearestAlive(pos: THREE.Vector3, maxDist: number): Enemy | null {
    let best: Enemy | null = null;
    let bestDist = maxDist;
    for (const enemy of this.enemies) {
      if (enemy.isDead()) continue;
      const d = enemy.distanceTo(pos);
      if (d < bestDist) {
        bestDist = d;
        best = enemy;
      }
    }
    return best;
  }

  /** Keep bodies from overlapping each other and the player. */
  private separate(player: Player): void {
    const p = player.group.position;
    for (let i = 0; i < this.enemies.length; i++) {
      const a = this.enemies[i];
      if (a.isDead()) continue;
      const ap = a.group.position;

      const px = ap.x - p.x;
      const pz = ap.z - p.z;
      const pd = Math.hypot(px, pz);
      if (pd < 0.85 && pd > 1e-4 && Math.abs(p.y - ap.y) < 1.2) {
        ap.x += (px / pd) * (0.85 - pd);
        ap.z += (pz / pd) * (0.85 - pd);
      }

      for (let j = i + 1; j < this.enemies.length; j++) {
        const b = this.enemies[j];
        if (b.isDead()) continue;
        const bp = b.group.position;
        const dx = bp.x - ap.x;
        const dz = bp.z - ap.z;
        const d = Math.hypot(dx, dz);
        if (d >= 0.9 || d < 1e-4) continue;
        const push = (0.9 - d) / 2;
        ap.x -= (dx / d) * push;
        ap.z -= (dz / d) * push;
        bp.x += (dx / d) * push;
        bp.z += (dz / d) * push;
      }
    }
  }
}

class Enemy {
  readonly group = new THREE.Group();
  lastHitBy = -1;
  /** Set by the manager: allowed to close in and strike this frame. */
  hasToken = false;

  /** Pivot at the feet for hit leans and the death fall; the FBX root stays untouched. */
  private readonly body: THREE.Group;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<EnemyClip, THREE.AnimationAction>();
  private readonly ornaments: THREE.Mesh[] = [];
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly velocity = new THREE.Vector3();
  private readonly moveDir = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly rayOrigin = new THREE.Vector3();
  private readonly rayDir = new THREE.Vector3();
  private readonly rayNormal = new THREE.Vector3();

  private hp = ENEMY_HP;
  private state: EnemyState = "idle";
  private stateTime = 0;
  private current: EnemyClip = "idle";
  private flash = 0;
  private lean = 0;

  private cooldown = rand(0.6, 1.6);
  private leapCooldown = rand(0.3, 1.2);
  private approachDecided = false;
  private decisionTimer = rand(1.5, 3.5);
  private attackProgress = 0;
  private dodgeCooldown = 0;
  private attackClip: EnemyClip = "punch";
  private attackLanded = false;
  private comboUsed = false;
  private whooshed = false;
  private fellDown = false;
  private wade = 0;
  private rippleTimer = 0;
  private wasAirborne = false;

  private playerRef: Player | null = null;
  /** Fresh wave members hunt the player down from anywhere until they first reach them. */
  private alerted = true;
  private pendingDodge = -1;
  private readonly lastThreat = new THREE.Vector3();
  private evadeKind: "roll" | "hop" | "rollIn" = "roll";
  private evadeDuration = 0;
  private recoverDuration = 0.6;
  private hitStreak = 0;
  private lastHitAt = -10;
  private breakAway = false;
  private clock = 0;

  private strafeSign = Math.random() < 0.5 ? -1 : 1;
  private strafeTimer = rand(1.5, 3.5);
  private readonly zigPhase = Math.random() * Math.PI * 2;
  private readonly zigFreq = rand(2.2, 3.6);
  private readonly circleRadius = ENEMY_CIRCLE_RADIUS * rand(0.85, 1.15);

  constructor(
    body: THREE.Object3D,
    clips: ReadonlyMap<EnemyClip, THREE.AnimationClip>,
    private readonly sound: SoundHook,
    private readonly traits: Traits,
  ) {
    this.group.name = `RedClan_${traits.archetype}`;
    this.body = new THREE.Group();
    this.body.add(body);
    this.group.add(this.body);

    body.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.castShadow = true;
      obj.receiveShadow = true;
      if (obj instanceof THREE.SkinnedMesh) obj.frustumCulled = false;
      const slots = Array.isArray(obj.material) ? obj.material : [obj.material];
      const tinted = slots.map((slot) => this.tint(slot));
      obj.material = Array.isArray(obj.material) ? tinted : tinted[0];
    });
    this.addRoleLook();

    this.mixer = new THREE.AnimationMixer(body);
    this.bindClips(clips);
  }

  bindClips(clips: ReadonlyMap<EnemyClip, THREE.AnimationClip>): void {
    for (const [name, clip] of clips) {
      if (this.actions.has(name)) continue;
      const action = this.mixer.clipAction(clip);
      if (ONE_SHOT.has(name)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.time = Math.random() * clip.duration;
      }
      action.setEffectiveWeight(name === this.current ? 1 : 0);
      action.play();
      this.actions.set(name, action);
    }
    this.mixer.update(0);
  }

  distanceTo(p: THREE.Vector3): number {
    return Math.hypot(this.group.position.x - p.x, this.group.position.z - p.z);
  }

  isDead(): boolean {
    return this.state === "dead";
  }

  isEngaged(): boolean {
    return this.state !== "idle" && this.state !== "dead";
  }

  /** Fully faded out after dying; safe to remove. */
  isGone(): boolean {
    return this.state === "dead" && this.stateTime > 4.2;
  }

  calmDown(): void {
    if (this.state === "dead") return;
    this.setState("idle");
    this.cooldown = 1.5;
    this.pendingDodge = -1;
    this.alerted = false;
  }

  /** The player started a strike nearby; maybe react after a human-ish delay. */
  considerDodge(kind: "kick" | "jumphit", from: THREE.Vector3): void {
    if (this.pendingDodge >= 0 || this.dodgeCooldown > 0) return;
    if (!this.canEvadeNow()) return;
    if (!this.actions.has("roll") && !this.actions.has("jump")) return;
    if (Math.random() > this.traits.dodge) return;
    // Kicks land fast, so reactions must be quick; the jump attack gives more warning.
    this.pendingDodge = kind === "kick" ? rand(0.04, 0.14) : rand(0.15, 0.35);
    this.lastThreat.copy(from);
  }

  hurt(damage: number, fromX: number, fromZ: number): "hit" | "killed" | "dodged" {
    if (this.state === "dead") return "dodged";
    if (this.state === "evade" && this.evadeKind !== "rollIn") return "dodged";

    this.hp -= damage;
    this.flash = 1;
    this.pendingDodge = -1;

    this.hitStreak = this.clock - this.lastHitAt < 1.3 ? this.hitStreak + 1 : 1;
    this.lastHitAt = this.clock;

    const dx = this.group.position.x - fromX;
    const dz = this.group.position.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    const knock = damage > 1 ? 8.5 : 6;
    this.velocity.x = (dx / len) * knock;
    this.velocity.z = (dz / len) * knock;
    this.group.rotation.y = Math.atan2(-dx, -dz);
    this.sound("hit_kick", this.group.position, damage > 1 ? 1 : 0.85);

    if (this.hp <= 0) {
      this.sound("enemy_death", this.group.position);
      this.setState("dead");
      return "killed";
    }
    this.sound("enemy_hurt", this.group.position);
    this.lean = damage > 1 ? 0.55 : 0.35;
    // Getting juggled? Sometimes they break out with a quick evade instead of taking a third hit.
    this.breakAway = this.hitStreak >= 2 && Math.random() < 0.35 + this.traits.dodge * 0.5;
    this.setState("hurt");
    return "hit";
  }

  update(
    delta: number,
    player: Player,
    walls: readonly THREE.Mesh[],
    water: WaterQuery | null,
  ): void {
    this.playerRef = player;
    this.clock += delta;
    this.stateTime += delta;
    this.cooldown -= delta;
    this.leapCooldown -= delta;
    this.dodgeCooldown -= delta;
    this.flash = Math.max(0, this.flash - delta * 4);
    for (const mat of this.materials) {
      mat.emissive.setRGB(this.flash * 0.9, this.flash * 0.12, this.flash * 0.08);
    }

    if (this.state === "dead") {
      this.updateDeath(delta);
      return;
    }

    const p = player.group.position;
    const pos = this.group.position;
    const dx = p.x - pos.x;
    const dz = p.z - pos.z;
    const dist = Math.hypot(dx, dz);
    const playerDown = player.isDefeated();

    if (this.pendingDodge >= 0) {
      this.pendingDodge -= delta;
      if (this.pendingDodge < 0) this.startEvade(this.lastThreat, false);
    }

    let desiredSpeed = 0;
    let anim: EnemyClip = "idle";
    let steer = true;
    this.moveDir.set(0, 0, 0);

    switch (this.state) {
      case "idle":
        if (!playerDown && (this.alerted || dist < ENEMY_AGGRO_RANGE) && this.cooldown <= 0) {
          this.setState("chase");
        }
        break;

      case "chase":
      case "circle": {
        if (dist < ENEMY_AGGRO_RANGE) this.alerted = false;
        if (playerDown || (!this.alerted && dist > ENEMY_AGGRO_RANGE * 1.6)) {
          this.setState("idle");
          break;
        }
        if (this.tryLeapOrRollIn(dist, delta)) break;

        if (this.state === "chase" && !this.hasToken && dist < this.circleRadius + 1.5) {
          this.setState("circle");
        } else if (this.state === "circle" && this.hasToken) {
          this.setState("chase");
        }

        if (this.state === "chase") {
          if (dist < ENEMY_ATTACK_RANGE) {
            this.turnToward(dx, dz, delta, 10);
            steer = false;
            if (this.cooldown <= 0) this.startAttack(false);
          } else {
            // Zig-zag on the approach so they're harder to line up a kick on.
            const inv = 1 / Math.max(dist, 1e-3);
            const weave = dist > 3 ? Math.sin(this.clock * this.zigFreq + this.zigPhase) * 0.55 : 0;
            this.moveDir.set(dx * inv - dz * inv * weave, 0, dz * inv + dx * inv * weave);
            desiredSpeed = this.traits.speed;
            anim = "run";
          }
        } else {
          this.updateCircle(dx, dz, dist, delta);
          desiredSpeed = this.traits.speed * 0.55;
          anim = "run";
        }
        break;
      }

      case "attack":
        steer = false;
        anim = this.attackClip;
        this.updateAttack(player, dx, dz, dist, delta);
        break;

      case "leap":
        steer = false;
        anim = "jumphit";
        if (pos.y <= 0 && this.velocity.y <= 0 && this.stateTime > 0.1) {
          this.sound(this.wade > 0.15 ? "splash" : "slam_impact", pos, 0.9);
          if (dist < 2.1 && p.y < 1.0) player.takeHit(ENEMY_LEAP_DAMAGE, pos.x, pos.z);
          this.recoverDuration = rand(0.55, 0.85);
          this.velocity.x *= 0.2;
          this.velocity.z *= 0.2;
          this.setState("recover");
        }
        break;

      case "evade":
        steer = false;
        anim = this.evadeKind === "hop" ? "jump" : "roll";
        if (
          this.evadeKind === "hop"
            ? pos.y <= 0 && this.velocity.y <= 0 && this.stateTime > 0.1
            : this.stateTime >= this.evadeDuration
        ) {
          const rolledIn = this.evadeKind === "rollIn";
          this.setState("chase");
          // Coming out of an evade is a good moment to counter.
          this.cooldown = rolledIn || Math.random() < 0.5 ? 0 : rand(0.3, 0.7) / this.traits.aggression;
        }
        break;

      case "recover":
        steer = false;
        this.turnToward(dx, dz, delta, 3);
        if (this.stateTime > this.recoverDuration) this.setState("chase");
        break;

      case "hurt":
        steer = false;
        if (this.breakAway && this.stateTime > 0.18) {
          this.breakAway = false;
          this.startEvade(p, true);
        } else if (this.stateTime > 0.45) {
          this.cooldown = Math.max(this.cooldown, 0.35);
          this.setState("chase");
        }
        break;
    }

    this.integrate(delta, desiredSpeed * (1 - this.wade * WADE_SLOW), steer);
    this.resolveWalls(walls);
    this.updateWater(delta, water);

    this.lean = Math.max(0, this.lean - delta * 1.4);
    this.body.rotation.x = -this.lean;

    const run = this.actions.get("run");
    if (run) {
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      run.timeScale = THREE.MathUtils.clamp(speed / RUN_CLIP_SPEED, 0.55, 1.4);
    }
    this.blendTo(anim, delta);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.mixer.stopAllAction();
    // Geometry and textures are shared with the hero; only the tinted materials are ours.
    for (const mat of this.materials) mat.dispose();
    for (const mesh of this.ornaments) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }

  /** Strafe around the player at a personal radius, switching direction now and then. */
  private updateCircle(dx: number, dz: number, dist: number, delta: number): void {
    this.strafeTimer -= delta;
    if (this.strafeTimer <= 0) {
      this.strafeSign *= -1;
      this.strafeTimer = rand(1.4, 3.4);
    }
    const inv = 1 / Math.max(dist, 1e-3);
    const tx = -dz * inv * this.strafeSign;
    const tz = dx * inv * this.strafeSign;
    const radial = THREE.MathUtils.clamp((dist - this.circleRadius) * 0.8, -1, 1);
    this.moveDir.set(tx + dx * inv * radial, 0, tz + dz * inv * radial);
  }

  /**
   * Mid-range gap closers: a leaping slam, or a forward roll straight into a strike.
   * An attacker decides once per approach; circlers reconsider every few seconds.
   */
  private tryLeapOrRollIn(dist: number, delta: number): boolean {
    if (dist < 2.5 || dist > 9.5) {
      this.approachDecided = false;
      return false;
    }
    if (this.leapCooldown > 0 || dist < 3.2 || dist > 8.5) return false;

    let decide = false;
    if (this.hasToken) {
      decide = !this.approachDecided;
      this.approachDecided = true;
    } else {
      this.decisionTimer -= delta;
      if (this.decisionTimer <= 0) {
        this.decisionTimer = rand(2.5, 5);
        decide = true;
      }
    }
    if (!decide) return false;

    const canLeap = this.actions.has("jumphit");
    const canRoll = this.actions.has("roll") && dist < 6.5;
    if (canLeap && Math.random() < this.traits.leap) {
      this.leapCooldown = rand(3, 5.5);
      this.startLeap();
      return true;
    }
    if (canRoll && Math.random() < this.traits.rollIn) {
      this.leapCooldown = rand(2, 4);
      this.startRollIn();
      return true;
    }
    return false;
  }

  private startLeap(): void {
    // Aim a little ahead of where the player is heading.
    const target = this.playerRef;
    if (!target) return;
    const pos = this.group.position;
    const tx = target.group.position.x + target.velocity.x * AIR_TIME * 0.4;
    const tz = target.group.position.z + target.velocity.z * AIR_TIME * 0.4;
    const dx = tx - pos.x;
    const dz = tz - pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const speed = THREE.MathUtils.clamp((d - 0.9) / AIR_TIME, 2, 11);
    this.velocity.set((dx / d) * speed, JUMP_SPEED, (dz / d) * speed);
    this.group.rotation.y = Math.atan2(dx, dz);

    const action = this.actions.get("jumphit");
    if (action) {
      action.reset();
      action.timeScale = THREE.MathUtils.clamp(action.getClip().duration / AIR_TIME, 0.85, 1.8);
      action.play();
    }
    this.sound("jump_whoosh", pos, 0.8);
    this.setState("leap");
  }

  private startRollIn(): void {
    const target = this.playerRef;
    if (!target) return;
    const dx = target.group.position.x - this.group.position.x;
    const dz = target.group.position.z - this.group.position.z;
    const d = Math.hypot(dx, dz) || 1;
    const dir = new THREE.Vector3(dx / d, 0, dz / d);
    const distance = Math.min(ROLL_DISTANCE, d - 1.1);
    this.beginRoll(dir, Math.max(distance, 1.5), "rollIn");
  }

  /** Free to move, or still early enough in a wind-up to cancel it. */
  private canEvadeNow(): boolean {
    if (this.state === "chase" || this.state === "circle" || this.state === "recover") return true;
    return this.state === "attack" && this.attackProgress < 0.3;
  }

  /** Roll or hop away from `threat`; `forced` skips the state check (breaking a combo, retreating). */
  private startEvade(threat: THREE.Vector3, forced: boolean): void {
    if (!forced && !this.canEvadeNow()) return;
    this.dodgeCooldown = rand(1.8, 3.2);
    this.hitStreak = 0;

    const pos = this.group.position;
    const ax = pos.x - threat.x;
    const az = pos.z - threat.z;
    const len = Math.hypot(ax, az) || 1;
    const awayX = ax / len;
    const awayZ = az / len;
    const side = Math.random() < 0.5 ? -1 : 1;

    const canRoll = this.actions.has("roll");
    const canHop = this.actions.has("jump");
    if (canHop && (!canRoll || Math.random() < 0.35)) {
      this.evadeKind = "hop";
      this.velocity.set(awayX * 5.5, JUMP_SPEED * 0.7, awayZ * 5.5);
      this.group.rotation.y = Math.atan2(awayX, awayZ);
      const action = this.actions.get("jump");
      if (action) {
        action.reset();
        action.timeScale = 1.5;
        action.play();
      }
      this.sound("jump_whoosh", pos, 0.6);
      this.setState("evade");
      return;
    }
    if (!canRoll) return;

    // Mostly sideways with a bit of backwards, so it reads as a dodge, not a retreat.
    const dir = new THREE.Vector3(
      -awayZ * side * 0.8 + awayX * 0.6,
      0,
      awayX * side * 0.8 + awayZ * 0.6,
    ).normalize();
    this.beginRoll(dir, ROLL_DISTANCE * 0.85, "roll");
  }

  private beginRoll(dir: THREE.Vector3, distance: number, kind: "roll" | "rollIn"): void {
    const action = this.actions.get("roll");
    if (!action) return;
    this.evadeKind = kind;
    this.evadeDuration = (action.getClip().duration / ROLL_TIME_SCALE) * 0.92;
    const speed = distance / Math.max(this.evadeDuration, 0.25);
    this.velocity.set(dir.x * speed, 0, dir.z * speed);
    this.group.rotation.y = Math.atan2(dir.x, dir.z);
    action.reset();
    action.timeScale = ROLL_TIME_SCALE;
    action.play();
    this.sound("roll", this.group.position, 0.7);
    this.setState("evade");
  }

  private startAttack(chained: boolean): void {
    const canPunch = this.actions.has("punch");
    const canKick = this.actions.has("kick");
    if (!canPunch && !canKick) {
      this.cooldown = 1;
      return;
    }
    const previous = this.attackClip;
    if (chained && canPunch && canKick) {
      this.attackClip = previous === "punch" ? "kick" : "punch";
    } else {
      this.attackClip = canPunch && (!canKick || Math.random() < 0.5) ? "punch" : "kick";
    }
    this.comboUsed = chained;
    this.attackProgress = 0;
    this.attackLanded = false;
    this.whooshed = false;
    const action = this.actions.get(this.attackClip);
    if (action) {
      action.reset();
      // Slightly varied tempo keeps the timing hard to read.
      const base = this.attackClip === "kick" ? 1.15 : 1.2;
      action.timeScale = base * rand(0.9, 1.15) * (chained ? 1.1 : 1);
      action.play();
    }
    this.setState("attack");
  }

  private updateAttack(player: Player, dx: number, dz: number, dist: number, delta: number): void {
    const pos = this.group.position;
    const p = player.group.position;
    this.turnToward(dx, dz, delta, 4);
    const action = this.actions.get(this.attackClip);
    const t = action ? action.time / action.getClip().duration : 1;
    this.attackProgress = t;

    if (!this.whooshed && t > 0.28) {
      this.whooshed = true;
      this.sound(this.attackClip === "kick" ? "kick_whoosh" : "enemy_whoosh", pos, 0.8);
    }
    if (!this.attackLanded && t > 0.38 && t < 0.62) {
      const fx = Math.sin(this.group.rotation.y);
      const fz = Math.cos(this.group.rotation.y);
      const facing = dist > 1e-3 ? (dx * fx + dz * fz) / dist : 1;
      if (dist < ENEMY_REACH && facing > 0.35 && p.y < 1.3) {
        this.attackLanded = true;
        player.takeHit(ENEMY_DAMAGE, pos.x, pos.z);
      }
    }
    if (action && t < 0.92) return;

    if (!this.comboUsed && dist < ENEMY_REACH + 0.5 && Math.random() < this.traits.combo) {
      this.startAttack(true);
      return;
    }
    this.cooldown = rand(0.7, 1.6) / this.traits.aggression;
    // Hit-and-run: roll or hop back out of reach rather than trading blows.
    if (Math.random() < this.traits.retreat) {
      this.startEvade(p, true);
      if (this.state === "evade") return;
    }
    // After a combo they sometimes back off to reset, which also gives the player an opening.
    if (this.comboUsed && Math.random() < 0.4) {
      this.recoverDuration = rand(0.4, 0.7);
      this.setState("recover");
    } else {
      this.setState("chase");
    }
  }

  private updateWater(delta: number, water: WaterQuery | null): void {
    const pos = this.group.position;
    const wasWading = this.wade > 0.15;
    this.wade = water?.depthAt(pos.x, pos.z) ?? 0;
    const lift = THREE.MathUtils.clamp(pos.y / 0.5, 0, 1);
    this.body.position.y = -this.wade * WADE_SINK * (1 - lift);
    const airborne = pos.y > 0.05;
    const landed = this.wasAirborne && !airborne;
    this.wasAirborne = airborne;
    if (!water || this.wade < 0.15 || airborne) return;

    if (landed) {
      water.ripple(pos.x, pos.z, 2.2);
      water.ripple(pos.x, pos.z, 1.1);
      if (this.state !== "recover") this.sound("splash", pos, 0.8);
    }

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (!wasWading && speed > 2) this.sound("wade_1", pos, 0.8);
    this.rippleTimer -= delta;
    if (this.rippleTimer > 0) return;
    const moving = speed > 0.45;
    this.rippleTimer = moving ? 0.2 : 1.0;
    water.ripple(pos.x, pos.z, moving ? 0.9 + speed * 0.06 : 0.6);
    if (moving && Math.random() < 0.35) this.sound(Math.random() < 0.5 ? "wade_1" : "wade_2", pos, 0.6);
  }

  /** Horizontal steering plus simple ballistic Y for leaps, hops and knockback. */
  private integrate(delta: number, desiredSpeed: number, steer: boolean): void {
    const pos = this.group.position;
    const airborne = pos.y > 0 || this.velocity.y > 0;

    if (steer) {
      if (this.moveDir.lengthSq() > 1e-6) {
        this.moveDir.normalize();
        this.turnToward(this.moveDir.x, this.moveDir.z, delta, 10);
      }
      const t = 1 - Math.exp(-10 * delta);
      this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, this.moveDir.x * desiredSpeed, t);
      this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, this.moveDir.z * desiredSpeed, t);
    } else if (!airborne && this.state !== "evade") {
      const decay = 1 - Math.exp(-7 * delta);
      this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, 0, decay);
      this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, 0, decay);
    }

    if (airborne) this.velocity.y -= GRAVITY * delta;
    pos.addScaledVector(this.velocity, delta);
    if (pos.y < 0) {
      pos.y = 0;
      this.velocity.y = 0;
    }
    pos.x = THREE.MathUtils.clamp(pos.x, STREET_BOUNDS.xMin, STREET_BOUNDS.xMax);
    pos.z = THREE.MathUtils.clamp(pos.z, STREET_BOUNDS.zMin, STREET_BOUNDS.zMax);
  }

  private updateDeath(delta: number): void {
    const decay = 1 - Math.exp(-5 * delta);
    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, 0, decay);
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, 0, decay);
    const pos = this.group.position;
    pos.x += this.velocity.x * delta;
    pos.z += this.velocity.z * delta;
    if (this.stateTime < 3 && pos.y > 0) {
      this.velocity.y -= GRAVITY * delta;
      pos.y = Math.max(0, pos.y + this.velocity.y * delta);
    }

    const fall = THREE.MathUtils.clamp(this.stateTime / 0.55, 0, 1);
    const eased = 1 - (1 - fall) * (1 - fall);
    this.body.rotation.x = -this.lean - eased * (Math.PI / 2 - this.lean);
    this.body.position.y = eased * 0.12 - this.wade * WADE_SINK;
    if (!this.fellDown && fall >= 1) {
      this.fellDown = true;
      this.sound("body_fall", pos);
    }

    if (this.stateTime > 3) {
      pos.y = -(this.stateTime - 3) * 0.6;
    }

    if (this.stateTime < 0.6) this.blendTo("idle", delta);
    else this.mixer.update(0);
  }

  private setState(next: EnemyState): void {
    this.state = next;
    this.stateTime = 0;
  }

  private blendTo(target: EnemyClip, delta: number): void {
    if (!this.actions.has(target)) target = "idle";
    if (target !== this.current) {
      const action = this.actions.get(target);
      if (action && !ONE_SHOT.has(target) && !action.isRunning()) action.play();
      this.current = target;
    }
    const rate = ONE_SHOT.has(target) ? 18 : 10;
    const fade = 1 - Math.exp(-rate * delta);
    for (const [name, action] of this.actions) {
      const goal = name === target ? 1 : 0;
      action.setEffectiveWeight(THREE.MathUtils.lerp(action.getEffectiveWeight(), goal, fade));
    }
    this.mixer.update(delta);
  }

  private turnToward(dx: number, dz: number, delta: number, rate: number): void {
    if (dx * dx + dz * dz < 1e-6) return;
    const target = Math.atan2(dx, dz);
    let diff = target - this.group.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.group.rotation.y += diff * (1 - Math.exp(-rate * delta));
  }

  /** Cheaper version of the player's triangle probe: one height, eight spokes. */
  private resolveWalls(walls: readonly THREE.Mesh[]): void {
    if (walls.length === 0) return;
    const radius = 0.38;
    const pos = this.group.position;
    this.rayOrigin.set(pos.x, pos.y + 0.8, pos.z);
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      this.rayDir.set(Math.cos(angle), 0, Math.sin(angle));
      this.raycaster.set(this.rayOrigin, this.rayDir);
      this.raycaster.far = radius;
      const hit = this.raycaster.intersectObjects(walls as THREE.Mesh[], false)[0];
      if (!hit) continue;
      if (hit.face) this.rayNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      else this.rayNormal.copy(this.rayDir).negate();
      this.rayNormal.y = 0;
      if (this.rayNormal.lengthSq() < 1e-8) this.rayNormal.copy(this.rayDir).negate();
      this.rayNormal.normalize();
      pos.addScaledVector(this.rayNormal, radius - hit.distance + 0.01);
    }
  }

  /** Recolor the dark uniform so the three combat roles are visible at a glance. */
  private tint(slot: THREE.Material): THREE.Material {
    if (!(slot instanceof THREE.MeshStandardMaterial)) return slot;
    const mat = slot.clone();
    mat.emissive = new THREE.Color(0, 0, 0);
    const color = new THREE.Color(
      this.traits.archetype === "brawler" ? 0xc64131 :
      this.traits.archetype === "acrobat" ? 0x9861c9 : 0xcaa34e,
    );
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        {
          vec3 c = diffuseColor.rgb;
          if (c.b > c.r * 1.08 && c.b >= c.g) {
            float shade = max(c.b, 0.15) * 1.25;
            diffuseColor.rgb = vec3(${color.r.toFixed(3)}, ${color.g.toFixed(3)}, ${color.b.toFixed(3)}) * shade;
          }
        }`,
      );
    };
    mat.customProgramCacheKey = () => `red-clan-${this.traits.archetype}`;
    this.materials.push(mat);
    return mat;
  }

  private addRoleLook(): void {
    // The brawler's crimson uniform already identifies it. Static shoulder
    // meshes do not follow the animated bones and appear to float during moves.
    if (this.traits.archetype === "brawler") return;

    const add = (geometry: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rz = 0) => {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.22 }));
      mesh.position.set(x, y, z);
      mesh.rotation.z = rz;
      mesh.castShadow = true;
      this.body.add(mesh);
      this.ornaments.push(mesh);
    };
    if (this.traits.archetype === "acrobat") {
      // Twin cloth tails leave a slim, high silhouette.
      add(new THREE.ConeGeometry(0.045, 0.32, 5), 0x704394, -0.11, 0.92, -0.11, -0.28);
      add(new THREE.ConeGeometry(0.045, 0.32, 5), 0x704394, 0.11, 0.92, -0.11, 0.28);
    } else {
      // A sheathed blade on the back marks the duelist.
      add(new THREE.BoxGeometry(0.04, 0.55, 0.05), 0x50452c, 0.12, 0.8, -0.14, -0.55);
      add(new THREE.BoxGeometry(0.14, 0.04, 0.06), 0xd4b75f, -0.01, 1.05, -0.14, -0.55);
    }
  }
}
