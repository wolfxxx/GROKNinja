import * as THREE from "three";

export const SOUND_NAMES = [
  "kick_whoosh",
  "hit_kick",
  "slam_impact",
  "jump_whoosh",
  "land",
  "roll",
  "footstep_1",
  "footstep_2",
  "wade_1",
  "wade_2",
  "splash",
  "enemy_whoosh",
  "hit_player",
  "player_hurt",
  "enemy_hurt",
  "enemy_death",
  "body_fall",
  "defeat",
  "ambience",
  "music_explore",
  "music_battle",
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

/** `at` = world position for distance fade / stereo pan; omit for UI-style sounds. */
export type SoundHook = (name: SoundName, at?: THREE.Vector3, volume?: number) => void;

type Loaded = { buffer: AudioBuffer; offset: number };

const BASE_VOLUME: Partial<Record<SoundName, number>> = {
  footstep_1: 0.35,
  footstep_2: 0.35,
  wade_1: 0.5,
  wade_2: 0.5,
  splash: 0.7,
  land: 0.55,
  roll: 0.6,
  kick_whoosh: 0.75,
  enemy_whoosh: 0.6,
  player_hurt: 0.8,
  enemy_hurt: 0.75,
  defeat: 0.8,
};

const AMBIENCE_VOLUME = 0.3;
const MUSIC_VOLUME = { explore: 0.32, battle: 0.16 } as const;
/** Seconds of overlap when a music track wraps around, hiding the seam. */
const LOOP_CROSSFADE = 4;
/** Battle music lingers this long after the last enemy stops fighting. */
const BATTLE_HOLD = 4;

type MusicTrack = {
  name: "music_explore" | "music_battle";
  gain: GainNode;
  /** AudioContext time the next loop iteration starts. */
  nextStart: number;
  current: { gain: GainNode } | null;
};

/**
 * Web Audio playback for the ElevenLabs clips in public/audio.
 * The context starts suspended and resumes on the first click / key press.
 */
export class GameAudio {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly buffers = new Map<SoundName, Loaded>();
  private ambienceStarted = false;
  private muted = false;
  private paused = false;
  private readonly music: MusicTrack[] = [];
  private musicStarted = false;
  private inBattle = false;
  private calmFor = Infinity;

  private readonly listenerPos = new THREE.Vector3();
  private readonly listenerRight = new THREE.Vector3();
  private readonly toSource = new THREE.Vector3();

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);

    this.unlock = this.unlock.bind(this);
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);

    void this.loadAll();
  }

  readonly play: SoundHook = (name, at, volume = 1) => {
    const loaded = this.buffers.get(name);
    if (!loaded || this.ctx.state !== "running") return;

    const source = this.ctx.createBufferSource();
    source.buffer = loaded.buffer;
    // Small pitch spread so repeated hits and steps don't sound copy-pasted.
    source.playbackRate.value = 0.93 + Math.random() * 0.14;

    const gain = this.ctx.createGain();
    let level = volume * (BASE_VOLUME[name] ?? 1);
    let node: AudioNode = gain;

    if (at) {
      this.toSource.subVectors(at, this.listenerPos);
      const dist = this.toSource.length();
      if (dist > 40) return;
      level *= 1 / (1 + Math.max(0, dist - 6) * 0.18);
      const panner = this.ctx.createStereoPanner();
      panner.pan.value =
        dist > 1e-3
          ? THREE.MathUtils.clamp(this.toSource.dot(this.listenerRight) / dist, -1, 1) * 0.7
          : 0;
      gain.connect(panner);
      node = panner;
    }

    gain.gain.value = level;
    source.connect(gain);
    node.connect(this.master);
    source.start(0, loaded.offset);
  };

  /** Call every frame so positional sounds pan relative to the camera. */
  updateListener(camera: THREE.Camera): void {
    camera.getWorldPosition(this.listenerPos);
    this.listenerRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  }

  /**
   * Call every frame. Keeps the music loops scheduled and crossfades between
   * the calm and battle tracks.
   */
  updateMusic(delta: number, combat: boolean): void {
    if (!this.musicStarted) return;
    const now = this.ctx.currentTime;

    for (const track of this.music) {
      if (now > track.nextStart - 1) this.scheduleLoop(track);
    }

    this.calmFor = combat ? 0 : this.calmFor + delta;
    const wantBattle = this.calmFor < BATTLE_HOLD;
    if (wantBattle === this.inBattle) return;
    this.inBattle = wantBattle;

    const [explore, battle] = this.music;
    // Snappy into the fight, slow back out of it.
    const tau = wantBattle ? 0.35 : 1.6;
    explore?.gain.gain.setTargetAtTime(wantBattle ? 0 : MUSIC_VOLUME.explore, now, tau);
    battle?.gain.gain.setTargetAtTime(wantBattle ? MUSIC_VOLUME.battle : 0, now, tau);
  }

  /** Freezes every playing sound and the music loops in place. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) void this.ctx.suspend();
    else void this.ctx.resume().then(() => this.startLoops());
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  private unlock(): void {
    if (this.paused) return;
    if (this.ctx.state === "suspended") void this.ctx.resume().then(() => this.startLoops());
    else this.startLoops();
  }

  private startLoops(): void {
    this.startAmbience();
    this.startMusic();
    if (this.ambienceStarted && this.musicStarted) {
      window.removeEventListener("pointerdown", this.unlock);
      window.removeEventListener("keydown", this.unlock);
    }
  }

  private startMusic(): void {
    if (this.musicStarted || this.ctx.state !== "running") return;
    if (!this.buffers.has("music_explore") || !this.buffers.has("music_battle")) return;
    this.musicStarted = true;

    const start = this.ctx.currentTime + 0.1;
    for (const name of ["music_explore", "music_battle"] as const) {
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.master);
      this.music.push({ name, gain, nextStart: start, current: null });
    }
    const [explore] = this.music;
    explore.gain.gain.setValueAtTime(0, start);
    explore.gain.gain.linearRampToValueAtTime(MUSIC_VOLUME.explore, start + 4);
    for (const track of this.music) this.scheduleLoop(track);
  }

  /** Start the next pass of a track, overlapping the previous pass by LOOP_CROSSFADE. */
  private scheduleLoop(track: MusicTrack): void {
    const loaded = this.buffers.get(track.name);
    if (!loaded) return;
    const at = Math.max(track.nextStart, this.ctx.currentTime + 0.05);
    const fade = Math.min(LOOP_CROSSFADE, loaded.buffer.duration / 4);

    const source = this.ctx.createBufferSource();
    source.buffer = loaded.buffer;
    const pass = this.ctx.createGain();
    const first = track.current === null;
    pass.gain.setValueAtTime(first ? 1 : 0, at);
    if (!first) pass.gain.linearRampToValueAtTime(1, at + fade);
    source.connect(pass).connect(track.gain);
    source.start(at);

    if (track.current) {
      const old = track.current.gain.gain;
      old.setValueAtTime(1, at);
      old.linearRampToValueAtTime(0, at + fade);
    }
    track.current = { gain: pass };
    track.nextStart = at + loaded.buffer.duration - fade;
  }

  private startAmbience(): void {
    const loaded = this.buffers.get("ambience");
    if (this.ambienceStarted || !loaded || this.ctx.state !== "running") return;
    this.ambienceStarted = true;

    const source = this.ctx.createBufferSource();
    source.buffer = loaded.buffer;
    source.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(AMBIENCE_VOLUME, this.ctx.currentTime + 3);
    source.connect(gain).connect(this.master);
    source.start();
  }

  private async loadAll(): Promise<void> {
    await Promise.all(
      SOUND_NAMES.map(async (name) => {
        try {
          const res = await fetch(`/audio/${name}.mp3`);
          if (!res.ok) return;
          const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
          const offset =
            name === "ambience" || name.startsWith("music_") ? 0 : leadingSilence(buffer);
          this.buffers.set(name, { buffer, offset });
        } catch (err) {
          console.warn("[audio] failed to load", name, err);
        }
      }),
    );
    this.startLoops();
  }
}

/** Generated clips are at least 0.5 s and often start quiet; skip that so hits feel instant. */
function leadingSilence(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  const threshold = 0.02;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > threshold) {
      return Math.max(0, i / buffer.sampleRate - 0.005);
    }
  }
  return 0;
}
