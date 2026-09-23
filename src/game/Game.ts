import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { ENEMY_PUNCH_URL, HERO_NINJA } from "./characterCatalog";
import { GameAudio } from "./Audio";
import { EnemyManager } from "./Enemies";
import { fitCharacter } from "./fitCharacter";
import { Input } from "./Input";
import { Nature } from "./Nature";
import { Player } from "./Player";
import { ThirdPersonCamera } from "./ThirdPersonCamera";
import { Village } from "./Village";
import { assetUrl } from "./assetUrl";

const MAX_DELTA = 0.05;

const LOAD_HERO_GLB = true;

export class Game {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly clock = new THREE.Clock();

  private readonly player = new Player();
  private readonly followCam: ThirdPersonCamera;
  private readonly input: Input;
  private village: Village | null = null;
  private nature: Nature | null = null;
  private readonly enemies = new EnemyManager(this.scene);
  private readonly audio = new GameAudio();
  private defeatTimer = 0;
  private bannerTimeout = 0;
  private readonly hud = {
    healthFill: document.getElementById("health-fill"),
    kills: document.getElementById("kills"),
    hurt: document.getElementById("hurt-flash"),
    banner: document.getElementById("banner"),
    load: document.getElementById("load-status"),
    pause: document.getElementById("pause-overlay"),
  };
  private paused = false;
  /** Only auto-pause on Esc once the player has actually started playing. */
  private hasPlayed = false;

  private readonly axesHelper = new THREE.AxesHelper(2.5);
  private readonly gridHelper = new THREE.GridHelper(80, 80, 0x5a4638, 0x2a221c);

