// Deterministic golf-disc flight + ground model (port of the Godot DiscPhysics).
//
// Aerodynamics follow Hummel (2003): lift, drag and pitching moment are
// functions of angle of attack. The pitching moment of a spinning disc turns
// into ROLL by gyroscopic precession, so turn and fade emerge from the flight
// numbers. Every collision is logged with its time so the renderer can sync
// effects to the playback. Chaos specials: bomb, saw, ghost, bounce, magnet.

import { Rng } from "./rng";
import { V3, clamp, degToRad, smoothstep, closestOnSegment3 } from "./vec";
import { Surface, Tree, World } from "./world";

export enum Phase { FLYING, SLIDING, ROLLING, REST, HOLED, WATER, OUT, STUCK }

const RHO = 1.225;
const MASS = 0.175;
export const RADIUS = 0.1055;
const AREA = Math.PI * RADIUS * RADIUS;
const DIAMETER = RADIUS * 2;
const INERTIA = 0.6 * MASS * RADIUS * RADIUS;
const GRAVITY = 9.81;
export const DT = 1 / 240;
const MAX_TIME = 16;
const RECORD_STRIDE = 4; // 60 Hz playback frames
export const FRAME_DT = DT * RECORD_STRIDE;

// Basket geometry, metres above the basket base.
export const CHAIN_R = 0.29;
export const CHAIN_LOW = 0.72;
export const CHAIN_HIGH = 1.36;
export const TRAY_R = 0.33;
export const TRAY_LOW = 0.45;
export const TRAY_TOP = 0.66;
export const BAND_LOW = 1.36;
export const BAND_HIGH = 1.46;
const POLE_R = 0.03;

// Per surface: rough, fairway, pad, mud, tall grass.
const SLIDE_MU = [0.85, 0.5, 0.3, 1.3, 2.4];
const ROLL_MU = [0.16, 0.08, 0.05, 0.45, 0.9];
const SKIP_KEEP = [0.5, 0.72, 0.82, 0.25, 0.1];
const DENSITY: Record<string, number> = { pine: 6, leaf: 8, bush: 9 };
const LODGE_SPEED = 3;
const LODGE_CHANCE = 0.55;

export interface Coeffs {
  cl0: number; cla: number; cd0: number; cda: number; cm0: number; cma: number; spin_decay: number; skip: number;
  bomb?: boolean; saw?: boolean; ghost?: boolean; magnet?: boolean; bounce?: number;
}

export interface DiscDef { name: string; kind: string; speed: number; glide: number; turn: number; fade: number; color: number }

export interface Style {
  id: string; name: string; forehand: boolean; max_speed: number; spin_ratio: number;
  line: number; hyzer: number; nose: number; wobble: number; auto_only?: boolean;
}

export interface FlightEvent { t: number; type: string; pos: [number, number, number]; id: number }

export class State {
  pos = new V3();
  vel = new V3();
  normal = V3.UP.clone();
  spin = 0;
  wobble = 0;
  phase = Phase.FLYING;
  copy(): State {
    const s = new State();
    s.pos = this.pos.clone();
    s.vel = this.vel.clone();
    s.normal = this.normal.clone();
    s.spin = this.spin;
    s.wobble = this.wobble;
    s.phase = this.phase;
    return s;
  }
}

export class Result {
  positions: V3[] = [];
  normals: V3[] = [];
  phase = Phase.REST;
  finalPos = new V3();
  finalNormal = V3.UP.clone();
  startPos = new V3();
  firstContact = new V3();
  airTime = 0;
  maxHeight = 0;
  events: string[] = [];
  lodgeRolled = false;
  /** Where to play from after water / OB (1 m back inside), or null. */
  relief: V3 | null = null;
  log: FlightEvent[] = [];
  cut = new Set<number>();
  ghosted = new Set<number>();
  exploded = false;

  distance(): number {
    return Math.hypot(this.finalPos.x - this.startPos.x, this.finalPos.z - this.startPos.z);
  }
  addEvent(e: string) {
    if (!this.events.includes(e)) this.events.push(e);
  }
  ev(t: number, type: string, pos: V3, id = -1) {
    this.addEvent(type);
    this.log.push({ t, type, pos: pos.arr(), id });
  }
}

