import type { PlayerController } from "./PlayerController";

const STICK_RADIUS = 60;   // px
const SPRINT_DEFLECTION = 0.85; // push the stick to the rim to sprint
const LOOK_SENS = 0.0055;  // rad per px

/**
 * Touch input: left-region dynamic joystick (move; rim = sprint), right-region
 * drag to look, plus the HTML action buttons (grab/jump/light). Values persist
 * between touch events, so nothing needs per-frame polling.
 */
export class TouchControls {
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private base: HTMLElement;
  private nub: HTMLElement;

  constructor(
    private controller: PlayerController,
    actions: { onInteract: () => void }
  ) {
    this.base = document.getElementById("stickBase")!;
    this.nub = document.getElementById("stickNub")!;

    const layer = document.body;
    layer.addEventListener("touchstart", this.onStart, { passive: false });
    layer.addEventListener("touchmove", this.onMove, { passive: false });
    layer.addEventListener("touchend", this.onEnd, { passive: false });
    layer.addEventListener("touchcancel", this.onEnd, { passive: false });

    const bind = (id: string, fn: () => void) => {
      document.getElementById(id)!.addEventListener(
        "touchstart",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          fn();
        },
        { passive: false }
      );
    };
    bind("btnGrab", actions.onInteract);
    bind("btnJump", () => this.controller.queueJump());
    bind("btnTorch", () => (this.controller.torch = !this.controller.torch));
  }

  private uiTarget(e: TouchEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t?.closest("#touchButtons, #results, #menu, button, input");
  }

  private onStart = (e: TouchEvent) => {
    if (this.uiTarget(e)) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < window.innerWidth * 0.45 && this.stickId === null) {
        this.stickId = t.identifier;
        this.stickOrigin = { x: t.clientX, y: t.clientY };
        this.base.style.left = `${t.clientX}px`;
        this.base.style.top = `${t.clientY}px`;
        this.base.classList.add("active");
        this.setNub(0, 0);
      } else if (this.lookId === null) {
        this.lookId = t.identifier;
        this.lookLast = { x: t.clientX, y: t.clientY };
      }
    }
  };

  private onMove = (e: TouchEvent) => {
    if (this.uiTarget(e)) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        let dx = t.clientX - this.stickOrigin.x;
        let dy = t.clientY - this.stickOrigin.y;
        const d = Math.hypot(dx, dy);
        if (d > STICK_RADIUS) {
          dx = (dx / d) * STICK_RADIUS;
          dy = (dy / d) * STICK_RADIUS;
        }
        this.setNub(dx, dy);
        const mag = Math.min(d / STICK_RADIUS, 1);
        // screen-up = forward = local -z, matching keyboard input space
        this.controller.setTouchInput(
          dx / STICK_RADIUS,
          dy / STICK_RADIUS,
          mag >= SPRINT_DEFLECTION
        );
      } else if (t.identifier === this.lookId) {
        const dx = t.clientX - this.lookLast.x;
        const dy = t.clientY - this.lookLast.y;
        this.lookLast = { x: t.clientX, y: t.clientY };
        this.controller.yaw -= dx * LOOK_SENS;
        this.controller.pitch = Math.max(
          -1.45,
          Math.min(1.45, this.controller.pitch - dy * LOOK_SENS)
        );
      }
    }
  };

  private onEnd = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickId) {
        this.stickId = null;
        this.controller.setTouchInput(0, 0, false);
        this.base.classList.remove("active");
      } else if (t.identifier === this.lookId) {
        this.lookId = null;
      }
    }
  };

  private setNub(dx: number, dy: number) {
    this.nub.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}
