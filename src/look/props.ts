// Basket, tee pad, tee sign and the golfer.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { BAND_HIGH, BAND_LOW, CHAIN_LOW, CHAIN_R, TRAY_LOW, TRAY_R, TRAY_TOP } from "../shared/physics";
import { mixamoRig, retargetByDirection, retargetClip, ualToUnreal } from "./retarget";

const steel = () => new THREE.MeshStandardMaterial({ color: 0xc9ced2, metalness: 0.85, roughness: 0.32 });
const powder = (color: number) => new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.45 });

/** A competition basket: galvanised pole and chains, yellow powder-coated band and tray rim. */
export function makeBasket(): THREE.Group {
  const g = new THREE.Group();
  const metal = steel();
  const yellow = powder(0xf0b81c);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, y: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.y = y;
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  add(new THREE.CylinderGeometry(0.024, 0.024, BAND_HIGH + 0.06, 12), metal, (BAND_HIGH + 0.06) / 2);
  // Tray: open cylinder of wire mesh (dark, see-through look via thin rings) + yellow rim.
  add(new THREE.CylinderGeometry(TRAY_R, TRAY_R * 0.94, TRAY_TOP - TRAY_LOW, 32, 1, true), new THREE.MeshStandardMaterial({ color: 0x9aa1a6, metalness: 0.8, roughness: 0.4, side: THREE.DoubleSide, transparent: true, opacity: 0.55 }), (TRAY_LOW + TRAY_TOP) / 2);
  add(new THREE.TorusGeometry(TRAY_R, 0.014, 8, 40).rotateX(Math.PI / 2), yellow, TRAY_TOP);
  add(new THREE.TorusGeometry(TRAY_R * 0.94, 0.01, 8, 40).rotateX(Math.PI / 2), metal, TRAY_LOW);
  add(new THREE.CircleGeometry(TRAY_R * 0.94, 32).rotateX(-Math.PI / 2), metal, TRAY_LOW + 0.005);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const bar = add(new THREE.CylinderGeometry(0.005, 0.005, TRAY_TOP - TRAY_LOW, 4), metal, (TRAY_LOW + TRAY_TOP) / 2);
    bar.position.x = Math.cos(a) * TRAY_R * 0.97;
    bar.position.z = Math.sin(a) * TRAY_R * 0.97;
  }
  // Top band and lid.
  add(new THREE.CylinderGeometry(CHAIN_R + 0.035, CHAIN_R + 0.035, BAND_HIGH - BAND_LOW, 40, 1, true), yellow, (BAND_LOW + BAND_HIGH) / 2).material = Object.assign(yellow.clone(), { side: THREE.DoubleSide });
  add(new THREE.CylinderGeometry(0.05, CHAIN_R + 0.035, 0.06, 40), metal, BAND_HIGH + 0.03);
  // Chains: two rings of links (outer 16, inner 8), each a sagging strand.
  const linkMat = new THREE.MeshStandardMaterial({ color: 0xdfe3e6, metalness: 0.9, roughness: 0.25 });
  const strands: THREE.BufferGeometry[] = [];
  const ring = (count: number, r: number, twist: number, low: number) => {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const top = new THREE.Vector3(Math.cos(a) * r, BAND_LOW + 0.01, Math.sin(a) * r);
      const bot = new THREE.Vector3(Math.cos(a + twist) * 0.05, low, Math.sin(a + twist) * 0.05);
      const mid = top.clone().lerp(bot, 0.5);
      mid.x *= 1.12;
      mid.z *= 1.12;
      const curve = new THREE.QuadraticBezierCurve3(top, mid, bot);
      strands.push(new THREE.TubeGeometry(curve, 10, 0.0055, 4, false));
    }
  };
  ring(16, CHAIN_R, 0.5, CHAIN_LOW);
  ring(8, CHAIN_R * 0.6, -0.4, CHAIN_LOW + 0.05);
  for (const s of strands) {
    const m = new THREE.Mesh(s, linkMat);
    m.castShadow = true;
    g.add(m);
  }
  // Number plate on the pole.
  return g;
}

/** Tee pad: rubber mat on a timber frame, flush with the ground. */
export function makeTeePad(length = 3.6, width = 1.6): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2b2f2c, roughness: 0.95, map: matTexture() });
  const pad = new THREE.Mesh(new THREE.BoxGeometry(width, 0.14, length), mat);
  pad.position.y = 0.05;
  pad.receiveShadow = true;
  pad.castShadow = true;
  const wood = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 });
  for (const sx of [-1, 1]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, length + 0.18), wood);
    beam.position.set(sx * (width / 2 + 0.045), 0.04, 0);
    beam.receiveShadow = beam.castShadow = true;
    g.add(beam);
  }
  for (const sz of [-1, 1]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(width + 0.18, 0.16, 0.09), wood);
    beam.position.set(0, 0.04, sz * (length / 2 + 0.045));
    beam.receiveShadow = beam.castShadow = true;
    g.add(beam);
  }
  g.add(pad);
  return g;
}

function matTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d")!;
  x.fillStyle = "#777";
  x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const v = 90 + Math.random() * 70;
    x.fillStyle = `rgb(${v},${v},${v})`;
    x.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 4);
  return t;
}

/** Hole sign beside the tee: hole number, par and distance. */
export function makeTeeSign(hole: number, par: number, metres: number): THREE.Group {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4b2e, roughness: 0.9 });
  for (const sx of [-0.32, 0.32]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.1, 0.08), wood);
    post.position.set(sx, 0.55, 0);
    post.castShadow = true;
    g.add(post);
  }
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 384;
  const x = c.getContext("2d")!;
  x.fillStyle = "#1f4d2e";
  x.fillRect(0, 0, 512, 384);
  x.strokeStyle = "#f2e6c9";
  x.lineWidth = 10;
  x.strokeRect(14, 14, 484, 356);
  x.fillStyle = "#f2e6c9";
  x.textAlign = "center";
  x.font = "bold 150px system-ui";
  x.fillText(String(hole), 256, 180);
  x.font = "bold 56px system-ui";
  x.fillText(`PAR ${par}  ·  ${metres} m`, 256, 290);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 0.04), [wood, wood, wood, wood, new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 }), wood]);
  board.position.y = 1.05;
  board.castShadow = true;
  g.add(board);
  return g;
}

export interface Golfer { root: THREE.Group; mixer: THREE.AnimationMixer }

/**
 * Clothes without new art: colour the one-piece mannequin by where each
 * vertex sits in the T-pose (cap, skin, polo with sleeves, shorts, socks, shoes).
 */
