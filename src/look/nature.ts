// Trees from the course data and scattered plants, drawn with the CC0
// Quaternius Stylized Nature models as instanced meshes. Leaves sway.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Rng } from "../shared/rng";
import { Surface, Tree, World } from "../shared/world";
import { grassTime } from "./grass";

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group>>();

export function load(name: string): Promise<THREE.Group> {
  let p = cache.get(name);
  if (!p) cache.set(name, (p = loader.loadAsync(`art/nature/${name}.gltf`).then((g) => g.scene)));
  return p;
}

/** Leaves and plants bend with the same wind clock as the grass. */
export function foliage(mat: THREE.MeshStandardMaterial, amount: number): THREE.MeshStandardMaterial {
  const m = mat.clone();
  m.alphaTest = 0.5;
  m.transparent = false;
  m.side = THREE.DoubleSide;
  m.roughness = 0.8;
  m.metalness = 0;
  // Several Quaternius plants bake dark/red vertex colours that fight our tints.
  m.vertexColors = false;
  // The bush leaves ship with an autumn red tint; this course is midsummer.
  // Its vertex colours carry the red too, so they go as well.
  if (/TwistedTree/i.test(mat.name)) {
    m.color.setHex(0x6f9a45);
    m.vertexColors = false;
  }
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = grassTime;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nuniform float uTime;").replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      vec3 root = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      float h = max(position.y, 0.0);
      float w = sin(uTime * 1.1 + root.x * 0.13 + root.z * 0.09) * 0.6 + sin(uTime * 2.3 + position.x * 1.7 + position.z * 1.3) * 0.25;
      transformed.x += w * ${amount.toFixed(4)} * h * h;
      transformed.z += w * ${(amount * 0.5).toFixed(4)} * h * h;`,
    );
  };
  m.customProgramCacheKey = () => `foliage${amount}`;
  return m;
}

interface Placed { matrix: THREE.Matrix4 }

const CHUNK = 48;

/**
 * One InstancedMesh per mesh part of the model per 48 m chunk of the course,
 * so the camera and the shadow pass skip chunks they can't see.
 */
async function instance(name: string, placed: Placed[], opts: { sway: number; shadow: boolean }): Promise<THREE.Group> {
  const out = new THREE.Group();
  if (!placed.length) return out;
  const scene = await load(name);
  scene.updateMatrixWorld(true);
  const chunks = new Map<string, Placed[]>();
  const pos = new THREE.Vector3();
  for (const p of placed) {
    pos.setFromMatrixPosition(p.matrix);
    const key = `${Math.floor(pos.x / CHUNK)},${Math.floor(pos.z / CHUNK)}`;
    let list = chunks.get(key);
    if (!list) chunks.set(key, (list = []));
    list.push(p);
  }
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((mm) => {
      const sm = mm as THREE.MeshStandardMaterial;
      const leafy = /leaves|leaf|flower|grass|fern/i.test(sm.name);
      if (leafy) return foliage(sm, opts.sway);
      const c = sm.clone();
      c.metalness = 0;
      c.roughness = 0.9;
      c.alphaTest = sm.alphaTest || 0;
      return c;
    });
    for (const list of chunks.values()) {
      const im = new THREE.InstancedMesh(geo, mats.length === 1 ? mats[0] : mats, list.length);
      list.forEach((p, i) => im.setMatrixAt(i, p.matrix));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = opts.shadow;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      out.add(im);
    }
  });
  return out;
}

const place = (x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz = sx) =>
  ({ matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(sx, sy, sz)) });

export const MODEL_TOP = 7.0; // the Quaternius trees are ~7 m tall

export async function buildTrees(w: World): Promise<THREE.Group> {
  const group = new THREE.Group();
  const buckets = new Map<string, Placed[]>();
  const add = (name: string, p: Placed) => {
    let list = buckets.get(name);
    if (!list) buckets.set(name, (list = []));
    list.push(p);
  };
  for (const t of w.trees as Tree[]) {
    if (t.dead) continue;
    const rng = new Rng(t.id * 97 + 13);
    const yaw = rng.next() * Math.PI * 2;
    // Scaling the 7 m models up to the LiDAR heights (~28 m) uniformly gives
    // redwood trunks; stretch them tall but keep trunks and crowns slim.
    const sy = Math.min(t.height / MODEL_TOP, 3.0) * (0.9 + rng.next() * 0.2);
    if (t.kind === "pine") {
      add(`Pine_${1 + (t.id % 5)}`, place(t.x, t.base - 0.2, t.z, yaw, Math.min(sy, 2.0) * 0.62, sy));
    } else if (t.kind === "leaf") {
      add(`CommonTree_${1 + (t.id % 5)}`, place(t.x, t.base - 0.2, t.z, yaw, Math.min(sy, 2.2) * 0.8, sy * 0.85));
    } else if (t.kind === "bush") {
      const s = t.height / 1.35;
      add("Bush_Common", place(t.x, t.base - 0.1, t.z, yaw, s, s));
    }
  }
  const parts = await Promise.all([...buckets].map(([name, list]) => instance(name, list, { sway: 0.0009, shadow: true })));
  for (const p of parts) group.add(p);
  return group;
}

/** Bushes, ferns, flowers, rocks and mushrooms around the area of interest. */
export async function buildScatter(w: World, focus: { x: number; z: number }[], radius: number): Promise<THREE.Group> {
  const group = new THREE.Group();
  const rng = new Rng(404);
  const buckets = new Map<string, Placed[]>();
  const add = (name: string, p: Placed) => {
    let list = buckets.get(name);
    if (!list) buckets.set(name, (list = []));
    list.push(p);
  };
  const nearTree = (x: number, z: number) => {
    let best = Infinity;
    for (const t of w.treesNear(x, z)) if (t.kind !== "bush") best = Math.min(best, Math.hypot(t.x - x, t.z - z) - t.trunkR);
    return best;
  };
  const clearOfHoles = (x: number, z: number, r: number) =>
    w.holes.every((h) => Math.hypot(h.tee.x - x, h.tee.z - z) > r + 3 && Math.hypot(h.basket.x - x, h.basket.z - z) > r + 2.5);
  for (const f of focus)
    for (let i = 0; i < 900; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = Math.sqrt(rng.next()) * radius;
      const x = f.x + Math.cos(a) * d;
      const z = f.z + Math.sin(a) * d;
      if (!w.inBounds(x, z)) continue;
      const surf = w.surfaceAt(x, z);
      if (surf === Surface.FAIRWAY || surf === Surface.PAD) continue;
      const y = w.heightAt(x, z);
      const tree = nearTree(x, z);
      const yaw = rng.next() * Math.PI * 2;
      const roll = rng.next();
      if (tree < 4 && roll < 0.35 && clearOfHoles(x, z, 1.5)) add("Fern_1", place(x, y - 0.05, z, yaw, 0.1 + rng.next() * 0.06, 0.12 + rng.next() * 0.08));
      // shortcut: the Quaternius bushes render as dark lumps here (their leaf
      // texture is a white mask); left out until there's a better bush asset.
      else if (tree < 2.5 && roll < 0.5) add("Mushroom_Common", place(x, y, z, yaw, 0.12, 0.12));
      else if (roll < 0.62 && clearOfHoles(x, z, 0.5)) add(rng.next() < 0.5 ? "Flower_3_Group" : "Flower_4_Group", place(x, y - 0.02, z, yaw, 0.18 + rng.next() * 0.1, 0.18 + rng.next() * 0.12));
      else if (roll < 0.7) add(rng.next() < 0.5 ? "Clover_1" : "Clover_2", place(x, y - 0.02, z, yaw, 0.35, 0.35));
      else if (roll < 0.715 && clearOfHoles(x, z, 2)) add(`Rock_Medium_${1 + Math.floor(rng.next() * 3)}`, place(x, y - 0.25, z, yaw, 0.25 + rng.next() * 0.35, 0.2 + rng.next() * 0.25));
    }
  const parts = await Promise.all(
    [...buckets].map(([name, list]) => instance(name, list, { sway: /Rock|Mushroom/.test(name) ? 0 : 0.02, shadow: /Bush|Rock/.test(name) })),
  );
  for (const p of parts) group.add(p);
  return group;
}
