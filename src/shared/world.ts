// Everything the flight sim needs to know about a course: heightfield,
// surfaces, trees (with a spatial hash), holes, ponds, OB and wind.
// Port of the Godot CourseWorld + CourseLoader. Built from the same JSON on
// the server and every client, so all of them see the same course.

import { createNoise2D } from "simplex-noise";
import { Rng, hash2 } from "./rng";
import {
  V3, V2, Rect, clamp, lerp, smoothstep, dist2, distToPolyline, distToRing, pointInPolygon, rectOf, inRect,
} from "./vec";

export enum Surface { ROUGH, FAIRWAY, PAD, MUD, TALL }

export type TreeKind = "pine" | "leaf" | "bush" | "stump";

export interface Tree {
  id: number;
  x: number;
  z: number;
  base: number;
  height: number;
  kind: TreeKind;
  trunkR: number;
  trunkTop: number;
  canopyLow: number;
  canopyR: number;
  /** Solid limbs in tree-local space (origin at the trunk base): [a, b, radius]. */
  branches: [V3, V3, number][];
  dead: boolean;
}

export interface Hole {
  par: number;
  path: V2[];
  fairwayWidth: number;
  length: number;
  tee: V3;
  basket: V3;
  dropZone?: V3;
}

export interface Pond {
  poly: V2[];
  level: number;
  aabb: Rect;
}

export interface CourseJson {
  name?: string;
  size?: [number, number];
  cell?: number;
  terrain?: { seed?: number; amplitude?: number; frequency?: number; heights?: number[] };
  wind?: { speed?: number; dir_deg?: number };
  holes: { par?: number; tee: [number, number]; basket: [number, number]; waypoints?: [number, number][]; fairway_width?: number; drop_zone?: [number, number] }[];
  ob?: { polygon: [number, number][] }[];
  ponds?: { polygon: [number, number][] }[];
  trees?: { x: number; z: number; h?: number; type?: string }[];
  forests?: { center: [number, number]; radius: number; count: number; seed?: number; pine_ratio?: number }[];
}

const TREE_CELL = 8;
export const PAD_TOP = 0.12;

const v2 = (a: [number, number]): V2 => ({ x: a[0], y: a[1] });

export class World {
  name = "";
  origin: V2 = { x: 0, y: 0 };
  cell = 2;
  cols = 0;
  rows = 0;
  heights = new Float32Array(0);
  surface = new Uint8Array(0);
  holes: Hole[] = [];
  trees: Tree[] = [];
  ponds: Pond[] = [];
  ob: { poly: V2[]; aabb: Rect }[] = [];
  /** Mean wind at 10 m height. */
  wind = new V3();
  baseWind = new V3();
  gustStrength = 0.35;
  private grid = new Map<number, Tree[]>();

  // ------------------------------------------------------------ queries

  inBounds(x: number, z: number): boolean {
    const mx = this.origin.x + (this.cols - 1) * this.cell;
    const mz = this.origin.y + (this.rows - 1) * this.cell;
    return x >= this.origin.x && x <= mx && z >= this.origin.y && z <= mz;
  }

  /** Matches the rendered triangles (split along the (0,0)-(1,1) diagonal). */
  heightAt(x: number, z: number): number {
    const gx = clamp((x - this.origin.x) / this.cell, 0, this.cols - 1.0001);
    const gz = clamp((z - this.origin.y) / this.cell, 0, this.rows - 1.0001);
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const c = this.cols;
    const h = this.heights;
    const h00 = h[iz * c + ix];
    const h10 = h[iz * c + ix + 1];
    const h01 = h[(iz + 1) * c + ix];
    const h11 = h[(iz + 1) * c + ix + 1];
    if (fx >= fz) return h00 + fx * (h10 - h00) + fz * (h11 - h10);
    return h00 + fz * (h01 - h00) + fx * (h11 - h01);
  }

  normalAt(x: number, z: number): V3 {
    const e = this.cell * 0.5;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return new V3(-dx, 2 * e, -dz).normalized();
  }

  surfaceAt(x: number, z: number): Surface {
    const ix = clamp(Math.round((x - this.origin.x) / this.cell), 0, this.cols - 1);
    const iz = clamp(Math.round((z - this.origin.y) / this.cell), 0, this.rows - 1);
    return this.surface[iz * this.cols + ix] as Surface;
  }