/** Flight numbers -> aerodynamic coefficients. */
export function coefficients(d: DiscDef): Coeffs {
  return {
    cl0: 0.015 * d.glide - 0.005 * (d.speed - 5),
    cla: 2.0,
    cd0: 0.09 - 0.0045 * d.speed,
    cda: 1.2,
    cm0: -0.003 + 0.004 * d.turn,
    cma: 0.1 + 0.035 * d.fade,
    spin_decay: 0.06,
    skip: 0.72 + 0.025 * d.speed,
  };
}

export function yawForward(yaw: number): V3 {
  return new V3(Math.sin(yaw), 0, -Math.cos(yaw));
}

/** Release state. yaw 0 = north (-Z). hyzer > 0 tilts toward the fade side. */
export function makeLaunch(origin: V3, yaw: number, power: number, lineDeg: number, noseDeg: number, hyzerDeg: number, style: Style, wobble = 0): State {
  const st = new State();
  const speed = Math.max(1.5, style.max_speed * power);
  const fwd = yawForward(yaw);
  const right = fwd.cross(V3.UP);
  const line = degToRad(lineDeg);
  const dir = fwd.rotated(right, line);
  const spinSign = style.forehand ? 1 : -1;
  st.pos = origin.clone();
  st.vel = dir.mul(speed);
  st.spin = spinSign * speed * style.spin_ratio;
  const n = V3.UP.rotated(right, line + degToRad(noseDeg));
  st.normal = n.rotated(dir, degToRad(hyzerDeg) * spinSign).normalized();
  st.wobble = wobble;
  return st;
}

/** gustSeed 0 = mean wind only (used by the aim preview). basket null = none. */
export function simulate(world: World, start: State, c: Coeffs, basket: V3 | null, gustSeed = 0, maxTime = MAX_TIME, stopAtContact = false): Result {
  const st = start.copy();
  const res = new Result();
  res.startPos = st.pos.clone();
  res.maxHeight = st.pos.y;
  const rng = new Rng(gustSeed);
  let catchLock = 0;
  let t = 0;
  let step = 0;
  record(res, st);

  while (t < maxTime) {
    const prev = st.pos.clone();
    if (st.phase === Phase.FLYING) {
      stepAir(st, c, world.windAt(st.pos, t, gustSeed));
      if (c.magnet && basket) magnet(st, basket);
    } else if (st.phase === Phase.SLIDING || st.phase === Phase.ROLLING) stepGround(st, world, res, t);
    t += DT;
    step++;
    catchLock = Math.max(0, catchLock - DT);
    res.maxHeight = Math.max(res.maxHeight, st.pos.y);

    const logBefore = res.log.length;
    collideTrees(st, world, rng, res, t, c);
    if (basket) catchLock = collideBasket(st, prev, basket, res, catchLock, t);

    if (st.phase === Phase.FLYING || st.phase === Phase.SLIDING || st.phase === Phase.ROLLING) {
      const pond = world.inBounds(st.pos.x, st.pos.z) ? world.waterAt(st.pos) : null;
      if (!world.inBounds(st.pos.x, st.pos.z)) st.phase = Phase.OUT;
      else if (pond) {
        st.pos.y = pond.level;
        st.phase = Phase.WATER;
        res.ev(t, "water", st.pos);
      } else if (st.phase === Phase.FLYING) {
        const gh = world.heightAt(st.pos.x, st.pos.z);
        // Skimming low over long grass: blades grab the rim.
        if (st.pos.y - gh < 0.35 && world.surfaceAt(st.pos.x, st.pos.z) === Surface.TALL) st.vel = st.vel.mul(Math.exp(-4 * DT));
        if (st.pos.y <= gh + 0.012) {
          res.firstContact = st.pos.clone();
          res.airTime = t;
          if (stopAtContact) {
            st.pos.y = gh;
            st.phase = Phase.REST;
          } else land(st, world, res, t, c);
        }
      }
    }
    if (c.bomb && !res.exploded) maybeExplode(st, world, res, t, logBefore);
    if (step % RECORD_STRIDE === 0 || st.phase >= Phase.REST) record(res, st);
    if (st.phase >= Phase.REST) break;
  }

  if (st.phase < Phase.REST) st.phase = Phase.REST;
  if (st.phase === Phase.REST && world.isOb(st.pos.x, st.pos.z)) {
    st.phase = Phase.OUT;
    res.ev(t, "ob", st.pos);
  }
  if (res.airTime === 0) {
    res.airTime = t;
    res.firstContact = st.pos.clone();
  }
  res.phase = st.phase;
  res.finalPos = st.pos.clone();
  res.finalNormal = st.normal.clone();
  if (st.phase === Phase.OUT || st.phase === Phase.WATER) res.relief = reliefPoint(world, res);
  return res;
}

