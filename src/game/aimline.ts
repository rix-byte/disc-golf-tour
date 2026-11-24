// The aim preview, readable at any screen size:
//   ribbon        a thick tube along the predicted flight (first part only,
//                 fading; T shows all of it), red from the first tree contact
//   ground trace  the same path projected on the terrain — shows turn and fade
//   landing       an ellipse where a clean throw stops, as wide as a typical
//                 release error spreads it (red if that spot is OB / water)

import * as THREE from "three";
import { FRAME_DT, Phase, Result } from "../shared/physics";
import { World } from "../shared/world";

const CONTACT = new Set(["tree", "branch", "leaves", "stump", "bush", "lodged"]);
const WHITE = new THREE.Color(1, 1, 1);
const RED = new THREE.Color(1, 0.32, 0.25);

export class AimLine {
  group = new THREE.Group();
  private ribbon: THREE.Mesh;
  private trace: THREE.Mesh;
  private ellipse: THREE.Mesh;

  constructor() {
    const mat = () => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.ribbon = new THREE.Mesh(new THREE.BufferGeometry(), mat());
    this.trace = new THREE.Mesh(new THREE.BufferGeometry(), mat());
    // Drawn through trees (as in Godot), so the red "hits a tree" part stays visible behind trunks.
    (this.ribbon.material as THREE.MeshBasicMaterial).depthTest = false;
    this.ribbon.renderOrder = 3;
    this.trace.renderOrder = 2;
    this.ellipse = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1, 56).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false }),
    );
    this.ellipse.renderOrder = 2;
    for (const m of [this.ribbon, this.trace, this.ellipse]) m.frustumCulled = false;
    this.group.add(this.trace, this.ribbon, this.ellipse);
  }

  hide() {
    this.group.visible = false;
  }

  /**
   * `fraction` of the flight shown as ribbon (1 = all), `spreadDeg` = sideways
   * miss for a typical release error, used for the ellipse width.
   */
  rebuilds = 0;
  update(world: World, r: Result, fraction: number, spreadDeg: number) {
    this.rebuilds++;
    const pts = r.positions.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    if (pts.length < 3) {
      this.hide();
      return;
    }
    this.group.visible = true;
    const hit = r.log.find((e) => CONTACT.has(e.type));
    const hitIdx = hit ? Math.round(hit.t / FRAME_DT) : Infinity;

    // Ribbon: the flight part only (until it first touches the ground).
    const airEnd = Math.max(2, Math.min(pts.length - 1, Math.round(r.airTime / FRAME_DT)));
    const n = Math.max(2, Math.round(airEnd * fraction));
    const air = pts.slice(0, n + 1);
    const curve = new THREE.CatmullRomCurve3(air);
    const segs = Math.min(240, air.length * 2);
    const tube = new THREE.TubeGeometry(curve, segs, 0.045, 5, false);
    const ringVerts = 6;
    const col = new Float32Array((segs + 1) * ringVerts * 4);
    for (let i = 0; i <= segs; i++) {
      const u = i / segs;
      const idx = u * n;
      const c = idx >= hitIdx ? RED : WHITE;
      const a = fraction >= 1 ? 0.85 : 0.9 * (1 - u * 0.85);
      for (let k = 0; k < ringVerts; k++) col.set([c.r, c.g, c.b, a], (i * ringVerts + k) * 4);
    }
    tube.setAttribute("color", new THREE.BufferAttribute(col, 4));
    this.ribbon.geometry.dispose();
    this.ribbon.geometry = tube;

    // Ground trace: the whole flight projected onto the terrain, faint, as a flat strip.
    const traceEnd = Math.min(pts.length, airEnd + 1);
    const pos: number[] = [];
    const tc: number[] = [];
    const idxs: number[] = [];
    for (let i = 0; i < traceEnd; i++) {
      const p = pts[i];
      const q = pts[Math.min(traceEnd - 1, i + 1)];
      const pr = pts[Math.max(0, i - 1)];
      const dx = q.x - pr.x;
      const dz = q.z - pr.z;
      const l = Math.hypot(dx, dz) || 1;
      const sx = (-dz / l) * 0.12;
      const sz = (dx / l) * 0.12;
      for (const s of [-1, 1]) {
        const x = p.x + sx * s;
        const z = p.z + sz * s;
        pos.push(x, world.heightAt(x, z) + 0.07, z);
        const c = i >= hitIdx ? RED : WHITE;
        tc.push(c.r, c.g, c.b, 0.38 * (1 - (0.6 * i) / traceEnd));
      }
      if (i > 0) {
        const b = (i - 1) * 2;
        idxs.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(tc, 4));
    g.setIndex(idxs);
    this.trace.geometry.dispose();
    this.trace.geometry = g;

    // Landing ellipse at the rest spot: width from the release spread, length ~8 % of the distance.
    const end = r.finalPos;
    const dist = r.distance();
    const dir = new THREE.Vector3(end.x - r.startPos.x, 0, end.z - r.startPos.z).normalize();
    const lateral = Math.max(0.9, dist * Math.tan((spreadDeg * Math.PI) / 180));
    const along = Math.max(0.9, dist * 0.08);
    this.ellipse.position.set(end.x, world.heightAt(end.x, end.z) + 0.08, end.z);
    this.ellipse.rotation.set(0, Math.atan2(dir.x, dir.z), 0);
    this.ellipse.scale.set(lateral, 1, along);
    const bad = r.phase === Phase.OUT || r.phase === Phase.WATER;
    (this.ellipse.material as THREE.MeshBasicMaterial).color.copy(bad ? RED : WHITE);
  }
}
