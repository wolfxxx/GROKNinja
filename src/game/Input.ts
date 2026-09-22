/**
 * Keyboard + mouse input.
 * Look deltas and jump are consumed once per frame so they don't accumulate.
 */
export class Input {
  readonly keys = new Set<string>();

  pointerLocked = false;

  private mouseDX = 0;
  private mouseDY = 0;
  private wheelDelta = 0;
  private jumpQueued = false;
  private rollQueued = false;
  private kickQueued = false;
  private jumpHitQueued = false;
  private dragging = false;
  private helpersQueued = false;
  private muteQueued = false;
  private pauseQueued = false;

  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly hintEl: HTMLElement | null,
  ) {
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
    this.onMouseUp = this.onMouseUp.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onWheel = this.onWheel.bind(this);
    this.onPointerLockChange = this.onPointerLockChange.bind(this);
    this.onContextMenu = this.onContextMenu.bind(this);
    this.onBlur = this.onBlur.bind(this);
  }

  attach(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    window.addEventListener("mousemove", this.onMouseMove);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("wheel", this.onWheel);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  isSprinting(): boolean {
    return this.isDown("Space");
  }

  /** Horizontal WASD as a unit-ish vector in camera space (x = right, z = forward). */
  getMoveAxes(): { x: number; z: number } {
    const x =
      (this.isDown("KeyD") ? 1 : 0) - (this.isDown("KeyA") ? 1 : 0);
    const z =
      (this.isDown("KeyW") ? 1 : 0) - (this.isDown("KeyS") ? 1 : 0);
    return { x, z };
  }

  consumeLook(): { dx: number; dy: number } {
    const look = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return look;
  }

  consumeWheel(): number {
    const value = this.wheelDelta;
    this.wheelDelta = 0;
    return value;
  }

  consumeJump(): boolean {
    const jumped = this.jumpQueued;
    this.jumpQueued = false;
    return jumped;
  }

  consumeRoll(): boolean {
    const rolled = this.rollQueued;
    this.rollQueued = false;
    return rolled;
  }

  consumeKick(): boolean {
    const kicked = this.kickQueued;
    this.kickQueued = false;
    return kicked;
  }

  consumeJumpHit(): boolean {
    const hit = this.jumpHitQueued;
    this.jumpHitQueued = false;
    return hit;
  }

  consumeHelpersToggle(): boolean {
    const toggled = this.helpersQueued;
    this.helpersQueued = false;
    return toggled;
  }

  consumeMuteToggle(): boolean {
    const toggled = this.muteQueued;
    this.muteQueued = false;
    return toggled;
  }

  consumePauseToggle(): boolean {
    const toggled = this.pauseQueued;
    this.pauseQueued = false;
    return toggled;
  }

  /** Drop actions pressed while paused so nothing fires the moment play resumes. */
  clearQueued(): void {
    this.jumpQueued = false;
    this.rollQueued = false;
    this.kickQueued = false;
    this.jumpHitQueued = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
  }

  requestLock(): void {
    if (!this.pointerLocked) void this.canvas.requestPointerLock();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.code === "KeyM" && !event.repeat) this.muteQueued = true;
    if (event.code === "KeyP" && !event.repeat) this.pauseQueued = true;
    if (event.code === "ShiftLeft") {
      event.preventDefault();
      if (!event.repeat) this.jumpQueued = true;
    }
    if (event.code === "Space") {
      event.preventDefault();
    }
    if (event.code === "ControlLeft" || event.code === "ControlRight") {
      event.preventDefault();
      if (!event.repeat) this.rollQueued = true;
    }
    if (event.code === "KeyH" && !event.repeat) {
      this.helpersQueued = true;
    }
    this.keys.add(event.code);
  }

  private onKeyUp(event: KeyboardEvent): void {
    this.keys.delete(event.code);
  }

  private onMouseDown(event: MouseEvent): void {
    if (event.button === 2) {
      event.preventDefault();
      if (!this.pointerLocked) {
        void this.canvas.requestPointerLock();
      } else {
        this.jumpHitQueued = true;
      }
      return;
    }

    if (event.button !== 0) return;

    if (!this.pointerLocked) {
      void this.canvas.requestPointerLock();
    } else {
      this.kickQueued = true;
    }
    this.dragging = true;
  }

  private onMouseUp(event: MouseEvent): void {
    if (event.button === 0) this.dragging = false;
  }

  private onMouseMove(event: MouseEvent): void {
    if (this.pointerLocked || this.dragging) {
      this.mouseDX += event.movementX;
      this.mouseDY += event.movementY;
    }
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    // Normalize mouse / trackpad: positive deltaY = zoom out.
    const direction = Math.sign(event.deltaY) || 1;
    this.wheelDelta += direction;
  }

  private onPointerLockChange(): void {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    this.hintEl?.classList.toggle("is-hidden", this.pointerLocked);
    if (!this.pointerLocked) this.dragging = false;
    this.onLockChange?.(this.pointerLocked);
  }

  private onContextMenu(event: Event): void {
    event.preventDefault();
  }

  private onBlur(): void {
    this.keys.clear();
    this.dragging = false;
  }
}