function reliefPoint(world: World, res: Result): V3 | null {
  for (let i = res.positions.length - 1; i >= 0; i--) {
    const q = res.positions[i];
    if (world.playable(q.x, q.z)) {
      let back = new V3();
      if (i > 0) {
        back = res.positions[i - 1].sub(q);
        back.y = 0;
      }
      let p = q.add(back.length() > 1e-4 ? back.normalized() : new V3());
      if (!world.playable(p.x, p.z)) p = q;
      return new V3(p.x, world.heightAt(p.x, p.z), p.z);
    }
  }
  return null;
}

function record(res: Result, st: State) {
  res.positions.push(st.pos.clone());
  res.normals.push(st.normal.clone());
}

function stepAir(st: State, c: Coeffs, wind: V3) {
  let acc = new V3(0, -GRAVITY, 0);
  const rel = st.vel.sub(wind);
  const v = rel.length();
  if (v > 0.05) {
    const vhat = rel.mul(1 / v);
    const n = st.normal;
    const vn = clamp(vhat.dot(n), -1, 1);
    const alpha = -Math.asin(vn);
    const q = 0.5 * RHO * v * v;
    const aLift = clamp(alpha, -0.45, 0.45);
    let cl = c.cl0 + c.cla * aLift;
    if (Math.abs(alpha) > 0.45) cl *= Math.max(0.15, 1 - (Math.abs(alpha) - 0.45) / 0.8);
    cl *= 1 - 0.35 * Math.min(st.wobble, 1);
    const cd = c.cd0 + c.cda * alpha * alpha + 0.5 * st.wobble;
    const liftDir = n.sub(vhat.mul(vn));
    const k = (q * AREA) / MASS;
    if (liftDir.lengthSq() > 1e-8) acc = acc.add(liftDir.normalized().mul(k * cl));
    acc = acc.sub(vhat.mul(k * cd));
    // Gyroscopic precession: pitching moment -> roll.
    const aM = clamp(alpha, -0.7, 0.7);
    const cm = c.cm0 + c.cma * aM;
    const moment = q * AREA * DIAMETER * cm;
    const fwd = vhat.sub(n.mul(vn));
    if (fwd.lengthSq() > 1e-8 && Math.abs(st.spin) > 1) {
      const right = fwd.normalized().cross(n);
      st.normal = n.add(right.mul((moment / (INERTIA * st.spin)) * DT)).normalized();
    }
  }
  st.spin *= Math.exp(-c.spin_decay * DT);
  st.wobble *= Math.exp(-0.7 * DT);
  st.vel = st.vel.add(acc.mul(DT));
  st.pos = st.pos.add(st.vel.mul(DT));
}

