import { assetUrl } from "./assetUrl";

/**
 * The run GLB holds the only mesh and textures. The other GLBs contain only
 * animation tracks for the same named bones.
 */
export const HERO_NINJA = {
  url: assetUrl("characters/NINJArun.glb"),
  idleUrl: assetUrl("characters/NINJAidle.glb"),
  jumpUrl: assetUrl("characters/NINJArunjump.glb"),
  rollUrl: assetUrl("characters/NINJAroll.glb"),
  kickUrl: assetUrl("characters/NINJAkick.glb"),
  jumpHitUrl: assetUrl("characters/NINJAjumphit.glb"),
  height: 1.7,
} as const;

/** Red Clan enemies reuse the hero rig; this take is only used by them. */
export const ENEMY_PUNCH_URL = assetUrl("characters/NINJApunch.glb");

export type NpcSpawn = {
  name: string;
  url: string;
  height: number;
  x: number;
  y: number;
  z: number;
  /** Radians. Model forward is assumed +Z. */
  yaw: number;
};

/**
 * Park NPCs on the gravel beside the cobble so they don't block WASD.
 * Street runs along -Z; torii is near z = -33.6.
 */
export const NPC_SPAWNS: readonly NpcSpawn[] = [
  {
    name: "Kunoichi",
    url: assetUrl("characters/ninjagirl.glb"),
    height: 1.55,
    x: 2.05,
    y: 0,
    z: -10.2,
    yaw: -Math.PI / 2,
  },
  {
    name: "Shopkeeper",
    url: assetUrl("characters/shopkeeper.glb"),
    height: 1.48,
    x: -2.05,
    y: 0,
    z: -18.4,
    yaw: Math.PI / 2,
  },
  {
    name: "RivalNinja",
    url: assetUrl("characters/rivalninja.glb"),
    height: 1.6,
    x: 2.08,
    y: 0,
    z: -24.2,
    yaw: 0,
  },
  {
    name: "SpiritFox",
    url: assetUrl("characters/spiritfox.glb"),
    height: 0.68,
    x: -1.85,
    y: 0.12,
    z: -7.2,
    yaw: Math.PI * 0.65,
  },
  {
    name: "OldMaster",
    url: assetUrl("characters/oldmaster.glb"),
    height: 1.36,
    x: 0,
    y: 0,
    z: -31.4,
    yaw: 0,
  },
  {
    name: "ShadowDemon",
    url: assetUrl("characters/demonboss3.glb"),
    height: 1.9,
    x: 2.15,
    y: 0,
    z: -35.4,
    yaw: -Math.PI * 0.75,
  },
];
