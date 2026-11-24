// The round: holes, lies, strokes, penalties and what each throw does.
// Pure logic (no three.js) so it can be tested; ported from the Godot
// round_controller / throw_controller / game_state / throw_skill.

import { DISCS, REACH, STYLES, coeffsFor } from "../shared/catalog";
import { Phase, Result, State, Style, TRAY_LOW, makeLaunch, simulate, yawForward } from "../shared/physics";
import { V3, clamp, degToRad } from "../shared/vec";
import { World, holeWind } from "../shared/world";

/** Techniques offered in tour mode (indices into STYLES). */
export const TECHNIQUES = ["bh_drive", "bh_stand", "fh", "push_putt"] as const;
export type Technique = (typeof TECHNIQUES)[number];

export const ASSIST = { name: "Standard", spread: 1, preview: 0.4 };

export function styleOf(id: string): Style {
  return STYLES.find((s) => s.id === id)!;
}

export function isPutt(id: string): boolean {
  return id === "push_putt" || id === "spin_putt";
}

/** Tour wording. */
export function stanceOf(id: string): string {
  if (id === "bh_drive") return "RUN-UP";
  if (isPutt(id)) return "PUTT";
  return "STANDSTILL";
}
export function techniqueName(id: string): string {
  return id === "fh" ? "FOREHAND" : isPutt(id) ? "PUSH PUTT" : "BACKHAND";
}

export function autoTechnique(dist: number): Technique {
  if (dist < 11) return "push_putt";
  if (dist < 55) return "bh_stand";
  return "bh_drive";
}

export function scoreName(strokes: number, par: number): string {
  if (strokes === 1) return "ACE!";
  const d = strokes - par;
  return ({ [-3]: "Albatross!", [-2]: "Eagle!", [-1]: "Birdie", 0: "Par", 1: "Bogey", 2: "Double bogey" } as Record<number, string>)[d] ?? `+${d}`;
}

export const rel = (d: number) => (d === 0 ? "E" : d > 0 ? `+${d}` : `${d}`);

/** Degrees of aim error for |lat| = 1: putts are precise, drives big. */
export function spreadDeg(power: number, id: string): number {
  return (isPutt(id) ? 1.15 + 0.8 * power : 2.5 + 4.5 * power) * ASSIST.spread;
}

/** Release error -> yaw offset (rad, + = right) and extra wobble. */
export function skill(lat: number, power: number, id: string): { yaw: number; wobble: number } {
  return { yaw: degToRad(lat * spreadDeg(power, id)), wobble: 0.35 * Math.max(0, Math.abs(lat) - 1) };
}

export type Mode = "aim" | "flight" | "settle" | "hole_done" | "round_done";

export interface ThrowOutcome {
  result: Result;
  /** Message for the player ("Birdie (chains)", "Out of bounds! +1 …"). */
  text: string;
  penalty: boolean;
  holed: boolean;
}

export class Round {
  mode: Mode = "aim";
  holeIdx = 0;
  strokes = 0;
  scores: number[] = [];
  lie = new V3();
  prevLie = new V3();
  aimYaw = 0;
  technique: Technique = "bh_drive";
  discIdx = 4;
  /** Driver the player last chose for tee shots. */
  driveIdx = 4;
  power = 0.6;
  hyzerDeg = 0;
  lineDeg = 0;
  throwSeed = 0;
  last: ThrowOutcome | null = null;

  constructor(public world: World) {}

  get hole() {
    return this.world.holes[this.holeIdx];
  }
  get basket(): V3 {
    const b = this.hole.basket;
    return new V3(b.x, b.y, b.z);
  }
  distToBasket(from = this.lie): number {
    return Math.hypot(this.basket.x - from.x, this.basket.z - from.z);
  }
  get style(): Style {
    return styleOf(this.technique);
  }
  get par(): number {
    return this.world.holes.reduce((s, h, i) => s + (i < this.scores.length ? h.par : 0), 0);
  }
  get total(): number {
    return this.scores.reduce((a, b) => a + b, 0);
  }

  startHole(i: number) {
    this.holeIdx = i;
    this.strokes = 0;
    const t = this.hole.tee;
    this.lie = new V3(t.x, t.y, t.z);
    this.prevLie = this.lie.clone();
    this.world.wind = holeWind(this.world, i);
    this.setupLie(true);
  }

  /** Aim at the basket (or the first dogleg from the tee), pick technique + disc, suggest power. */
  setupLie(fromTee = false) {
    this.mode = "aim";
    this.hyzerDeg = 0;
    this.lineDeg = this.style.line;
    const path = this.hole.path;
    const aimAt = fromTee && path.length > 2 ? path[1] : { x: this.basket.x, y: this.basket.z };
    const dx = aimAt.x - this.lie.x;
    const dz = aimAt.y - this.lie.z;
    this.aimYaw = Math.atan2(dx, -dz);
    const dist = this.distToBasket();
    this.setTechnique(autoTechnique(dist), false);
    if (dist < 22) this.discIdx = 0;
    else if (fromTee || this.discIdx === 0) this.discIdx = this.driveIdx;
    this.suggestPower(Math.hypot(dx, dz));
  }