/** Touchdown: skip, dig in, flip, roll or bounce depending on attitude and surface. */
function land(st: State, world: World, res: Result, t: number, c: Coeffs) {
  const gn = world.normalAt(st.pos.x, st.pos.z);
  const vn = st.vel.dot(gn);
  const vt = st.vel.sub(gn.mul(vn));
  const upsideDown = st.normal.dot(gn) < 0;
  const n = upsideDown ? st.normal.neg() : st.normal;
  const tilt = Math.acos(clamp(n.dot(gn), 0, 1));
  const sp = vt.length();
  const surf = world.surfaceAt(st.pos.x, st.pos.z);
  st.pos.y = world.heightAt(st.pos.x, st.pos.z) + 0.01;
  const bounce = c.bounce ?? 0;
  if (bounce > 0 && -vn > 2) {
    st.vel = vt.mul(0.92).sub(gn.mul(vn * bounce));
    st.pos.y += 0.03;
    res.ev(t, "bounce", st.pos, surf);
    return;
  }
  res.ev(t, "land", st.pos, surf);
  const soft = surf === Surface.MUD || surf === Surface.TALL;
  const downhill = new V3(gn.x, 0, gn.z);
  const slope = Math.acos(clamp(gn.y, 0, 1));
  const rollsDownhill = slope > degToRad(10) && sp > 2 && vt.dot(downhill) > 0;
  let anhyzerSide = false;
  if (sp > 0.1) {
    const side0 = vt.mul(1 / sp).cross(gn);
    anhyzerSide = n.dot(side0) * -Math.sign(st.spin) > 0;
  }
  if (tilt > 1 && (anhyzerSide || tilt > 1.35) && (sp > 6 || rollsDownhill) && -vn < 0.8 * sp && !soft) {
    st.vel = vt.mul(0.75);
    st.phase = Phase.ROLLING;
    res.ev(t, "roll", st.pos);
    st.wobble = 0;
    return;
  }
  let keep = SKIP_KEEP[surf] * (c.skip ?? 1);
  if (sp > 0.1) {
    const dir = vt.mul(1 / sp);
    const side = dir.cross(gn);
    const bank = Math.abs(n.dot(side));
    const nose = n.dot(dir);
    if (bank > 0.8 && sp > 9 && !anhyzerSide && tilt < 1.35 && !soft) {
      st.normal = gn.slerp(n, 0.2).normalized().neg();
      st.vel = vt.mul(0.35);
      st.phase = Phase.SLIDING;
      st.wobble = 0;
      res.ev(t, "flip", st.pos);
      return;
    }
    keep *= 1 - 0.85 * smoothstep(0.15, 0.75, bank);
    keep *= 1 - 0.8 * smoothstep(0.03, 0.35, nose);
  }
  if (upsideDown) keep = Math.min(keep * 1.3, 0.9);
  if (-vn > 0.5 * sp) keep *= 0.45;
  st.vel = vt.mul(clamp(keep, 0.05, 0.95));
  st.phase = Phase.SLIDING;
  if (keep > 0.35) res.ev(t, "skip", st.pos);
  st.wobble = 0;
}

function stepGround(st: State, world: World, res: Result, t: number) {
  const gn = world.normalAt(st.pos.x, st.pos.z);
  const surf = world.surfaceAt(st.pos.x, st.pos.z);
  const g = new V3(0, -GRAVITY, 0);
  const gT = g.sub(gn.mul(g.dot(gn)));
  const rolling = st.phase === Phase.ROLLING;
  let mu = rolling ? ROLL_MU[surf] : SLIDE_MU[surf];
  if (!rolling && st.normal.dot(gn) < 0) mu *= 0.75;
  let sp = st.vel.length();
  const fric = mu * GRAVITY * gn.y;
  if (rolling) {
    const lean = st.normal.sub(gn.mul(st.normal.dot(gn)));
    const tip = st.normal.dot(gn);
    if (lean.lengthSq() > 1e-6 && sp > 0.1) {
      const side = lean.normalized().neg();
      st.vel = st.vel.add(side.mul(GRAVITY * 0.5 * Math.abs(tip) * DT));
      st.vel = st.vel.normalized().mul(sp);
    }
    const fall = (0.35 + 1.5 / Math.max(sp, 0.5)) * DT;
    st.normal = st.normal.slerp(tip >= 0 ? gn : gn.neg(), clamp(fall, 0, 1)).normalized();
    if (Math.abs(st.normal.dot(gn)) > 0.8) {
      st.phase = Phase.SLIDING;
      st.vel = st.vel.mul(0.45);
      res.ev(t, "flop", st.pos);
    }
  } else {
    st.normal = st.normal.slerp(st.normal.dot(gn) >= 0 ? gn : gn.neg(), clamp(6 * DT, 0, 1)).normalized();
  }
  if (sp < 0.25 && gT.length() < fric) {
    st.vel = new V3();
    st.phase = Phase.REST;
    return;
  }
  st.vel = st.vel.add(gT.mul(DT));
  sp = st.vel.length();
  if (sp > 1e-4) st.vel = st.vel.mul(Math.max(0, sp - fric * DT) / sp);
  st.pos = st.pos.add(st.vel.mul(DT));
  st.pos.y = world.heightAt(st.pos.x, st.pos.z) + 0.01;
  st.vel = st.vel.sub(gn.mul(st.vel.dot(gn)));
  st.spin *= Math.exp(-3 * DT);
}

/** Chaos: magnet disc bends toward the chains in the last 25 m. */
function magnet(st: State, basket: V3) {
  const to = basket.add(new V3(0, 1.05, 0)).sub(st.pos);
  const hd = Math.hypot(to.x, to.z);
  if (hd > 25 || hd < 0.2) return;
  const pull = 14 * Math.sqrt(1 - hd / 25);
  st.vel = st.vel.add(to.normalized().mul(pull * DT));
}