  /** Where feet stand: the terrain, or the top of a tee pad. */
  standHeightAt(x: number, z: number): number {
    const h = this.heightAt(x, z);
    for (const hole of this.holes) {
      const t = hole.tee;
      if (Math.abs(x - t.x) > 2.2 || Math.abs(z - t.z) > 2.2) continue;
      const d = { x: hole.path[1].x - hole.path[0].x, y: hole.path[1].y - hole.path[0].y };
      const l = Math.hypot(d.x, d.y) || 1;
      const qx = x - t.x;
      const qz = z - t.z;
      const along = (qx * d.x + qz * d.y) / l;
      const across = (qx * d.y - qz * d.x) / l;
      if (Math.abs(across) <= 0.9 && Math.abs(along) <= 1.8) return Math.max(h, t.y + PAD_TOP);
    }
    return h;
  }

  /** Wind felt at p: log-law profile with height; gustSeed 0 = steady mean. */
  windAt(p: V3, t: number, gustSeed: number): V3 {
    if (this.wind.lengthSq() === 0) return this.wind;
    const h = Math.max(p.y - this.heightAt(p.x, p.z), 0);
    const prof = clamp(Math.log((h + 0.05) / 0.05) / Math.log(10 / 0.05), 0.25, 1.25);
    let w = this.wind.mul(prof);
    if (gustSeed !== 0) w = w.rotated(V3.UP, this.gustTurn(t, gustSeed)).mul(this.gustFactor(t, gustSeed));
    return w;
  }

  gustFactor(t: number, seed: number): number {
    const s = seed % 977;
    return 1 + this.gustStrength * (0.6 * Math.sin(0.8 * t + s) + 0.3 * Math.sin(2.1 * t + s * 1.7) + 0.1 * Math.sin(5.3 * t + s * 0.3));
  }

  gustTurn(t: number, seed: number): number {
    return this.gustStrength * 0.35 * Math.sin(0.5 * t + (seed % 977) * 2.3);
  }

  treesNear(x: number, z: number): Tree[] {
    return this.grid.get(cellKey(Math.floor(x / TREE_CELL), Math.floor(z / TREE_CELL))) ?? [];
  }

  waterAt(p: V3): Pond | null {
    for (const pond of this.ponds) {
      if (p.y > pond.level + 0.03) continue;
      const q = { x: p.x, y: p.z };
      if (inRect(pond.aabb, q) && pointInPolygon(q, pond.poly)) return pond;
    }
    return null;
  }

  inPondXZ(x: number, z: number): boolean {
    const q = { x, y: z };
    return this.ponds.some((p) => inRect(p.aabb, q) && pointInPolygon(q, p.poly));
  }

  isOb(x: number, z: number): boolean {
    if (!this.inBounds(x, z)) return true;
    const q = { x, y: z };
    return this.ob.some((a) => inRect(a.aabb, q) && pointInPolygon(q, a.poly));
  }

  playable(x: number, z: number): boolean {
    return !this.isOb(x, z) && !this.inPondXZ(x, z);
  }

  // ------------------------------------------------------------ building

