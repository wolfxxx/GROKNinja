/** Tunable gameplay and camera values — keep these in one place. */

export const PLAYER_START = { x: 0, y: 0, z: 0 } as const;

/** Open sandbox plane (matches the 80×80 ground). */
export const STREET_BOUNDS = {
  xMin: -38,
  xMax: 38,
  zMin: -38,
  zMax: 38,
} as const;

/** World-space Y of the player group while standing on the ground. */
export const PLAYER_STAND_Y = PLAYER_START.y;

/** How far characters sink into a pond at full depth, and how much it slows them. */
export const WADE_SINK = 0.42;
export const WADE_SLOW = 0.45;

export const WALK_SPEED = 5.8;
export const SPRINT_SPEED = 9.0;

/** Metres per second the walk/run clips cover at timeScale = 1. */
export const WALK_CLIP_SPEED = 4.8;
export const RUN_CLIP_SPEED = 6.2;

/** How quickly horizontal velocity catches the target speed. Higher = snappier. */
export const MOVE_ACCEL = 16;
export const MOVE_DECEL = 16;

export const JUMP_SPEED = 8;
export const GRAVITY = 22;

/** Metres covered by a grounded Ctrl roll (root motion is flattened). */
export const ROLL_DISTANCE = 4.4;
/** Playback rate for the Mixamo roll take. 1 = authored speed. */
export const ROLL_TIME_SCALE = 2.05;
/** Playback rate for the Mixamo kick take. */
export const KICK_TIME_SCALE = 1.35;

/** Radians per pixel of mouse movement. */
export const LOOK_SENSITIVITY = 0.0022;

export const PITCH_MIN = -0.12;
export const PITCH_MAX = 1.15;

export const ZOOM_MIN = 3.5;
export const ZOOM_MAX = 16;
export const ZOOM_STEP = 0.65;
export const ZOOM_SMOOTH = 10;

/** How quickly the camera catches the ideal orbit point. */
export const CAMERA_FOLLOW = 8;

/** Look-at point sits this far above the player's feet (ninja chest / head). */
export const LOOK_AT_OFFSET_Y = 1.2;

export const PLAYER_TURN_SPEED = 14;

export const PLAYER_MAX_HP = 100;
/** HP per second once the player hasn't been hit for PLAYER_REGEN_DELAY seconds. */
export const PLAYER_REGEN = 5;
export const PLAYER_REGEN_DELAY = 4;

/** Player strikes: reach in metres from the player's feet, damage in enemy HP. */
export const KICK_REACH = 1.9;
export const KICK_DAMAGE = 1;
export const JUMP_HIT_REACH = 2.3;
export const JUMP_HIT_DAMAGE = 2;
/** The jump attack only deals damage while falling below this height (peak is ~1.45 m). */
export const JUMP_HIT_SLAM_HEIGHT = 0.9;

export const ENEMY_HEIGHT = 1.78;
export const ENEMY_HP = 4;
export const ENEMY_SPEED = 4.3;
/** Enemies notice the player inside this radius. */
export const ENEMY_AGGRO_RANGE = 14;
/** Enemies start a strike inside this radius... */
export const ENEMY_ATTACK_RANGE = 1.45;
/** ...and it connects if the player is still inside this one. */
export const ENEMY_REACH = 1.85;
export const ENEMY_DAMAGE = 12;
/** Landing slam of an enemy's leaping jump attack. */
export const ENEMY_LEAP_DAMAGE = 18;
/** Enemies waiting for their turn circle the player at about this distance. */
export const ENEMY_CIRCLE_RADIUS = 4.3;
/** How many enemies may press the attack at once; the rest circle. */
export const ENEMY_MAX_ATTACKERS = 2;
/** Enemies come in waves: 2, 3, 4… up to this many at once. */
export const ENEMY_MAX_WAVE_SIZE = 5;
/** Seconds of peace after loading before the first wave. */
export const ENEMY_FIRST_WAVE_DELAY = 20;
/** Seconds of peace after a wave is cleared. */
export const ENEMY_WAVE_BREAK = 35;