const BOMB_TRIGGERS = new Set(["land", "bounce", "tree", "branch", "stump", "bush", "leaves", "lodged", "skip", "roll", "pole", "band", "tray_hit", "lid"]);

/** Chaos: the bomb disc goes off at its first contact with anything. */
function maybeExplode(st: State, world: World, res: Result, t: number, logBefore: number) {
  let hit = st.phase !== Phase.FLYING;
  for (let i = logBefore; i < res.log.length; i++) if (BOMB_TRIGGERS.has(res.log[i].type)) hit = true;
  if (!hit || st.phase === Phase.HOLED || st.phase === Phase.WATER) return;
  res.exploded = true;
  res.ev(t, "explode", st.pos);
  st.vel = new V3();
  st.pos.y = world.heightAt(st.pos.x, st.pos.z) + 0.01;
  st.phase = Phase.REST;
}

function collideTrees(st: State, world: World, rng: Rng, res: Result, t: number, c: Coeffs) {
  for (const tr of world.treesNear(st.pos.x, st.pos.z)) {
    if (tr.dead) continue;
    const hy = st.pos.y - tr.base;
    if (hy < -0.2 || hy > tr.height) continue;
    const dx = st.pos.x - tr.x;
    const dz = st.pos.z - tr.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (st.phase === Phase.FLYING && (c.saw || c.ghost)) {
      const touching = (hy < tr.trunkTop && d < tr.trunkR + RADIUS + 0.25) || inCanopy(tr, hy, d);
      if (touching && c.saw) {
        // Chainsaw disc: cuts through, loses a little pace per tree.
        if (!res.cut.has(tr.id)) {
          res.cut.add(tr.id);
          st.vel = st.vel.mul(0.94);
          res.ev(t, "cut", st.pos, tr.id);
        }
        continue;
      }
      if (touching && (res.ghosted.size === 0 || res.ghosted.has(tr.id))) {
        // Ghost disc: phases through the first tree it meets.
        if (res.ghosted.size === 0) res.ev(t, "ghost", st.pos, tr.id);
        res.ghosted.add(tr.id);
        continue;
      }
    }
    if (st.phase === Phase.FLYING && collideBranches(st, tr, res, t)) continue;
    if (hy < tr.trunkTop && d < tr.trunkR + RADIUS) {
      // Wood is hard: the disc rebounds and keeps most of its speed along the bark.
      const nrm = new V3(dx, 0, dz).mul(1 / Math.max(d, 1e-4));
      const vn = st.vel.dot(nrm);
      if (vn < 0) {
        const vt = st.vel.sub(nrm.mul(vn));
        const rubber = (c.bounce ?? 0) > 0;
        st.vel = vt.mul(rubber ? 0.95 : 0.75).sub(nrm.mul((rubber ? 0.9 : 0.5) * vn));
        st.spin *= 0.6;
        st.wobble += rubber ? 0.1 : 0.4;
        st.pos = new V3(tr.x + nrm.x * (tr.trunkR + RADIUS + 0.01), st.pos.y, tr.z + nrm.z * (tr.trunkR + RADIUS + 0.01));
        res.ev(t, tr.kind === "stump" ? "stump" : "tree", st.pos, tr.id);
      }
    } else if (tr.kind === "bush" && inCanopy(tr, hy, d)) {
      // Bushes swallow discs, flying or rolling.
      st.vel = st.vel.mul(Math.exp(-DENSITY.bush * DT));
      st.spin *= Math.exp(-4 * DT);
      const last = res.log[res.log.length - 1];
      if (!last || last.type !== "bush" || t - last.t > 0.3) res.ev(t, "bush", st.pos, tr.id);
      if (st.vel.length() < 1.2) {
        st.vel = new V3();
        st.pos.y = Math.max(st.pos.y, world.heightAt(st.pos.x, st.pos.z) + 0.25);
        st.phase = Phase.STUCK;
        res.ev(t, "lodged", st.pos, tr.id);
        return;
      }
    } else if (st.phase === Phase.FLYING && hy > tr.canopyLow && inCanopy(tr, hy, d)) {
      const depth = canopyDepth(tr, hy, d);
      st.vel = st.vel.mul(Math.exp(-(DENSITY[tr.kind] ?? 4) * (0.12 + 0.88 * depth * depth) * DT));
      if (Math.hypot(st.vel.x, st.vel.z) < LODGE_SPEED && depth > 0.3 && !res.lodgeRolled) {
        res.lodgeRolled = true;
        if (rng.next() < LODGE_CHANCE) {
          st.vel = new V3();
          st.phase = Phase.STUCK;
          res.ev(t, "lodged", st.pos, tr.id);
          return;
        }
      }
      const axis = new V3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      if (axis.lengthSq() > 1e-4) {
        const a = axis.normalized();
        st.vel = st.vel.rotated(a, rng.normal(0, 6) * DT);
        st.normal = st.normal.rotated(a, rng.normal(0, 4) * DT).normalized();
      }
      st.spin *= Math.exp(-2 * DT);
      st.wobble = Math.min(st.wobble + 1.5 * DT, 1);
      const last = res.log[res.log.length - 1];
      if (!last || last.type !== "leaves" || t - last.t > 0.25) res.ev(t, "leaves", st.pos, tr.id);
    }
  }
}