  addTree(t: Omit<Tree, "id" | "dead">): Tree {
    const tree: Tree = { ...t, id: this.trees.length, dead: false };
    this.trees.push(tree);
    const r = Math.max(tree.canopyR, tree.trunkR) + 0.2;
    const cx0 = Math.floor((tree.x - r) / TREE_CELL);
    const cx1 = Math.floor((tree.x + r) / TREE_CELL);
    const cz0 = Math.floor((tree.z - r) / TREE_CELL);
    const cz1 = Math.floor((tree.z + r) / TREE_CELL);
    for (let cx = cx0; cx <= cx1; cx++)
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = cellKey(cx, cz);
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(tree);
      }
    return tree;
  }

  /** Chaos: the tree is felled / blown over (no longer collides). */
  fellTree(id: number): void {
    if (id >= 0 && id < this.trees.length) this.trees[id].dead = true;
  }

  /** Chaos: blast a bowl-shaped crater (tee pads and baskets protected).
   *  Returns the changed grid rect [ix0, iz0, ix1, iz1] or null. */
  dig(center: V3, radius: number, depth: number): [number, number, number, number] | null {
    const ix0 = clamp(Math.floor((center.x - radius - this.origin.x) / this.cell), 0, this.cols - 1);
    const ix1 = clamp(Math.ceil((center.x + radius - this.origin.x) / this.cell), 0, this.cols - 1);
    const iz0 = clamp(Math.floor((center.z - radius - this.origin.y) / this.cell), 0, this.rows - 1);
    const iz1 = clamp(Math.ceil((center.z + radius - this.origin.y) / this.cell), 0, this.rows - 1);
    let changed = false;
    for (let iz = iz0; iz <= iz1; iz++)
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = this.origin.x + ix * this.cell;
        const z = this.origin.y + iz * this.cell;
        const d = Math.hypot(x - center.x, z - center.z);
        if (d >= radius) continue;
        let keep = 1;
        for (const h of this.holes)
          for (const p of [h.tee, h.basket]) keep = Math.min(keep, smoothstep(2.5, 5, Math.hypot(x - p.x, z - p.z)));
        const u = d / radius;
        const dz = -depth * (1 - u * u) * (1 - u * u) + depth * 0.18 * Math.exp(-(((u - 0.9) / 0.12) ** 2));
        if (Math.abs(dz * keep) < 0.005) continue;
        this.heights[iz * this.cols + ix] += dz * keep;
        if (u < 0.8 && keep > 0.5) this.surface[iz * this.cols + ix] = Surface.MUD;
        changed = true;
      }
    return changed ? [ix0, iz0, ix1, iz1] : null;
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096);
}

// ------------------------------------------------------------ loader

export function buildWorld(data: CourseJson): World {
  const w = new World();
  w.name = data.name ?? "Unnamed course";
  const size = data.size ?? [320, 320];
  w.cell = data.cell ?? 2;
  w.origin = { x: -size[0] * 0.5, y: -size[1] * 0.5 };
  w.cols = Math.floor(size[0] / w.cell) + 1;
  w.rows = Math.floor(size[1] / w.cell) + 1;

  for (const hd of data.holes) {
    const path: V2[] = [v2(hd.tee), ...(hd.waypoints ?? []).map(v2), v2(hd.basket)];
    let length = 0;
    for (let i = 0; i < path.length - 1; i++) length += dist2(path[i], path[i + 1]);
    w.holes.push({ par: hd.par ?? 3, path, fairwayWidth: hd.fairway_width ?? 14, length, tee: new V3(), basket: new V3(), ...(hd.drop_zone ? { dropZone: new V3(hd.drop_zone[0], 0, hd.drop_zone[1]) } : {}) });
  }
  for (const od of data.ob ?? []) {
    const poly = od.polygon.map(v2);
    w.ob.push({ poly, aabb: rectOf(poly) });
  }
  for (const pd of data.ponds ?? []) {
    const poly = pd.polygon.map(v2);
    w.ponds.push({ poly, level: 0, aabb: rectOf(poly) });
  }
  buildTerrain(w, data.terrain ?? {});
  buildSurfaces(w);
  for (const h of w.holes) {
    const a = h.path[0];
    const b = h.path[h.path.length - 1];
    h.tee = new V3(a.x, w.heightAt(a.x, a.y), a.y);
    h.basket = new V3(b.x, w.heightAt(b.x, b.y), b.y);
    if (h.dropZone) h.dropZone.y = w.heightAt(h.dropZone.x, h.dropZone.z);
  }
  for (const td of data.trees ?? []) w.addTree(makeTree(w, td.x, td.z, td.h ?? 12, (td.type ?? "leaf") as TreeKind, null));
  for (const fd of data.forests ?? []) growForest(w, fd);
  const ang = ((data.wind?.dir_deg ?? 0) * Math.PI) / 180;
  w.baseWind = new V3(Math.sin(ang), 0, -Math.cos(ang)).mul(data.wind?.speed ?? 0);
  w.wind = w.baseWind.clone();
  return w;
}

/** Wind for a hole: same rule as the Godot game (seeded per hole). */
export function holeWind(w: World, holeIdx: number): V3 {
  const rng = new Rng(1000 + holeIdx);
  return w.baseWind.rotated(V3.UP, rng.range(-Math.PI, Math.PI)).mul(rng.range(0.3, 1.6));
}

