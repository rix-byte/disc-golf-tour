// Instanced grass tufts that sway in the wind. Each instance is a tuft of
// blades; mown fairway gets short tufts, rough gets long ones, the forest
// floor gets few. Placement is static over an area of interest.

import * as THREE from "three";
import { createNoise2D } from "simplex-noise";
import { Rng } from "../shared/rng";
import { Surface, World } from "../shared/world";

export const grassTime = { value: 0 };

/** One tuft: `blades` curved blades around the origin, 1 m tall before scaling. */
function tuftGeometry(blades: number, seed: number): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const pos: number[] = [];
  const tip: number[] = []; // 0 at root, 1 at tip (for colour + sway)
  const idx: number[] = [];
  const SEG = 3;
  for (let b = 0; b < blades; b++) {
    const a = rng.next() * Math.PI * 2;
    const r = rng.next() * 0.09;
    const ox = Math.cos(a) * r;
    const oz = Math.sin(a) * r;
    const facing = rng.next() * Math.PI;
    const lean = 0.15 + rng.next() * 0.35;
    const h = 0.55 + rng.next() * 0.45;
    const wdt = 0.012 + rng.next() * 0.01;
    const fx = Math.cos(facing);
    const fz = Math.sin(facing);
    const lx = Math.cos(a) * lean;
    const lz = Math.sin(a) * lean;
    const base = pos.length / 3;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const bend = t * t; // curves over toward the tip
      const cx = ox + lx * bend * h;
      const cz = oz + lz * bend * h;
      const y = h * t * (1 - 0.15 * bend);
      const half = wdt * (1 - t * 0.92);
      pos.push(cx - fx * half, y, cz - fz * half, cx + fx * half, y, cz + fz * half);
      tip.push(t, t);
    }
    for (let s = 0; s < SEG; s++) {
      const i = base + s * 2;
      idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("tip", new THREE.Float32BufferAttribute(tip, 1));
  // Normals straight up: blades then light like the ground under them, which
  // reads as a soft lawn rather than a field of dark slivers.
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

function grassMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = grassTime;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float tip;\nuniform float uTime;\nvarying float vTip;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vTip = tip;
        vec3 root = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float gust = sin(uTime * 1.3 + root.x * 0.11 + root.z * 0.07) * 0.5 + 0.5;
        float wave = sin(uTime * 2.7 + root.x * 0.9 + root.z * 0.6);
        float sway = (0.06 + 0.16 * gust) * (0.6 + 0.4 * wave) * tip * tip;
        // Undo mirroring so every tuft leans the same way in the world.
        transformed.x += sway * sign(instanceMatrix[0][0]);
        transformed.z += sway * 0.45 * sign(instanceMatrix[2][2]);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vTip;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        // Dark, damp base to a light, slightly yellow tip.
        diffuseColor.rgb *= mix(vec3(0.16, 0.26, 0.07), vec3(0.78, 0.92, 0.38), smoothstep(0.0, 1.0, vTip));`,
      );
  };
  return mat;
}

export interface GrassArea {
  /** Points the camera looks at; grass is densest near them. */
  focus: { x: number; z: number }[];
  /** Radius around each focus point that gets grass. */
  radius: number;
}

/**
 * Grass tufts over the area, split into 24 m chunks (one InstancedMesh each)
 * so tufts off screen are skipped. `blades` per tuft trades density for speed.
 */
export function buildGrass(w: World, area: GrassArea, budget = 90000, blades = 8): THREE.Group {
  const geo = tuftGeometry(blades, 3);
  const mat = grassMaterial();
  const CHUNK = 24;
  const chunks = new Map<string, { m: THREE.Matrix4; c: THREE.Color }[]>();
  const rng = new Rng(21);
  const noise = createNoise2D(() => rng.next());
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  const xs = area.focus.map((f) => f.x);
  const zs = area.focus.map((f) => f.z);
  const x0 = Math.min(...xs) - area.radius;
  const x1 = Math.max(...xs) + area.radius;
  const z0 = Math.min(...zs) - area.radius;
  const z1 = Math.max(...zs) + area.radius;
  let n = 0;
  let tries = 0;
  while (n < budget && tries < budget * 6) {
    tries++;
    const x = x0 + rng.next() * (x1 - x0);
    const z = z0 + rng.next() * (z1 - z0);
    if (!w.inBounds(x, z)) continue;
    let near = Infinity;
    for (const f of area.focus) near = Math.min(near, Math.hypot(f.x - x, f.z - z));
    if (near > area.radius) continue;
    // Thin out with distance from the focus points (far grass reads from texture anyway).
    if (rng.next() > 1.15 - near / area.radius) continue;
    const surf = w.surfaceAt(x, z);
    if (surf === Surface.PAD) continue;
    let height: number;
    let keep = 1;
    if (surf === Surface.FAIRWAY) height = 0.09 + rng.next() * 0.05;
    else if (surf === Surface.TALL) height = 0.45 + rng.next() * 0.35;
    else height = 0.16 + rng.next() * 0.16 + Math.max(0, noise(x * 0.07, z * 0.07)) * 0.3;
    for (const t of w.treesNear(x, z)) {
      if (t.kind === "bush") continue;
      const d = Math.hypot(t.x - x, t.z - z);
      if (d < t.trunkR + 0.25) keep = 0;
      else if (d < t.trunkR + 5) keep = Math.min(keep, 0.25);
    }
    for (const h of w.holes) {
      if (Math.hypot(h.basket.x - x, h.basket.z - z) < 0.25) keep = 0;
      if (Math.hypot(h.tee.x - x, h.tee.z - z) < 3.4) keep = Math.min(keep, 0.3);
    }
    if (rng.next() > keep) continue;
    p.set(x, w.heightAt(x, z) - 0.02, z);
    // No yaw: the sway in the shader is in the tuft's own axes, so every tuft
    // must keep the same orientation for the wind to blow one way. Mirroring
    // (negative x scale) still breaks up the repetition.
    q.identity();
    const wide = 0.7 + rng.next() * 0.6;
    s.set(rng.next() < 0.5 ? -wide : wide, height, rng.next() < 0.5 ? -wide : wide);
    m.compose(p, q, s);
    const shade = 0.5 + 0.5 * noise(x * 0.03 + 9, z * 0.03);
    c.setRGB(0.62 + 0.12 * shade, 0.78 + 0.1 * shade, 0.42 + 0.05 * shade);
    if (surf === Surface.TALL) c.multiplyScalar(0.95).offsetHSL(-0.02, -0.05, 0.03);
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    let list = chunks.get(key);
    if (!list) chunks.set(key, (list = []));
    list.push({ m: m.clone(), c: c.clone() });
    n++;
  }
  const group = new THREE.Group();
  for (const list of chunks.values()) {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    list.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      mesh.setColorAt(i, it.c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere(); // per chunk, so the camera skips chunks off screen
    group.add(mesh);
  }
  return group;
}