function dressUp(mat: THREE.MeshStandardMaterial, keepSkinTexture = false) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vBind;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBind = position;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vBind;").replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      vec3 skin = ${keepSkinTexture ? "diffuseColor.rgb" : "vec3(0.80, 0.60, 0.47)"};
      vec3 polo = vec3(0.10, 0.36, 0.62);
      vec3 shorts = vec3(0.16, 0.18, 0.22);
      vec3 sock = vec3(0.92);
      vec3 shoe = vec3(0.95, 0.42, 0.18);
      vec3 cap = vec3(0.92, 0.92, 0.88);
      float y = vBind.y;
      float ax = abs(vBind.x);
      vec3 c = skin;
      if (y < ${keepSkinTexture ? "0.125" : "0.09"}) c = shoe;
      else if (y < ${keepSkinTexture ? "0.19" : "0.2"}) c = sock;
      else if (y > 0.52 && y < 0.98) c = shorts;
      else if (y >= 0.98 && y < 1.53 && ax < 0.42) c = polo;
      ${keepSkinTexture ? "" : "if (y > 1.73) c = cap;"}
      diffuseColor.rgb = c;`,
    );
  };
  mat.customProgramCacheKey = () => `golfer-outfit-${keepSkinTexture}`;
}

let ual: Promise<import("three/addons/loaders/GLTFLoader.js").GLTF> | null = null;
const loadUal = () => (ual ??= new GLTFLoader().loadAsync("art/character/AnimationLibrary_Godot_Standard.glb"));

/**
 * Golfer by kind: "mannequin" (UAL test dummy), "ubc-m" / "ubc-f" (Quaternius
 * Universal Base Characters, free Superhero bodies, idle retargeted from UAL).
 */
export async function makeGolfer(kind = "mannequin", rest: "bind" | "tpose" = "bind"): Promise<Golfer> {
  if (kind.startsWith("ubc")) return makeUbcGolfer(kind === "ubc-f", rest);
  if (kind === "ai") return makeRiggedGolfer("art/golfer/golfer_rigged.glb");
  if (kind === "ai-static") return makeStaticGolfer("art/golfer/golfer_static.glb");
  return makeMannequin();
}

/** The approved throws, exported from the Unity/Blender mocap work on a Mixamo skeleton. */
export const THROWS = ["bh_drive", "fh", "push_putt"];

/**
 * Map one approved throw onto a Mixamo-rigged character. Both skeletons use
 * Mixamo bone names, so the map is name-to-name; the retarget handles the
 * different body proportions and the bones (fingers) the target lacks.
 */
async function loadThrow(id: string, target: THREE.Object3D): Promise<THREE.AnimationClip> {
  const src = await new GLTFLoader().loadAsync(`art/golfer/throws/${id}.glb`);
  return retargetByDirection(src.scene, src.animations[0], target, mixamoRig(), 60);
}

/**
 * The AI golfer rigged by Mixamo, with its clips (Idle, FrisbeeThrow) and,
 * via ?anim=bh_drive|fh|push_putt, the approved throws retargeted onto him.
 * ?anim=<clip> picks the clip; ?at=<seconds> freezes it at that time (for stills).
 */
async function makeRiggedGolfer(url: string): Promise<Golfer> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene as unknown as THREE.Group;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    const mat = m.material as THREE.MeshStandardMaterial;
    mat.roughness = 0.75;
    mat.metalness = 0;
  });
  const params = new URLSearchParams(location.search);
  const want = params.get("anim") ?? "Idle";
  let clip = gltf.animations.find((a) => a.name === want);
  if (!clip && THROWS.includes(want)) clip = await loadThrow(want, root);
  clip ??= gltf.animations[0];
  const mixer = new THREE.AnimationMixer(root);
  if (clip) {
    const action = mixer.clipAction(clip).play();
    const at = params.get("at");
    if (at !== null) {
      action.time = Number(at);
      action.paused = true;
    }
  }
  return { root, mixer };
}

/** An unrigged model (AI image-to-3D, coloured by projection), standing in its T-pose. */
async function makeStaticGolfer(url: string): Promise<Golfer> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene as unknown as THREE.Group;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    const mat = m.material as THREE.MeshStandardMaterial;
    mat.roughness = 0.75;
    mat.metalness = 0;
  });
  return { root, mixer: new THREE.AnimationMixer(root) };
}

async function makeUbcGolfer(female: boolean, rest: "bind" | "tpose"): Promise<Golfer> {
  const loader = new GLTFLoader();
  const sex = female ? "Female" : "Male";
  const [src, body, hair, brows] = await Promise.all([
    loadUal(),
    loader.loadAsync(`art/ubc/Superhero_${sex}_FullBody.gltf`),
    loader.loadAsync(`art/ubc/${female ? "Hair_Long" : "Hair_SimpleParted"}.gltf`),
    loader.loadAsync(`art/ubc/Eyebrows_${female ? "Female" : "Regular"}.gltf`),
  ]);
  const root = body.scene as unknown as THREE.Group;
  // Hair and brows are skinned to their own copy of the head bone: rebind to the body's.
  const bodyBones = new Map<string, THREE.Bone>();
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bodyBones.set(o.name, o as THREE.Bone);
  });
  for (const extra of [hair.scene, brows.scene]) {
    const meshes: THREE.SkinnedMesh[] = [];
    extra.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
    });
    for (const m of meshes) {
      const bones = m.skeleton.bones.map((b) => bodyBones.get(b.name) ?? b);
      m.removeFromParent();
      root.add(m);
      m.bind(new THREE.Skeleton(bones, m.skeleton.boneInverses), m.bindMatrix);
    }
  }
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    const mat = m.material as THREE.MeshStandardMaterial;
    // The hair texture is grey, meant to be tinted by Quaternius' own shader.
    if (/Hair/i.test(mat.name)) {
      const c = mat.clone();
      c.color.setHex(0x5a3a24);
      m.material = c;
    }
    if (/Superhero/i.test(mat.name)) {
      const c = mat.clone();
      dressUp(c, true);
      m.material = c;
    }
  });
  const idleSrc = src.animations.find((a) => a.name === "Idle_Loop")!;
  const tpose = src.animations.find((a) => a.name === "A_TPose");
  const clip = retargetClip(src.scene, idleSrc, root, ualToUnreal(), {
    srcHips: "DEF-hips",
    tgtHips: "pelvis",
    restClip: rest === "tpose" ? tpose : undefined,
  });
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(clip).play();
  return { root, mixer };
}

/** The CC0 Universal Animation Library mannequin, idling, in a polo and shorts. */
async function makeMannequin(): Promise<Golfer> {
  const gltf = await loadUal();
  const root = gltf.scene;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    m.material = mats.map((mm) => {
      const s = (mm as THREE.MeshStandardMaterial).clone();
      s.roughness = 0.7;
      s.metalness = 0;
      if (/Joints/i.test(s.name)) {
        s.color.set(0x2a2f36);
        return s;
      }
      s.color.set(0xffffff);
      s.map = null;
      dressUp(s);
      return s;
    }) as unknown as THREE.Material;
    if ((m.material as unknown as THREE.Material[]).length === 1) m.material = (m.material as unknown as THREE.Material[])[0];
  });
  const mixer = new THREE.AnimationMixer(root);
  const idle = gltf.animations.find((a) => a.name === "Idle_Loop") ?? gltf.animations[0];
  mixer.clipAction(idle).play();
  return { root: root as unknown as THREE.Group, mixer };
}
