// Tour-style throw on one dial (mouse/touch drag), ported from Godot swing.gd:
//   pull back (down)     power — how far you pull
//   pull to one side     disc angle — left = hyzer, right = anhyzer
//   flick forward (up)   throw — the flick's direction against the line of
//                        the pull is the release error ("+0.4°")
// Letting go without a flick cancels.

export const PULL_PX = 170;
const TILT_MAX = 40;
const FLICK_GAIN = 0.12;
const FLICK_SLOW = 0.35;
const THROUGH = -0.25;

export interface SwingEvents {
  /** Pull changed: power 0..1 and extra disc angle in degrees (+ = hyzer). */
  pull(power: number, hyzerDeg: number): void;
  /** Thrown: power and release error in degrees (+ = pushed right). */
  thrown(power: number, releaseDeg: number): void;
  cancel(): void;
}

type V = { x: number; y: number };
const len = (v: V) => Math.hypot(v.x, v.y);

export class Swing {
  phase: "idle" | "pull" | "flick" = "idle";
  /** Current dial position (x right, y down = pulled back), length ≤ 1. */
  dot: V = { x: 0, y: 0 };
  private origin: V = { x: 0, y: 0 };
  private max: V = { x: 0, y: 0 };
  private flickT0 = 0;
  private power = 0;
  private hyzer = 0;

  constructor(private ev: SwingEvents, private now: () => number = () => performance.now()) {}

  down(x: number, y: number) {
    this.phase = "pull";
    this.origin = { x, y };
    this.max = { x: 0, y: 0 };
    this.dot = { x: 0, y: 0 };
    this.power = 0;
    this.hyzer = 0;
  }

  move(x: number, y: number) {
    if (this.phase !== "idle") this.set({ x: (x - this.origin.x) / PULL_PX, y: (y - this.origin.y) / PULL_PX });
  }

  up(x: number, y: number) {
    if (this.phase === "idle") return;
    this.set({ x: (x - this.origin.x) / PULL_PX, y: (y - this.origin.y) / PULL_PX });
    if ((this.phase as string) === "idle") return; // set() may have completed the throw
    if (this.phase === "flick" && this.dot.y < this.max.y - 0.5) return this.complete(); // short flick
    this.phase = "idle";
    this.dot = { x: 0, y: 0 };
    this.ev.cancel();
  }

  private set(d: V) {
    const l = len(d);
    if (l > 1) d = { x: d.x / l, y: d.y / l };
    const prev = this.dot;
    this.dot = d;
    if (this.phase === "pull") {
      if (d.y > 0 && len(d) >= len(this.max)) this.max = d;
      if (d.y > 0) {
        this.power = len(d);
        if (len(d) > 0.15) this.hyzer = -Math.max(-TILT_MAX, Math.min(TILT_MAX, (Math.atan2(d.x, d.y) * 180) / Math.PI));
        this.ev.pull(this.power, this.hyzer);
      }
      // Moving back up quickly from a real pull = the flick has begun.
      if (len(this.max) > 0.08 && d.y < this.max.y - 0.12 && d.y < prev.y) {
        this.phase = "flick";
        this.flickT0 = this.now();
      }
    }
    if (this.phase === "flick") {
      if (d.y <= THROUGH) this.complete();
      else if (d.y > this.max.y - 0.04) this.phase = "pull"; // pulled back again: re-load
    }
  }

  private complete() {
    const dir = { x: this.dot.x - this.max.x, y: this.dot.y - this.max.y };
    const ideal = { x: -this.max.x, y: -this.max.y };
    let err = 0;
    if (len(dir) > 0.01 && len(ideal) > 0.01) {
      // Signed angle from the ideal flick to the actual one; + = pushed right.
      err = (Math.atan2(ideal.x * dir.y - ideal.y * dir.x, ideal.x * dir.x + ideal.y * dir.y) * 180) / Math.PI;
    }
    const releaseDeg = Math.max(-12, Math.min(12, err * FLICK_GAIN));
    const slow = (this.now() - this.flickT0) / 1000 > FLICK_SLOW;
    // Power = the deepest point of the pull (the flick's own path must not eat into it).
    const p = Math.max(0.05, len(this.max) * (slow ? 0.92 : 1));
    this.phase = "idle";
    this.dot = { x: 0, y: 0 };
    this.ev.thrown(p, releaseDeg);
  }
}
