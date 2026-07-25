import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import {
  WALK_SPEED,
  SPRINT_SPEED,
  CROUCH_SPEED,
  STAMINA_DRAIN_PER_S,
  STAMINA_REGEN_PER_S,
  STAMINA_MIN_SPRINT,
  CROUCH_DETECT_SPEED,
  noiseForSpeed,
} from "../../../shared/messages";

const GRAVITY = 22;
const JUMP_SPEED = 7.0;
const EYE_OFFSET = 0.65;  // eyes above capsule center -> ~1.7m eye height
const CROUCH_EYE = 0.05;  // ducked: ~1.1m eye height
const DOWNED_EYE = -0.5;  // face on the carpet
const EYE_LERP = 9;       // how fast the camera settles into a new stance
const MOUSE_SENS = 0.0023;
const MAX_PITCH = 1.45;

/**
 * First-person kinematic character: pointer-lock mouse look + WASD movement
 * resolved through Rapier's KinematicCharacterController (auto-step,
 * snap-to-ground, slide-along-walls all come from Rapier).
 */
export class PlayerController {
  yaw = 0;
  pitch = 0;
  torch = true;
  /** 0..1; drains while sprinting, refills while walking/idle. The server
   *  runs the same simulation from observed speeds and clamps cheaters —
   *  this local copy exists so the speed change feels instant. */
  stamina = 1;
  staminaLocked = false;
  /** Ducked: much slower, much quieter, much harder to spot at range. */
  crouching = false;
  /** On the floor after being caught: no input until somebody helps you up. */
  downed = false;
  /** Scale applied to stamina drain by the CONDITIONING upgrade. */
  staminaDrainScale = 1;
  /** How loud this client believes it is, for the HUD meter (0.25..1.75). */
  noise = 0.25;
  /** Fired on interact press while pointer-locked (grab / door / gear). */
  onInteract?: () => void;
  /** Fired on R: load a fresh flashlight cell. */
  onSwapCell?: () => void;
  /** Fired once per footstep worth of actual movement. */
  onStep?: (sprinting: boolean, crouching: boolean) => void;
  /** Touch devices: no pointer lock; input arrives via setTouchInput(). */
  touchMode = false;
  /** Touch GRAB button held down (drives revives the same way E does). */
  touchInteract = false;

  private touchX = 0;
  private touchZ = 0;
  private touchSprint = false;

  private body: RAPIER.RigidBody;
  private collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;
  private velY = 0;
  private keys = new Set<string>();
  private jumpQueued = false;
  private stepAccum = 0;
  private eye = EYE_OFFSET;

