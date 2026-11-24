// Release timing, ported from Godot throw_skill.gd / throw_controller.gd.
// Used by the Arcade keyboard meter (hold = power, let go, tap in the zone)
// and by the Sim run-up (the flick must land on the X-step's plant).

import { isPutt } from "./round";

/** Seconds for the power bar to fill (putts are a slower, finer motion). */
export const chargeTime = (tech: string) => (isPutt(tech) ? 1.6 : 1.0);
/** Bar holds a little past full: overpowering. */
export const CHARGE_MAX = 1.05;
/** Needle speed, bar widths per second. */
export const NEEDLE_SPEED = 1.4;

/** Half-width of the release window (s): forgiving for soft throws, tight at full power. */
export function windowSecs(power: number, tech: string): number {
  const p = Math.min(1, Math.max(0, power));
  const w = 0.11 + (0.055 - 0.11) * p;
  return isPutt(tech) ? w * 1.25 : w;
}

/** Timing error (s, early < 0 < late) -> release error. Late backhand pulls left; forehand mirrors. */
export function timingToLat(errS: number, power: number, tech: string): number {
  const units = errS / windowSecs(power, tech);
  return tech === "fh" ? units : -units;
}

export function verdict(errS: number, power: number, tech: string): { text: string; good: boolean } {
  const w = windowSecs(power, tech);
  if (Math.abs(errS) <= w * 0.4) return { text: tech === "bh_drive" ? "Perfect run-up" : "Perfect release", good: true };
  if (Math.abs(errS) <= w) return { text: tech === "bh_drive" ? "Good run-up" : "Good release", good: true };
  const what = tech === "bh_drive" ? "run-up" : "release";
  return { text: errS < 0 ? `Early ${what}` : `Late ${what}`, good: false };
}

/**
 * The two-stage keyboard meter. `hold` fills power; `letGo` locks it and the
 * throw animation starts (the release lands `releaseIn` seconds later);
 * `tap` judges the timing against that moment. No tap at all = very late.
 */
export class Meter {
  phase: "idle" | "charge" | "timing" = "idle";
  charge = 0;
  power = 0;
  /** Seconds since the power was locked. */
  t = 0;
  releaseIn = 1;
  result: { power: number; errS: number } | null = null;

  constructor(public tech: string) {}

  start() {
    this.phase = "charge";
    this.charge = 0;
    this.result = null;
  }

  /** Lock power (returns false for a mere tap: too little power = cancel). */
  letGo(releaseIn: number): boolean {
    if (this.phase !== "charge") return false;
    if (this.charge < 0.05) {
      this.phase = "idle";
      return false;
    }
    this.power = Math.min(this.charge, CHARGE_MAX);
    this.releaseIn = releaseIn;
    this.t = 0;
    this.phase = "timing";
    return true;
  }

  tap() {
    if (this.phase !== "timing" || this.result) return;
    this.result = { power: this.power, errS: this.t - this.releaseIn };
    this.phase = "idle";
  }

  tick(dt: number) {
    if (this.phase === "charge") this.charge = Math.min(CHARGE_MAX, this.charge + dt / chargeTime(this.tech));
    else if (this.phase === "timing") {
      this.t += dt;
      // Missed it altogether: count as a ragged late release.
      if (this.t - this.releaseIn > windowSecs(this.power, this.tech) * 1.6) this.tap();
    }
  }

  /** Needle position relative to the zone centre, in bar widths (0 = perfect, < 0 = before). */
  needle(): number {
    return (this.t - this.releaseIn) * NEEDLE_SPEED;
  }
  zoneHalf(): number {
    return windowSecs(this.power, this.tech) * NEEDLE_SPEED;
  }
}