  setTechnique(id: Technique, suggest = true) {
    this.technique = id;
    this.lineDeg = this.style.line;
    if (suggest) this.suggestPower(this.distToBasket());
  }

  selectDisc(i: number) {
    this.discIdx = clamp(i, 0, DISCS.length - 1);
    if (this.discIdx >= 3) this.driveIdx = this.discIdx;
    this.suggestPower(this.distToBasket());
  }

  isTapIn(): boolean {
    return this.distToBasket() < REACH;
  }

  /** Where the disc leaves the hand: a bit ahead of the lie at shoulder/hip height. */
  releasePoint(): V3 {
    const fwd = yawForward(this.aimYaw);
    const ground = this.world.standHeightAt(this.lie.x, this.lie.z);
    const h = isPutt(this.technique) ? 0.95 : 1.05;
    return new V3(this.lie.x, ground + h, this.lie.z).add(fwd.mul(0.35));
  }

  /** Release yaw that sends the line through the aim point at the basket's distance. */
  aimedYaw(from: V3): number {
    const reach = clamp(this.distToBasket(), 3, 60);
    const target = this.lie.add(yawForward(this.aimYaw).mul(reach));
    return Math.atan2(target.x - from.x, -(target.z - from.z));
  }

  launchState(power: number, extraYaw = 0, wobble = 0): State {
    const from = this.releasePoint();
    const s = this.style;
    return makeLaunch(from, this.aimedYaw(from) + extraYaw, power, this.lineDeg, s.nose, s.hyzer + this.hyzerDeg, s, wobble);
  }

  /** Mean-wind flight for the aim preview. */
  preview(power = this.power): Result {
    return simulate(this.world, this.launchState(power), coeffsFor(this.discIdx, ""), null, 0, 16, false);
  }

  /** Binary-search the power that lands at `goal` metres (putts: aim a little past, at chain height). */
  suggestPower(goal: number) {
    const c = coeffsFor(this.discIdx, "");
    const search = (target: number, toContact: boolean) => {
      let lo = 0.05;
      let hi = 1;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        const r = simulate(this.world, this.launchState(mid), c, null, 0, 16, toContact);
        if (r.distance() < target) lo = mid;
        else hi = mid;
      }
      return clamp((lo + hi) / 2, 0.05, 1);
    };
    if (goal < 22) {
      this.power = search(goal + clamp(4.2 - 0.14 * goal, 2.2, 3), true);
      this.lineDeg = this.puttLine(goal, this.power);
    } else {
      this.power = search(goal, false);
    }
  }

  /** Higher line = higher arrival; find the line that meets the chains' middle. */
  private puttLine(dist: number, power: number): number {
    const chainY = this.basket.y + 1.04;
    const c = coeffsFor(this.discIdx, "");
    const keep = this.lineDeg;
    let lo = -6;
    let hi = 18;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      this.lineDeg = mid;
      const r = simulate(this.world, this.launchState(power), c, null, 0, 16, true);
      let y = -Infinity;
      for (const q of r.positions) {
        if (Math.hypot(q.x - this.lie.x, q.z - this.lie.z) >= dist) {
          y = q.y;
          break;
        }
      }
      if (y < chainY) lo = mid;
      else hi = mid;
    }
    this.lineDeg = keep;
    return (lo + hi) / 2;
  }

  /** Throw with `power` (0..1.05) and release error `lat` (0 = clean). Returns the outcome. */
  throw(power: number, lat: number): ThrowOutcome {
    this.throwSeed++;
    let result: Result;
    if (this.isTapIn()) {
      result = tapIn(this.releasePoint(), this.basket);
    } else {
      const sk = skill(lat, power, this.technique);
      const wob = this.style.wobble * power * power + sk.wobble;
      result = simulate(this.world, this.launchState(power, sk.yaw, wob), coeffsFor(this.discIdx, ""), this.basket, this.throwSeed * 7919 + this.holeIdx);
    }
    return this.record(result);
  }

  /**
   * Count a throw whose flight is already known (online: the thrower's
   * browser computed it, so everyone plays back exactly the same flight).
   */
  record(result: Result): ThrowOutcome {
    this.strokes++;
    this.prevLie = this.lie.clone();
    this.mode = "flight";
    const outcome = this.describe(result);
    this.last = outcome;
    return outcome;
  }

  private describe(r: Result): ThrowOutcome {
    const holed = r.phase === Phase.HOLED;
    const penalty = r.phase === Phase.OUT || r.phase === Phase.WATER;
    let text: string;
    if (holed) {
      const name = scoreName(this.strokes, this.hole.par);
      text = this.strokes === 1 ? name : `${name}  (${r.events.includes("chains") ? "chains" : "in the tray"})`;
    } else if (r.phase === Phase.WATER) text = `Splash! +1 — ${this.reliefWords(r)}`;
    else if (r.phase === Phase.OUT) text = `Out of bounds! +1 — ${this.reliefWords(r)}`;
    else if (r.phase === Phase.STUCK) text = r.events.includes("bush") ? "Into the bush — play it from there" : "Stuck in the tree! Play from directly below";
    else {
      const extra = r.events.includes("on_top") ? " — on top of the basket!" : r.events.includes("spit") ? " — spit out!" : r.events.includes("rim_out") ? " — rattled off the rim!" : r.events.includes("tree") || r.events.includes("branch") ? " — tree!" : r.events.includes("roll") ? " — roller" : "";
      text = `${Math.round(r.distance())} m${extra}`;
    }
    return { result: r, text, penalty, holed };
  }

  private reliefWords(r: Result): string {
    if (this.hole.dropZone) return "play from the drop zone";
    return r.relief ? "play from where it went out" : "rethrow";
  }

  /**
   * After the disc has settled: record the hole, or move the lie
   * (penalties: +1 and the drop zone / relief spot / previous lie).
   * Returns what happens next.
   */
  afterSettle(): "next_lie" | "hole_done" | "round_done" {
    const o = this.last!;
    const r = o.result;
    if (o.holed) {
      this.scores.push(this.strokes);
      this.mode = this.scores.length >= this.world.holes.length ? "round_done" : "hole_done";
      return this.mode === "round_done" ? "round_done" : "hole_done";
    }
    if (o.penalty) {
      this.strokes++;
      const dz = this.hole.dropZone;
      this.lie = dz ? new V3(dz.x, dz.y, dz.z) : r.relief ? r.relief.clone() : this.prevLie.clone();
    } else {
      let p = r.finalPos.clone();
      if (r.events.includes("on_top")) {
        const away = new V3(this.prevLie.x - p.x, 0, this.prevLie.z - p.z).normalized().mul(0.8);
        p = p.add(away);
      }
      this.lie = new V3(p.x, this.world.heightAt(p.x, p.z), p.z);
    }
    this.setupLie(false);
    return "next_lie";
  }

  nextHole(): boolean {
    if (this.holeIdx + 1 >= this.world.holes.length) return false;
    this.startHole(this.holeIdx + 1);
    return true;
  }
}