function collideBranches(st: State, tr: Tree, res: Result, t: number): boolean {
  if (tr.branches.length === 0) return false;
  const base = new V3(tr.x, tr.base, tr.z);
  const local = st.pos.sub(base);
  for (const [a, b, r] of tr.branches) {
    const cp = closestOnSegment3(local, a, b);
    const off = local.sub(cp);
    const d = off.length();
    if (d < r + RADIUS * 0.6 && d > 1e-5) {
      const nrm = off.mul(1 / d);
      const vn = st.vel.dot(nrm);
      if (vn < 0) {
        const vt = st.vel.sub(nrm.mul(vn));
        st.vel = vt.mul(0.6).sub(nrm.mul(0.4 * vn));
        st.spin *= 0.6;
        st.wobble += 0.5;
        st.pos = base.add(cp).add(nrm.mul(r + RADIUS * 0.6 + 0.005));
        res.ev(t, "branch", st.pos, tr.id);
        return true;
      }
    }
  }
  return false;
}

function canopyDepth(tr: Tree, hy: number, d: number): number {
  if (tr.kind === "pine") {
    const span = tr.height - tr.canopyLow;
    const r = (tr.canopyR * (tr.height - hy)) / Math.max(span, 0.1);
    return clamp(1 - d / Math.max(r, 0.01), 0, 1);
  }
  const cy = tr.height - tr.canopyR;
  const dy = (hy - cy) * 1.15;
  return clamp(1 - Math.sqrt(d * d + dy * dy) / Math.max(tr.canopyR, 0.01), 0, 1);
}

export function inCanopy(tr: Tree, hy: number, d: number): boolean {
  if (tr.kind === "stump") return false;
  if (tr.kind === "bush") {
    const by = ((hy - tr.height * 0.5) / Math.max(tr.height * 0.5, 0.1)) * tr.canopyR;
    return d * d + by * by < tr.canopyR * tr.canopyR;
  }
  if (tr.kind === "pine") {
    const span = tr.height - tr.canopyLow;
    return d < (tr.canopyR * (tr.height - hy)) / Math.max(span, 0.1);
  }
  const cy = tr.height - tr.canopyR;
  const dy = (hy - cy) * 1.15;
  return d * d + dy * dy < tr.canopyR * tr.canopyR;
}