function buildTerrain(w: World, td: NonNullable<CourseJson["terrain"]>): void {
  w.heights = new Float32Array(w.cols * w.rows);
  if (td.heights) {
    const n = Math.min(td.heights.length, w.heights.length);
    for (let i = 0; i < n; i++) w.heights[i] = td.heights[i];
    return;
  }
  const rng = new Rng(td.seed ?? 1);
  const noise = createNoise2D(() => rng.next());
  const f = td.frequency ?? 0.008;
  const amp = td.amplitude ?? 6;
  const raw = (x: number, z: number) =>
    ((noise(x * f, z * f) + 0.5 * noise(x * f * 2, z * f * 2) + 0.25 * noise(x * f * 4, z * f * 4)) / 1.75) * amp;

  // Tees and baskets sit on flattened ground.
  const pads: { p: V2; h: number; r: number }[] = [];
  for (const hole of w.holes)
    for (const p of [hole.path[0], hole.path[hole.path.length - 1]]) pads.push({ p, h: raw(p.x, p.y), r: 7 });
  for (const pond of w.ponds) {
    let s = 0;
    for (const p of pond.poly) s += raw(p.x, p.y);
    pond.level = s / pond.poly.length - 0.25;
  }
  for (let iz = 0; iz < w.rows; iz++)
    for (let ix = 0; ix < w.cols; ix++) {
      const q = { x: w.origin.x + ix * w.cell, y: w.origin.y + iz * w.cell };
      let h = raw(q.x, q.y);
      for (const pad of pads) {
        const d = dist2(q, pad.p);
        if (d < pad.r) h = lerp(h, pad.h, smoothstep(pad.r, pad.r * 0.35, d));
      }
      for (const pond of w.ponds)
        if (inRect(pond.aabb, q, 1) && pointInPolygon(q, pond.poly)) {
          const edge = distToRing(q, pond.poly);
          h = Math.min(h, pond.level - 0.3 - Math.min(1.8, edge * 0.35));
        }
      w.heights[iz * w.cols + ix] = h;
    }
}

function buildSurfaces(w: World): void {
  w.surface = new Uint8Array(w.cols * w.rows);
  const rng = new Rng(77);
  const meadow = createNoise2D(() => rng.next());
  for (let iz = 0; iz < w.rows; iz++)
    for (let ix = 0; ix < w.cols; ix++) {
      const q = { x: w.origin.x + ix * w.cell, y: w.origin.y + iz * w.cell };
      let s = Surface.ROUGH;
      for (const hole of w.holes) {
        if (dist2(q, hole.path[0]) < 2.2) {
          s = Surface.PAD;
          break;
        }
        if (dist2(q, hole.path[hole.path.length - 1]) < 10 || distToPolyline(q, hole.path) < hole.fairwayWidth * 0.5) s = Surface.FAIRWAY;
      }
      if (s === Surface.ROUGH && meadow(q.x * 0.03, q.y * 0.03) > 0.05) {
        let fd = Infinity;
        for (const hole of w.holes) fd = Math.min(fd, distToPolyline(q, hole.path) - hole.fairwayWidth * 0.5);
        if (fd > 7) s = Surface.TALL;
      }
      for (const pond of w.ponds) if (inRect(pond.aabb, q, 4) && distToRing(q, pond.poly) < 3) s = Surface.MUD;
      w.surface[iz * w.cols + ix] = s;
    }
}

export function makeTree(w: World, x: number, z: number, h: number, kind: TreeKind, rng: Rng | null): Omit<Tree, "id" | "dead"> {
  const jitter = rng ? rng.range(0.85, 1.15) : 1;
  const base = w.heightAt(x, z);
  const t: Omit<Tree, "id" | "dead"> = { x, z, base, height: h, kind, trunkR: 0, trunkTop: 0, canopyLow: 0, canopyR: 0, branches: [] };
  if (kind === "stump") {
    t.trunkR = 0.22 + 0.1 * jitter;
    t.canopyLow = h;
    t.trunkTop = h;
    return t;
  }
  if (kind === "bush") {
    t.canopyR = h * 0.9 * jitter;
    return t;
  }
  if (kind === "pine") {
    t.trunkR = 0.16 * jitter + h * 0.008;
    t.canopyLow = h * 0.3;
    t.canopyR = h * 0.2 * jitter;
  } else {
    t.trunkR = 0.2 * jitter + h * 0.01;
    t.canopyR = h * 0.3 * jitter;
    t.canopyLow = h - t.canopyR * 2;
  }
  t.trunkTop = h * 0.8;
  t.branches = growBranches(t);
  return t;
}