  constructor(
    private world: RAPIER.World,
    R: typeof RAPIER,
    private camera: THREE.PerspectiveCamera,
    spawn: { x: number; y: number; z: number },
    private domElement: HTMLElement
  ) {
    this.body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(
        spawn.x,
        spawn.y,
        spawn.z
      )
    );
    // halfHeight 0.6 + radius 0.4 => 2.0m tall capsule
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(0.6, 0.4),
      this.body
    );

    this.controller = world.createCharacterController(0.02);
    this.controller.enableAutostep(0.4, 0.3, true);
    this.controller.enableSnapToGround(0.35);
    this.controller.setSlideEnabled(true);

    camera.rotation.order = "YXZ";

    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("blur", () => this.keys.clear());
    domElement.addEventListener("click", () => {
      if (!this.touchMode && !this.isLocked()) domElement.requestPointerLock();
    });
  }

  /** True while the interact key/button is held (revives need a hold). */
  get interactHeld(): boolean {
    return this.touchInteract || this.keys.has("KeyE");
  }

  /** Joystick input in keyboard space (x right, z forward-negative). */
  setTouchInput(x: number, z: number, sprint: boolean) {
    this.touchX = x;
    this.touchZ = z;
    this.touchSprint = sprint;
  }

  queueJump() {
    this.jumpQueued = true;
  }

  isLocked(): boolean {
    return document.pointerLockElement === this.domElement;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.isLocked()) return;
    this.keys.add(e.code);
    if (e.code === "Space") {
      this.jumpQueued = true;
      e.preventDefault();
    }
    if (e.code === "KeyF") this.torch = !this.torch;
    if (e.code === "KeyE") this.onInteract?.();
    if (e.code === "KeyR") this.onSwapCell?.();
    // hold Ctrl or toggle C — both idioms show up in this genre
    if (e.code === "KeyC") this.crouching = !this.crouching;
  };

  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  private onMouseMove = (e: MouseEvent) => {
    if (!this.isLocked()) return;
    this.yaw -= e.movementX * MOUSE_SENS;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - e.movementY * MOUSE_SENS,
      -MAX_PITCH,
      MAX_PITCH
    );
  };

  /** True when the player is ducking this frame (toggle or held Ctrl). */
  get ducking(): boolean {
    return this.crouching || this.keys.has("ControlLeft") || this.keys.has("ControlRight");
  }

  update(dt: number) {
    // input direction in local space (keyboard + virtual joystick)
    let ix = this.touchX;
    let iz = this.touchZ;
    if (this.keys.has("KeyW")) iz -= 1;
    if (this.keys.has("KeyS")) iz += 1;
    if (this.keys.has("KeyA")) ix -= 1;
    if (this.keys.has("KeyD")) ix += 1;
    // downed players are dead weight until somebody picks them up
    if (this.downed) {
      ix = 0;
      iz = 0;
    }

    const ducking = this.ducking && !this.downed;
    const moving = Math.hypot(ix, iz) > 0.15;
    // you cannot sprint from a crouch — stand up first
    const wantsSprint =
      (this.keys.has("ShiftLeft") || this.touchSprint) && moving && !ducking;
    const sprinting = wantsSprint && !this.staminaLocked && this.stamina > 0;
    if (sprinting) {
      this.stamina = Math.max(
        0,
        this.stamina - STAMINA_DRAIN_PER_S * this.staminaDrainScale * dt
      );
      if (this.stamina <= 0) this.staminaLocked = true;
    } else {
      this.stamina = Math.min(1, this.stamina + STAMINA_REGEN_PER_S * dt);
      if (this.stamina >= STAMINA_MIN_SPRINT) this.staminaLocked = false;
    }

    const speed = ducking ? CROUCH_SPEED : sprinting ? SPRINT_SPEED : WALK_SPEED;
    const move = new THREE.Vector3(moving ? ix : 0, 0, moving ? iz : 0);
    if (move.lengthSq() > 0) {
      move.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
      move.multiplyScalar(speed * dt);
    }

    // vertical: manual gravity, Rapier resolves collisions
    const grounded = this.controller.computedGrounded();
    if (grounded && this.jumpQueued && !ducking && !this.downed) {
      this.velY = JUMP_SPEED;
    } else if (grounded && this.velY <= 0) {
      this.velY = -0.5; // small downward bias keeps ground contact on slopes
    } else {
      this.velY = Math.max(this.velY - GRAVITY * dt, -30);
    }
    this.jumpQueued = false;

    this.controller.computeColliderMovement(this.collider, {
      x: move.x,
      y: this.velY * dt,
      z: move.z,
    });
    const corrected = this.controller.computedMovement();
    const pos = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: pos.x + corrected.x,
      y: pos.y + corrected.y,
      z: pos.z + corrected.z,
    });

    this.world.timestep = Math.min(dt, 1 / 30);
    this.world.step();

    // footsteps from actual resolved movement (pushing a wall isn't a step)
    const movedH = Math.hypot(corrected.x, corrected.z);
    if (grounded && movedH > 0.0005 && !this.downed) {
      this.stepAccum += movedH;
      const stride = ducking ? 0.62 : sprinting ? 0.95 : 0.72;
      if (this.stepAccum >= stride) {
        this.stepAccum = 0;
        this.onStep?.(sprinting, ducking);
      }
    }

    // Mirror the server's noise tier from our own resolved speed, so the HUD
    // meter shows the number the monster is actually hearing.
    const observed = dt > 0 ? movedH / dt : 0;
    this.noise = noiseForSpeed(
      observed,
      ducking && observed <= CROUCH_DETECT_SPEED
    );

    // camera settles between standing / ducked / face-down
    const targetEye = this.downed ? DOWNED_EYE : ducking ? CROUCH_EYE : EYE_OFFSET;
    this.eye += (targetEye - this.eye) * Math.min(1, dt * EYE_LERP);

    const p = this.body.translation();
    this.camera.position.set(p.x, p.y + this.eye, p.z);
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
  }

  /** Capsule-center position, as sent over the network. */
  getPosition(): { x: number; y: number; z: number } {
    const p = this.body.translation();
    return { x: p.x, y: p.y, z: p.z };
  }

  /** Hard respawn teleport (server-ordered, e.g. after being caught). */
  teleport(x: number, y: number, z: number) {
    this.velY = 0;
    this.body.setTranslation({ x, y, z }, true);
    this.body.setNextKinematicTranslation({ x, y, z });
    this.camera.position.set(x, y + this.eye, z);
  }
}
