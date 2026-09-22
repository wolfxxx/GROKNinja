# GROKNinja

Third-person ninja brawler in the browser: **Three.js** + **Vite** + **TypeScript**.

A Mixamo ninja fights waves of the Red Clan in a Japanese village with a shrine,
maple trees, bamboo, grass and wadeable koi ponds. Sound effects and music were
generated with ElevenLabs.

## Run

Large assets (FBX, GLB, PNG) are stored with [Git LFS](https://git-lfs.com/),
so install it before cloning.

```bash
git lfs install
git clone https://github.com/wolfxxx/GROKNinja.git
cd GROKNinja
npm install
npm run dev
```

Open `http://localhost:5173` and click the canvas to start.

## Controls

| Input | Action |
| --- | --- |
| WASD | Move relative to camera |
| Space (hold) | Sprint |
| Left Shift | Jump |
| Ctrl | Roll |
| Left click | Kick |
| Right click | Jump attack |
| Mouse / Scroll | Look / zoom |
| P or Esc | Pause |
| M | Mute |
| H | Toggle grid + axes helpers |

## Regenerating audio

The scripts read `ELEVENLABS_API_KEY` from the environment and write to
`public/audio/`. Existing files are skipped unless you pass `--force`.

```bash
node tools/generate-sfx.mjs
node tools/generate-music.mjs
```

## Project layout

```
src/game/
├── Game.ts              # scene, lights, loop, HUD, loading
├── Player.ts            # hero movement, attacks, health, wading
├── Enemies.ts           # Red Clan AI, waves
├── Village.ts           # village layout, shrine, collision
├── Nature.ts            # trees, grass, rocks, ponds, ripples
├── Audio.ts             # Web Audio SFX, ambience, music crossfade
├── ThirdPersonCamera.ts
├── Input.ts
└── constants.ts
```
