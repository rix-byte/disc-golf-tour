// Small 3D vector maths for the shared simulation (server + client).
// Mirrors the Godot Vector3 calls the physics was written with.

export class V3 {
  constructor(public x = 0, public y = 0, public z = 0) {}

  static readonly ZERO = Object.freeze(new V3(0, 0, 0)) as V3;
  static readonly UP = Object.freeze(new V3(0, 1, 0)) as V3;

  static of(a: ArrayLike<number>): V3 {
    return new V3(a[0], a[1], a[2]);
  }
  arr(): [number, number, number] {
    return [this.x, this.y, this.z];
  }
  clone(): V3 {
    return new V3(this.x, this.y, this.z);
  }
  add(b: V3): V3 {
    return new V3(this.x + b.x, this.y + b.y, this.z + b.z);
  }
  sub(b: V3): V3 {
    return new V3(this.x - b.x, this.y - b.y, this.z - b.z);
  }
  mul(k: number): V3 {
    return new V3(this.x * k, this.y * k, this.z * k);
  }
  neg(): V3 {
    return new V3(-this.x, -this.y, -this.z);
  }
  dot(b: V3): number {
    return this.x * b.x + this.y * b.y + this.z * b.z;
  }
  cross(b: V3): V3 {
    return new V3(this.y * b.z - this.z * b.y, this.z * b.x - this.x * b.z, this.x * b.y - this.y * b.x);
  }
  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  length(): number {
    return Math.sqrt(this.lengthSq());
  }
  normalized(): V3 {
    const l = this.length();
    return l > 0 ? this.mul(1 / l) : new V3();
  }
  distanceTo(b: V3): number {
    return this.sub(b).length();
  }
  /** Rotation about a unit axis by angle (right-hand rule), like Godot's Vector3.rotated. */
  rotated(axis: V3, angle: number): V3 {
    const k = axis.normalized();
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return this.mul(c).add(k.cross(this).mul(s)).add(k.mul(k.dot(this) * (1 - c)));
  }
  /** Spherical interpolation between directions (lengths interpolated linearly). */
  slerp(to: V3, w: number): V3 {
    const la = this.length();
    const lb = to.length();
    if (la < 1e-9 || lb < 1e-9) return this.mul(1 - w).add(to.mul(w));
    const a = this.mul(1 / la);
    const b = to.mul(1 / lb);
    const d = clamp(a.dot(b), -1, 1);
    const ang = Math.acos(d);
    let dir: V3;
    if (ang < 1e-5) dir = a.mul(1 - w).add(b.mul(w)).normalized();
    else {
      const axis = a.cross(b);
      dir = axis.lengthSq() < 1e-12 ? a.mul(1 - w).add(b.mul(w)).normalized() : a.rotated(axis, ang * w);
    }
    return dir.mul(la + (lb - la) * w);
  }
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const degToRad = (d: number) => (d * Math.PI) / 180;
export const radToDeg = (r: number) => (r * 180) / Math.PI;

/** Godot's smoothstep (edges may be reversed). */
export function smoothstep(from: number, to: number, s: number): number {
  if (Math.abs(from - to) < 1e-9) return s < from ? 0 : 1;
  const t = clamp((s - from) / (to - from), 0, 1);
  return t * t * (3 - 2 * t);
}

export type V2 = { x: number; y: number };

export function dist2(a: V2, b: V2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function closestOnSegment2(p: V2, a: V2, b: V2): V2 {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-12) return { x: a.x, y: a.y };
  const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby) / l2, 0, 1);
  return { x: a.x + abx * t, y: a.y + aby * t };
}

export function closestOnSegment3(p: V3, a: V3, b: V3): V3 {
  const ab = b.sub(a);
  const l2 = ab.lengthSq();
  if (l2 < 1e-12) return a.clone();
  const t = clamp(p.sub(a).dot(ab) / l2, 0, 1);
  return a.add(ab.mul(t));
}

export function pointInPolygon(p: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function distToPolyline(p: V2, line: V2[]): number {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) best = Math.min(best, dist2(p, closestOnSegment2(p, line[i], line[i + 1])));
  return best;
}

export function distToRing(p: V2, poly: V2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, dist2(p, closestOnSegment2(p, poly[i], poly[(i + 1) % poly.length])));
  return best;
}

export type Rect = { x0: number; y0: number; x1: number; y1: number };

export function rectOf(poly: V2[], grow = 0): Rect {
  const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of poly) {
    r.x0 = Math.min(r.x0, p.x);
    r.y0 = Math.min(r.y0, p.y);
    r.x1 = Math.max(r.x1, p.x);
    r.y1 = Math.max(r.y1, p.y);
  }
  r.x0 -= grow;
  r.y0 -= grow;
  r.x1 += grow;
  r.y1 += grow;
  return r;
}

export function inRect(r: Rect, p: V2, grow = 0): boolean {
  return p.x >= r.x0 - grow && p.x <= r.x1 + grow && p.y >= r.y0 - grow && p.y <= r.y1 + grow;
}