  private helpersVisible = false;
  private rafId = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      200,
    );

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });

    const hint = document.getElementById("hint");
    this.input = new Input(canvas, hint);
    this.followCam = new ThirdPersonCamera(this.camera, this.player);

    this.loop = this.loop.bind(this);
    this.onResize = this.onResize.bind(this);

    this.player.onHealthChange = (hp, max, damaged) => {
      if (this.hud.healthFill) this.hud.healthFill.style.width = `${(hp / max) * 100}%`;
      if (damaged && this.hud.hurt) {
        this.hud.hurt.classList.remove("is-active");
        void this.hud.hurt.offsetWidth;
        this.hud.hurt.classList.add("is-active");
      }
    };
    this.input.onLockChange = (locked) => {
      if (locked) {
        this.hasPlayed = true;
        this.setPaused(false);
      } else if (this.hasPlayed) {
        this.setPaused(true);
      }
    };
    this.player.onSound = this.audio.play;
    this.enemies.onSound = this.audio.play;
    this.enemies.onKill = (kills) => {
      if (this.hud.kills) this.hud.kills.textContent = `Red Clan defeated: ${kills}`;
    };
    this.enemies.onWave = (wave) => {
      const banner = this.hud.banner;
      if (!banner || this.player.isDefeated()) return;
      banner.textContent = `Wave ${wave} — the Red Clan approaches`;
      banner.classList.add("is-visible");
      window.clearTimeout(this.bannerTimeout);
      this.bannerTimeout = window.setTimeout(() => banner.classList.remove("is-visible"), 2600);
    };
  }

  init(): void {
    this.setupRenderer();
    this.setupScene();
    this.setupLights();
    this.setupGround();
    this.setupHelpers();
    this.loadVillage();

    this.scene.add(this.player.group);
    this.followCam.syncImmediate();
    this.renderer.render(this.scene, this.camera);
    if (LOAD_HERO_GLB) {
      this.loadHeroNinja();
    }

    this.input.attach();
    window.addEventListener("resize", this.onResize);
    this.onResize();

    this.clock.start();
    this.rafId = requestAnimationFrame(this.loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.onResize);
    this.input.dispose();
    this.renderer.dispose();
  }

  private setupRenderer(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.45;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  private setupScene(): void {
    const fogColor = 0xa8c0c8;
    this.scene.background = new THREE.Color(fogColor);
    this.scene.fog = new THREE.Fog(fogColor, 55, 130);
  }

  private setupLights(): void {
    const ambient = new THREE.AmbientLight(0xfff6ea, 0.55);
    this.scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0xf2f7ff, 0x7a8a62, 1.55);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
    sun.name = "Sun";
    sun.position.set(22, 34, 16);
    sun.target.position.set(0, 0, -6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;

    const extent = 36;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 90;
    sun.shadow.camera.left = -extent;
    sun.shadow.camera.right = extent;
    sun.shadow.camera.top = extent;
    sun.shadow.camera.bottom = -extent;

    this.scene.add(sun);
    this.scene.add(sun.target);

    const fill = new THREE.DirectionalLight(0xd5e4f4, 1.05);
    fill.position.set(-14, 12, -18);
    this.scene.add(fill);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.5;
    pmrem.dispose();
  }

  private setupGround(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({
        color: 0x4f6140,
        roughness: 0.94,
        metalness: 0.03,
      }),
    );
    ground.name = "Ground";
    ground.rotation.x = -Math.PI / 2;
    // Sit below the village earth so the two planes don't z-fight.
    ground.position.y = -0.08;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  private setupHelpers(): void {
    this.axesHelper.position.set(0, 0.02, 0);
    this.gridHelper.position.y = 0.01;
    this.axesHelper.visible = false;
    this.gridHelper.visible = false;
    this.scene.add(this.axesHelper, this.gridHelper);
  }

  private loop(): void {
    this.rafId = requestAnimationFrame(this.loop);
    const delta = Math.min(this.clock.getDelta(), MAX_DELTA);

    if (this.input.consumePauseToggle()) {
      if (this.paused) {
        this.setPaused(false);
        this.input.requestLock();
      } else {
        this.setPaused(true);
        document.exitPointerLock();
      }
    }

    if (!this.paused) this.update(delta);
    this.render();
  }

  private setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.input.clearQueued();
    this.audio.setPaused(paused);
    this.hud.pause?.classList.toggle("is-visible", paused);
  }

  private update(delta: number): void {
    if (this.input.consumeHelpersToggle()) {
      this.helpersVisible = !this.helpersVisible;
      this.axesHelper.visible = this.helpersVisible;
      this.gridHelper.visible = this.helpersVisible;
    }
    if (this.input.consumeMuteToggle()) this.audio.toggleMute();
    this.audio.updateListener(this.camera);

    const look = this.input.consumeLook();
    const wheel = this.input.consumeWheel();

    this.player.update(delta, this.input, this.camera);
    this.enemies.update(delta, this.player);
    this.updateDefeat(delta);
    this.audio.updateMusic(delta, this.enemies.isInCombat() && !this.player.isDefeated());
    this.village?.update(delta);
    this.nature?.update(delta);
    this.followCam.update(delta, look.dx, look.dy, wheel);
  }

  private updateDefeat(delta: number): void {
    if (!this.player.isDefeated()) return;
    if (this.defeatTimer === 0) {
      this.audio.play("defeat");
      window.clearTimeout(this.bannerTimeout);
      if (this.hud.banner) {
        this.hud.banner.textContent = "Defeated by the Red Clan";
        this.hud.banner.classList.add("is-visible");
      }
    }
    this.defeatTimer += delta;
    if (this.defeatTimer < 2.2) return;
    this.defeatTimer = 0;
    this.hud.banner?.classList.remove("is-visible");
    this.player.respawn();
    this.enemies.resetAggro();
    this.followCam.syncImmediate();
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private onResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
  }

  private loadVillage(): void {
    const village = new Village(this.scene);
    this.village = village;
    void village.load().then(async () => {
      const walls = village.getCollisionMeshes();
      this.player.setCollisionMeshes(walls);
      this.enemies.setCollisionMeshes(walls);

      const nature = new Nature(this.scene);
      this.nature = nature;
      await nature.build();
      this.player.water = nature;
      this.enemies.water = nature;
      const all = [...walls, ...nature.getColliders()];
      this.player.setCollisionMeshes(all);
      this.enemies.setCollisionMeshes(all);
    });
  }

  private loadHeroNinja(): void {
    const url = HERO_NINJA.url;
    if (url.toLowerCase().endsWith(".fbx")) {
      this.loadHeroFbx(url);
      return;
    }
    this.loadHeroGltf(url);
  }

  private loadHeroFbx(url: string): void {
    // Combat clips first so kick / roll / jump unlock as soon as possible on slow links.
    const extraClipUrls = [
      HERO_NINJA.kickUrl,
      HERO_NINJA.rollUrl,
      HERO_NINJA.jumpUrl,
      HERO_NINJA.jumpHitUrl,
      HERO_NINJA.idleUrl,
    ].filter((extra) => extra && extra !== url);
    void this.assembleHeroFbx(url, extraClipUrls);
  }

  private setLoadStatus(text: string | null): void {
    const el = this.hud.load;
    if (!el) return;
    if (!text) {
      el.classList.add("is-hidden");
      return;
    }
    el.textContent = text;
    el.classList.remove("is-hidden");
  }

  private async assembleHeroFbx(meshUrl: string, extraClipUrls: string[]): Promise<void> {
    this.setLoadStatus("Downloading character…");

    // Kick off every FBX at once — sequential waits were ~1 min on Pages.
    const meshPromise = loadFbx(meshUrl);
    const extraJobs = extraClipUrls.map((extraUrl) => ({
      url: extraUrl,
      promise: loadFbx(extraUrl),
    }));
    const punchPromise = loadFbx(ENEMY_PUNCH_URL);

    try {
      const meshGroup = await meshPromise;
      const clips = takeLabeledClips(meshGroup, clipLabelFromUrl(meshUrl));
      const fitted = fitCharacter(meshGroup, HERO_NINJA.height);
      fitted.name = "HeroNinja";
      this.enemies.setTemplate(fitted.userData.animRoot as THREE.Object3D);
      const preferred = /run/i.test(meshUrl) ? "run" : "idle";
      this.player.setModel(fitted, clips, preferred);
      this.enemies.addClips(clips);
      this.followCam.syncImmediate();
      this.renderer.render(this.scene, this.camera);
      console.info(
        "[hero] mesh ready:",
        clips.map((c) => `${c.name} (${c.duration.toFixed(2)}s)`).join(", "),
      );
    } catch (err) {
      console.error("Failed to load hero FBX", err);
      this.player.showPlaceholder();
      this.setLoadStatus("Character failed to load");
      return;
    }

    const total = extraJobs.length;
    let ready = 0;
    this.setLoadStatus(`Loading moves… 0/${total}`);

    await Promise.all(
      extraJobs.map(async ({ url: extraUrl, promise }) => {
        try {
          const extraGroup = await promise;
          const extraClips = takeLabeledClips(extraGroup, clipLabelFromUrl(extraUrl));
          this.player.addClips(extraClips);
          this.enemies.addClips(extraClips);
          ready += 1;
          this.setLoadStatus(`Loading moves… ${ready}/${total}`);
          console.info(
            "[hero] clip ready:",
            extraClips.map((c) => `${c.name} (${c.duration.toFixed(2)}s)`).join(", ") || extraUrl,
          );
        } catch (err) {
          ready += 1;
          this.setLoadStatus(`Loading moves… ${ready}/${total}`);
          console.error("Failed to load extra hero clip", extraUrl, err);
        }
      }),
    );

    try {
      const punchGroup = await punchPromise;
      this.enemies.addClips(takeLabeledClips(punchGroup, clipLabelFromUrl(ENEMY_PUNCH_URL)));
    } catch (err) {
      console.error("Failed to load enemy punch clip", err);
    }

    this.setLoadStatus("Ready");
    window.setTimeout(() => this.setLoadStatus(null), 900);
  }

  private loadHeroGltf(url: string): void {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(assetUrl("draco/"));
    loader.setDRACOLoader(draco);

    loader.load(
      url,
      (gltf) => {
        const fitted = fitCharacter(gltf.scene, HERO_NINJA.height);
        fitted.name = "HeroNinja";
        this.player.setModel(fitted, gltf.animations);
      },
      undefined,
      (err) => {
        console.error("Failed to load hero glTF", err);
      },
    );
  }
}