/** Hand-placed into the tray: a short scripted drop instead of a flight. */
function tapIn(from: V3, basket: V3): Result {
  const r = new Result();
  const to = basket.add(new V3(0, TRAY_LOW + 0.06, 0));
  const frames = 24;
  for (let i = 0; i <= frames; i++) {
    const u = i / frames;
    r.positions.push(from.add(to.sub(from).mul(u)).add(new V3(0, Math.sin(u * Math.PI) * 0.12, 0)));
    r.normals.push(V3.UP.clone());
  }
  r.startPos = from;
  r.finalPos = to;
  r.firstContact = to;
  r.phase = Phase.HOLED;
  r.addEvent("tray");
  return r;
}

/** A flight as plain JSON (mm precision) for sending to other players. */
export interface FlightJson {
  pos: number[];
  nrm: number[];
  phase: number;
  events: string[];
  log: { t: number; type: string; pos: [number, number, number]; id: number }[];
  start: number[];
  end: number[];
  endNormal: number[];
  first: number[];
  air: number;
  relief: number[] | null;
}

const q3 = (v: number) => Math.round(v * 1000) / 1000;
const flat = (vs: V3[]) => vs.flatMap((v) => [q3(v.x), q3(v.y), q3(v.z)]);
const unflat = (a: number[]) => Array.from({ length: a.length / 3 }, (_, i) => new V3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]));
const arr = (v: V3) => [q3(v.x), q3(v.y), q3(v.z)];

export function flightToJson(r: Result): FlightJson {
  return {
    pos: flat(r.positions),
    nrm: flat(r.normals),
    phase: r.phase,
    events: [...r.events],
    log: r.log.map((e) => ({ ...e, t: q3(e.t) })),
    start: arr(r.startPos),
    end: arr(r.finalPos),
    endNormal: arr(r.finalNormal),
    first: arr(r.firstContact),
    air: q3(r.airTime),
    relief: r.relief ? arr(r.relief) : null,
  };
}

export function flightFromJson(j: FlightJson): Result {
  const r = new Result();
  r.positions = unflat(j.pos);
  r.normals = unflat(j.nrm);
  r.phase = j.phase as Phase;
  r.events = [...j.events];
  r.log = j.log;
  r.startPos = V3.of(j.start);
  r.finalPos = V3.of(j.end);
  r.finalNormal = V3.of(j.endNormal);
  r.firstContact = V3.of(j.first);
  r.airTime = j.air;
  r.relief = j.relief ? V3.of(j.relief) : null;
  return r;
}