/** A few solid limbs inside the crown, seeded from the tree's position. */
function growBranches(t: Omit<Tree, "id" | "dead">): [V3, V3, number][] {
  const rng = new Rng(hash2(Math.round(t.x * 10), Math.round(t.z * 10)));
  const out: [V3, V3, number][] = [];
  const pine = t.kind === "pine";
  const h = t.height;
  const count = pine ? rng.int(3, 5) : rng.int(2, 4);
  const lo = t.canopyLow + 0.4;
  const hi = Math.min(t.trunkTop, h * 0.85);
  if (hi <= lo) return out;
  for (let i = 0; i < count; i++) {
    const y = rng.range(lo, hi);
    const yaw = rng.next() * Math.PI * 2;
    const up = (rng.range(12, 38) * Math.PI) / 180;
    const dir = new V3(Math.cos(yaw) * Math.cos(up), Math.sin(up), Math.sin(yaw) * Math.cos(up));
    const reach = pine ? ((t.canopyR * (h - y)) / Math.max(h - t.canopyLow, 0.1)) * rng.range(0.6, 0.9) : t.canopyR * rng.range(0.45, 0.8);
    const r = pine ? rng.range(0.035, 0.06) : rng.range(0.05, 0.1);
    const a = new V3(0, y, 0).add(new V3(dir.x, 0, dir.z).normalized().mul(t.trunkR * 0.8));
    out.push([a, a.add(dir.mul(reach)), r]);
  }
  return out;
}

function growForest(w: World, fd: NonNullable<CourseJson["forests"]>[number]): void {
  const rng = new Rng(fd.seed ?? 1);
  const c = v2(fd.center);
  const pineRatio = fd.pine_ratio ?? 0.5;
  let placed = 0;
  let attempts = 0;
  while (placed < fd.count && attempts < fd.count * 20) {
    attempts++;
    const a = rng.next() * Math.PI * 2;
    const r = Math.sqrt(rng.next()) * fd.radius;
    const p = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
    if (!w.inBounds(p.x, p.y) || w.inPondXZ(p.x, p.y) || !clearOfPlay(w, p)) continue;
    const kind: TreeKind = rng.next() < pineRatio ? "pine" : "leaf";
    const h = kind === "pine" ? rng.range(10, 20) : rng.range(8, 15);
    w.addTree(makeTree(w, p.x, p.y, h, kind, rng));
    placed++;
  }
  // Undergrowth: bushes crowd the forest edge, old stumps scattered through it.
  let extra = 0;
  attempts = 0;
  while (extra < Math.floor(fd.count * 0.45) && attempts < fd.count * 20) {
    attempts++;
    const a = rng.next() * Math.PI * 2;
    const rr = fd.radius * rng.range(0.55, 1.15);
    const p = { x: c.x + Math.cos(a) * rr, y: c.y + Math.sin(a) * rr };
    if (!w.inBounds(p.x, p.y) || w.inPondXZ(p.x, p.y) || !clearOfPlay(w, p, -0.5)) continue;
    if (rng.next() < 0.18) w.addTree(makeTree(w, p.x, p.y, rng.range(0.3, 0.7), "stump", rng));
    else w.addTree(makeTree(w, p.x, p.y, rng.range(0.7, 1.5), "bush", rng));
    extra++;
  }
}

function clearOfPlay(w: World, p: V2, margin = 2.5): boolean {
  for (const hole of w.holes) {
    if (dist2(p, hole.path[0]) < 9 || dist2(p, hole.path[hole.path.length - 1]) < 7) return false;
    if (distToPolyline(p, hole.path) < hole.fairwayWidth * 0.5 + margin) return false;
  }
  return true;
}

/** Flat test world. */
export function flatWorld(halfSize = 300, h = 0): World {
  const w = new World();
  w.name = "flat";
  w.cell = 10;
  w.origin = { x: -halfSize, y: -halfSize };
  w.cols = Math.floor((halfSize * 2) / w.cell) + 1;
  w.rows = w.cols;
  w.heights = new Float32Array(w.cols * w.rows).fill(h);
  w.surface = new Uint8Array(w.cols * w.rows).fill(Surface.FAIRWAY);
  return w;
}
