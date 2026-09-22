import * as THREE from "three";
import {
  CAMERA_FOLLOW,
  LOOK_SENSITIVITY,
  PITCH_MAX,
  PITCH_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_SMOOTH,
  ZOOM_STEP,
} from "./constants";
import type { Player } from "./Player";

/**
 * Orbit camera: spherical yaw/pitch/distance around the player, with a
 * lagged follow so motion feels cinematic instead of glued to the capsule.
 */
export class ThirdPersonCamera {
  /** Horizontal orbit angle (radians). 0 = camera on +Z, looking toward the village. */
  private yaw = 0;

  /** Elevation above the horizon (radians). Positive = camera above the player. */
  private pitch = 0.34;

  private distance = 7.2;
  private targetDistance = 7.2;

  private readonly desired = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private readonly sphericalOffset = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly player: Player,
  ) {
    this.syncImmediate();
  }

  update(delta: number, lookDX: number, lookDY: number, wheel: number): void {
    this.yaw -= lookDX * LOOK_SENSITIVITY;
    // Mouse up (negative movementY) decreases pitch → camera drops, you look up.
    this.pitch += lookDY * LOOK_SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(this.pitch, PITCH_MIN, PITCH_MAX);

    if (wheel !== 0) {
      this.targetDistance = THREE.MathUtils.clamp(
        this.targetDistance + wheel * ZOOM_STEP,
        ZOOM_MIN,
        ZOOM_MAX,
      );
    }

    const zoomT = 1 - Math.exp(-ZOOM_SMOOTH * delta);
    this.distance = THREE.MathUtils.lerp(this.distance, this.targetDistance, zoomT);

    this.computeDesiredPosition();

    const followT = 1 - Math.exp(-CAMERA_FOLLOW * delta);
    this.camera.position.lerp(this.desired, followT);

    this.player.getLookAtPoint(this.lookAt);
    this.camera.lookAt(this.lookAt);
  }

  /** Snap without lag — used on init so the first frame isn't behind. */
  syncImmediate(): void {
    this.computeDesiredPosition();
    this.camera.position.copy(this.desired);
    this.player.getLookAtPoint(this.lookAt);
    this.camera.lookAt(this.lookAt);
  }

  /**
   * Convert yaw/pitch/distance into a world-space camera point.
   *
   *   x = sin(yaw) * cos(pitch) * distance
   *   y = sin(pitch) * distance
   *   z = cos(yaw) * cos(pitch) * distance
   *
   * Pitch is measured from the horizon so zoom stays consistent as you look up/down.
   */
  private computeDesiredPosition(): void {
    const cosPitch = Math.cos(this.pitch);
    this.sphericalOffset.set(
      Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cosPitch,
    );
    this.sphericalOffset.multiplyScalar(this.distance);

    this.player.getLookAtPoint(this.lookAt);
    this.desired.copy(this.lookAt).add(this.sphericalOffset);
  }
}
