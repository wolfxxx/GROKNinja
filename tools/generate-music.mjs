/**
 * Generate background music with the ElevenLabs Music API.
 *
 *   node tools/generate-music.mjs                  # only tracks that don't exist yet
 *   node tools/generate-music.mjs battle --force   # regenerate specific ones
 *
 * Reads ELEVENLABS_API_KEY from the environment. Output: public/audio/music_<name>.mp3
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "audio");

/** name → [prompt, seconds] */
const TRACKS = {
  explore: [
    "Calm traditional Japanese instrumental for exploring a peaceful mountain shrine village. " +
      "Koto and shakuhachi melody, soft shamisen plucks, gentle ambient pads, light wind chimes, " +
      "slow tempo around 70 BPM, serene and mysterious, video game background music, " +
      "steady even energy from start to end with no big intro or ending so it can loop",
    80,
  ],
  battle: [
    "Intense Japanese ninja battle instrumental for a video game fight. " +
      "Driving taiko drums, fast aggressive shamisen riffs, sharp shakuhachi accents, " +
      "low strings and percussion hits, 140 BPM, urgent and heroic, " +
      "constant high energy from start to end with no intro or fade out so it can loop",
    60,
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
const names = only.length > 0 ? only : Object.keys(TRACKS);

mkdirSync(OUT_DIR, { recursive: true });

let failed = 0;
for (const name of names) {
  const spec = TRACKS[name];
  if (!spec) {
    console.warn(`unknown track: ${name}`);
    continue;
  }
  const file = join(OUT_DIR, `music_${name}.mp3`);
  if (existsSync(file) && !force) {
    console.log(`skip  ${name} (exists)`);
    continue;
  }

  const [prompt, seconds] = spec;
  console.log(`...   ${name} (${seconds}s, this can take a minute)`);
  const res = await fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      music_length_ms: seconds * 1000,
      force_instrumental: true,
    }),
  });

  if (!res.ok) {
    failed++;
    console.error(`fail  ${name}: ${res.status} ${await res.text()}`);
    if (res.status === 401 || res.status === 402 || res.status === 403) break;
    continue;
  }

  const audio = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, audio);
  console.log(`ok    ${name} (${(audio.length / 1024).toFixed(0)} KB)`);
}

process.exit(failed > 0 ? 1 : 0);