/** Returns the updated catch lock (seconds during which chains can't catch again). */
function collideBasket(st: State, prev: V3, b: V3, res: Result, lock: number, t: number): number {
  const dx = st.pos.x - b.x;
  const dz = st.pos.z - b.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const hy = st.pos.y - b.y;
  if (dist > 0.7 || hy > 1.8 || hy < -0.1) return lock;
  const pdist = Math.hypot(prev.x - b.x, prev.z - b.z);
  const phy = prev.y - b.y;
  const radial = new V3(dx, 0, dz).mul(1 / Math.max(dist, 1e-4));
  const hspeed = Math.hypot(st.vel.x, st.vel.z);

  // Coming down onto the lid: a soft one stays up there (not holed), livelier ones bounce off.
  const lidTop = BAND_HIGH + 0.02;
  if (dist < CHAIN_R + 0.05 && hy <= lidTop && phy > lidTop && st.vel.y < 0) {
    if (st.vel.length() < 4) {
      st.pos = new V3(st.pos.x, b.y + lidTop - 0.005, st.pos.z);
      st.vel = new V3();
      st.normal = V3.UP.clone();
      st.phase = Phase.REST;
      res.ev(t, "on_top", st.pos);
    } else {
      const out = radial.mul(1.2 + 0.25 * Math.abs(st.vel.y));
      st.vel = new V3(st.vel.x * 0.6 + out.x, Math.abs(st.vel.y) * 0.25, st.vel.z * 0.6 + out.z);
      st.pos.y = b.y + lidTop + 0.01;
      st.wobble += 0.3;
      res.ev(t, "lid", st.pos);
    }
    return lock;
  }
  if (dist < TRAY_R && hy <= TRAY_TOP && phy > TRAY_TOP && st.vel.y < 0) {
    holeOut(st, b, res, "tray", t);
    return lock;
  }
  if (dist < TRAY_R + RADIUS * 0.7 && hy <= TRAY_TOP && phy > TRAY_TOP && st.vel.y < 0) {
    const inward = -(st.vel.x * radial.x + st.vel.z * radial.z);
    if (inward > 0.3 || dist < TRAY_R + RADIUS * 0.25) holeOut(st, b, res, "rim_in", t);
    else {
      bounceOff(st, radial, 0.4);
      st.vel.y = Math.abs(st.vel.y) * 0.3;
      res.ev(t, "rim_out", st.pos);
    }
    return lock;
  }
  if (hy >= CHAIN_LOW && hy <= CHAIN_HIGH && dist < CHAIN_R) {
    if (lock <= 0) {
      const hl = Math.hypot(st.vel.x, st.vel.z) || 1;
      const miss = hspeed > 0.1 ? Math.abs((st.vel.x / hl) * dz - (st.vel.z / hl) * dx) : dist;
      const catchSpeed = 11.5 * (1 - 0.6 * clamp(miss / CHAIN_R, 0, 1) ** 2);
      if (hspeed < catchSpeed) {
        if (hy > 1.12 && miss > 0.14 && hspeed < 6) {
          holeOut(st, b, res, "chains", t, true);
          res.ev(t, "hanging", st.pos);
        } else holeOut(st, b, res, "chains", t);
        return lock;
      }
      res.ev(t, "spit", st.pos, Math.floor(hspeed * 10));
      st.vel = new V3(st.vel.x * 0.25, st.vel.y * 0.3, st.vel.z * 0.25);
      st.spin *= 0.4;
      st.wobble += 0.5;
      return 0.5;
    }
    return lock;
  }
  if (hy >= BAND_LOW && hy <= BAND_HIGH + RADIUS && dist < CHAIN_R + 0.04 && pdist >= CHAIN_R + 0.04) {
    bounceOff(st, radial, 0.3);
    res.ev(t, "band", st.pos);
    return lock;
  }
  if (hy < TRAY_TOP && hy > TRAY_LOW - 0.08 && dist < TRAY_R + RADIUS * 0.5 && pdist >= TRAY_R + RADIUS * 0.5) {
    bounceOff(st, radial, 0.3);
    res.ev(t, "tray_hit", st.pos);
    return lock;
  }
  if (hy < TRAY_LOW && dist < POLE_R + RADIUS) {
    bounceOff(st, radial, 0.25);
    res.ev(t, "pole", st.pos);
  }
  return lock;
}

function bounceOff(st: State, nrm: V3, keep: number) {
  const vn = st.vel.dot(nrm);
  if (vn < 0) st.vel = st.vel.sub(nrm.mul(1.4 * vn));
  st.vel = st.vel.mul(keep);
  st.spin *= 0.5;
  st.wobble += 0.3;
}

function holeOut(st: State, b: V3, res: Result, how: string, t: number, hang = false) {
  const hit = st.pos.clone();
  if (hang) {
    st.pos = new V3(b.x + (hit.x - b.x) * 0.8, hit.y - 0.05, b.z + (hit.z - b.z) * 0.8);
    st.normal = new V3(hit.x - b.x, 1.2, hit.z - b.z).normalized();
  } else {
    st.pos = new V3(b.x + (st.pos.x - b.x) * 0.5, b.y + TRAY_LOW + 0.06, b.z + (st.pos.z - b.z) * 0.5);
    st.normal = V3.UP.clone();
  }
  st.vel = new V3();
  st.phase = Phase.HOLED;
  res.ev(t, how, hit);
}
