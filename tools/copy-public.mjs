import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const from = join(root, "public");
const to = join(root, "dist");

// Keep the authored FBX kit and unused source characters out of the Pages
// artifact. The village and maple GLBs are already emitted by Vite imports.
const assets = [
  "favicon.png",
  "audio",
  "draco",
  "characters/NINJArun.glb",
  "characters/NINJAidle.glb",
  "characters/NINJArunjump.glb",
  "characters/NINJAroll.glb",
  "characters/NINJAkick.glb",
  "characters/NINJAjumphit.glb",
  "characters/NINJApunch.glb",
];

for (const asset of assets) {
  const destination = join(to, asset);
  mkdirSync(join(destination, ".."), { recursive: true });
  cpSync(join(from, asset), destination, { recursive: true });
}
