/**
 * Generate game sound effects with the ElevenLabs Sound Effects API.
 *
 *   node tools/generate-sfx.mjs            # only sounds that don't exist yet
 *   node tools/generate-sfx.mjs kick_whoosh --force   # regenerate specific ones
 *
 * Reads ELEVENLABS_API_KEY from the environment. Output: public/audio/<name>.mp3
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "audio");

/** name → [prompt, seconds, loop?] */
const SOUNDS = {
  kick_whoosh: [
    "Fast martial arts kick swooshing through the air, cloth whip, no impact, close up",
    0.6,
  ],
  hit_kick: [
    "Punchy meaty body impact of a kick landing on a person, fighting game hit, close up",
    0.5,
  ],
  slam_impact: [
    "Heavy fist ground slam into packed dirt, deep punchy thump with small debris scatter",
    1.0,
  ],
  jump_whoosh: ["Quick short upward jump whoosh with light cloth rustle", 0.5],
  land: ["Feet landing on a gravel path, soft crunchy thud", 0.5],
  roll: ["Fast body roll across a gravel path, cloth rustle and dirt scuff", 0.8],
  footstep_1: ["Single footstep on a fine gravel path, light soft shoe, close up", 0.5],
  footstep_2: ["One light footstep crunching fine gravel, soft ninja shoe", 0.5],
  enemy_whoosh: ["Fast fist punch swooshing through the air, no impact", 0.5],
  hit_player: ["Solid punch impact on a body, fighting game hit, short and punchy", 0.5],
  player_hurt: ["Short sharp male grunt of pain, fighter getting hit, no words", 0.6],
  enemy_hurt: ["Short male warrior grunt of pain, getting kicked, no words", 0.6],
  enemy_death: ["Male warrior short dying groan followed by a weak exhale, no words", 1.3],
  body_fall: ["Body collapsing onto a dirt ground, heavy thud with cloth", 1.0],
  wade_1: ["Single footstep wading through knee-deep pond water, soft slosh, close up", 0.5],
  wade_2: ["One step through shallow water, gentle splash and slosh, close up", 0.5],
  splash: ["Person jumping into a shallow pond, medium water splash with droplets", 1.0],
  defeat: ["Deep taiko drum hit followed by a low resonant gong, dramatic defeat sting", 3.0],
  ambience: [
    "Peaceful Japanese shrine ambience, gentle wind through trees, distant birds, faint wind chimes, seamless loop",
    22,
    true,
  ],
};

const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error("ELEVENLABS_API_KEY is not set.");
  process.exit(1);
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args.filter((a) => !a.startsWith("--"));
const names = only.length > 0 ? only : Object.keys(SOUNDS);

mkdirSync(OUT_DIR, { recursive: true });

let failed = 0;
for (const name of names) {
  const spec = SOUNDS[name];
  if (!spec) {
    console.warn(`unknown sound: ${name}`);
    continue;
  }
  const file = join(OUT_DIR, `${name}.mp3`);
  if (existsSync(file) && !force) {
    console.log(`skip  ${name} (exists)`);
    continue;
  }

  const [text, seconds, loop] = spec;
  const body = { text, duration_seconds: seconds, prompt_influence: 0.5 };
  if (loop) body.loop = true;

  const res = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    failed++;
    console.error(`fail  ${name}: ${res.status} ${await res.text()}`);
    if (res.status === 401 || res.status === 402) break;
    continue;
  }

  const audio = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, audio);
  console.log(`ok    ${name} (${(audio.length / 1024).toFixed(0)} KB)`);
}

process.exit(failed > 0 ? 1 : 0);