function loadFbx(url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    new FBXLoader().load(url, resolve, undefined, (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function clipLabelFromUrl(
  url: string,
): "idle" | "walk" | "run" | "jump" | "roll" | "kick" | "punch" | "jumphit" {
  const file = url.split("/").pop()?.toLowerCase() ?? "";
  // "jumphit" / "runjump" both contain "jump" — match the more specific names first.
  if (file.includes("jumphit") || file.includes("jumpattack")) return "jumphit";
  if (file.includes("jump")) return "jump";
  if (file.includes("roll") || file.includes("dodge")) return "roll";
  if (file.includes("kick")) return "kick";
  if (file.includes("punch") || file.includes("attack")) return "punch";
  if (file.includes("walk")) return "walk";
  if (file.includes("run")) return "run";
  return "idle";
}

/** Mixamo names every take "mixamo.com" — use the filename as the clip name. */
function takeLabeledClips(
  group: THREE.Group,
  fallbackName: string,
): THREE.AnimationClip[] {
  return (group.animations ?? [])
    .filter((clip) => clip.duration > 0.15 && clip.tracks.length > 0)
    .map((clip) => {
      const lower = clip.name.toLowerCase();
      if (!lower || lower === "mixamo.com" || lower.startsWith("take")) {
        clip.name = fallbackName;
      }
      for (const track of clip.tracks) {
        track.name = track.name.replace(/mixamorig:/g, "mixamorig");
      }
      return clip;
    });
}
