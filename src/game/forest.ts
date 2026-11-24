// The course's trees, cheap enough for a laptop's built-in GPU:
//   near (< nearDist from the camera)  the real Quaternius models, instanced
//   far                                 a camera-facing card showing a picture
//                                       of the same model, baked at load time
// Near/far is re-sorted only when the camera has moved a few metres.

import * as THREE from "three";
import { Rng } from "../shared/rng";
import { Tree, World } from "../shared/world";
import { MODEL_TOP, foliage, load } from "../look/nature";

interface Plan {
  model: string;
  x: number;
  y: number;
  z: number;
  matrix: THREE.Matrix4;
  sx: number;
  sy: number;
}

interface Variant {
  name: string;
  near: THREE.InstancedMesh[];
  far: THREE.InstancedMesh;
  /** Model bounds (unscaled) for the card size. */
  width: number;
  minY: number;
  height: number;
  trees: Plan[];
}

/** Where each tree goes and which model it uses (same rules as look/nature.ts). */
function plan(w: World): Plan[] {
  const out: Plan[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const t of w.trees as Tree[]) {
    if (t.dead) continue;
    const rng = new Rng(t.id * 97 + 13);
    const yaw = rng.next() * Math.PI * 2;
    const sy = Math.min(t.height / MODEL_TOP, 3.0) * (0.9 + rng.next() * 0.2);
    let model: string;
    let sx: number;
    let syy: number;
    let y = t.base - 0.2;
    if (t.kind === "pine") [model, sx, syy] = [`Pine_${1 + (t.id % 5)}`, Math.min(sy, 2.0) * 0.62, sy];
    else if (t.kind === "leaf") [model, sx, syy] = [`CommonTree_${1 + (t.id % 5)}`, Math.min(sy, 2.2) * 0.8, sy * 0.85];
    else if (t.kind === "bush") {
      const s = t.height / 1.35;
      [model, sx, syy] = ["Bush_Common", s, s];
      y = t.base - 0.1;
    } else continue;
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(t.x, y, t.z), new THREE.Quaternion().setFromAxisAngle(up, yaw), new THREE.Vector3(sx, syy, sx));
    out.push({ model, x: t.x, y, z: t.z, matrix, sx, sy: syy });
  }
  return out;
}

/** Cylindrical billboard: the card turns about its vertical axis to face the camera. */
function cardMaterial(map: THREE.Texture): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ map, alphaTest: 0.45, side: THREE.DoubleSide, color: 0xe8e8e8 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace(
      "#include <project_vertex>",
      `vec3 c = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      float sx = length(instanceMatrix[0].xyz);
      float sy = length(instanceMatrix[1].xyz);
      vec3 toCam = cameraPosition - c;
      toCam.y = 0.0;
      vec3 r = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-5, 0.0, 0.0));
      vec3 wp = c + r * position.x * sx + vec3(0.0, position.y * sy, 0.0);
      vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
      gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  m.customProgramCacheKey = () => "tree-card";
  return m;
}

export class Forest {
  group = new THREE.Group();
  variants: Variant[] = [];
  private last = new THREE.Vector3(Infinity, 0, 0);

  private constructor(private nearDist: number) {}

  static async build(world: World, renderer: THREE.WebGLRenderer, env: THREE.Texture, nearDist: number): Promise<Forest> {
    const f = new Forest(nearDist);
    const plans = plan(world);
    const byModel = new Map<string, Plan[]>();
    for (const p of plans) {
      let l = byModel.get(p.model);
      if (!l) byModel.set(p.model, (l = []));
      l.push(p);
    }
    for (const [name, trees] of byModel) f.variants.push(await f.variant(name, trees, renderer, env));
    return f;
  }

  private async variant(name: string, trees: Plan[], renderer: THREE.WebGLRenderer, env: THREE.Texture): Promise<Variant> {
    const scene = await load(name);
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const width = Math.max(size.x, size.z);
    // Near: one InstancedMesh per mesh part, sized for every tree of this model.
    const near: THREE.InstancedMesh[] = [];
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((mm) => {
        const sm = mm as THREE.MeshStandardMaterial;
        if (/leaves|leaf/i.test(sm.name)) return foliage(sm, 0.0009);
        const c = sm.clone();
        c.metalness = 0;
        c.roughness = 0.9;
        return c;
      });
      const im = new THREE.InstancedMesh(geo, mats.length === 1 ? mats[0] : mats, trees.length);
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false; // its set changes; the near set is small
      near.push(im);
      this.group.add(im);
    });
    // Far: a picture of the model on a card.
    const tex = bakeCard(renderer, scene, box, env, name);
    const card = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const far = new THREE.InstancedMesh(card, cardMaterial(tex), trees.length);
    far.count = 0;
    far.frustumCulled = false;
    this.group.add(far);
    return { name, near, far, width, minY: box.min.y, height: size.y, trees };
  }

  /** Re-sort near/far around the camera (cheap; skipped unless it moved 3 m). */
  update(cam: THREE.Vector3, force = false) {
    const focusMoved = this.focus ? this.focus.distanceToSquared(this.lastFocus) > 0.25 : false;
    if (!force && !focusMoved && cam.distanceToSquared(this.last) < (this.focus ? 0.25 : 9)) return;
    this.last.copy(cam);
    if (this.focus) this.lastFocus.copy(this.focus);
    this.resorts++;
    const near2 = this.nearDist * this.nearDist;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    // Line of sight camera -> focus (xz): trees standing on it are left out.
    const f0 = this.focus;
    const ax = cam.x;
    const az = cam.z;
    const bx = f0 ? f0.x - ax : 0;
    const bz = f0 ? f0.z - az : 0;
    const bl2 = bx * bx + bz * bz;
    const blocks = (t: Plan, v: Variant) => {
      const dCam = Math.hypot(t.x - ax, t.z - az);
      if (dCam < 2.5) return true; // the camera is inside its crown
      if (!f0 || bl2 < 1) return false;
      const u = ((t.x - ax) * bx + (t.z - az) * bz) / bl2;
      if (u <= 0 || u >= 0.97) return false; // behind the camera, or at/after the focus
      const px = ax + bx * u - t.x;
      const pz = az + bz * u - t.z;
      const r = Math.min(3, Math.max(1.2, v.width * t.sx * 0.3));
      return px * px + pz * pz < r * r;
    };
    for (const v of this.variants) {
      let n = 0;
      let f = 0;
      for (const t of v.trees) {
        if (this.focus && blocks(t, v)) continue;
        const d2 = (t.x - cam.x) ** 2 + (t.z - cam.z) ** 2;
        if (d2 < near2) {
          for (const im of v.near) im.setMatrixAt(n, t.matrix);
          n++;
        } else {
          pos.set(t.x, t.y + v.minY * t.sy, t.z);
          m.makeScale(v.width * t.sx, v.height * t.sy, 1).setPosition(pos);
          v.far.setMatrixAt(f++, m);
        }
      }
      for (const im of v.near) {
        im.count = n;
        im.instanceMatrix.needsUpdate = true;
      }
      v.far.count = f;
      v.far.instanceMatrix.needsUpdate = true;
    }
  }

  /** What the camera looks at (golfer / disc); trees between them get left out. null = none. */
  focus: THREE.Vector3 | null = null;
  /** How many times update() actually re-sorted (perf checks). */
  resorts = 0;
  private lastFocus = new THREE.Vector3(Infinity, 0, 0);

  /** Every tree as its real model (for baking the static shadow map once). */
  allNear() {
    for (const v of this.variants) {
      v.trees.forEach((t, i) => {
        for (const im of v.near) im.setMatrixAt(i, t.matrix);
      });
      for (const im of v.near) {
        im.count = v.trees.length;
        im.instanceMatrix.needsUpdate = true;
      }
      v.far.count = 0;
    }
    this.last.set(Infinity, 0, 0);
  }

  setNearDistance(d: number) {
    this.nearDist = d;
    this.last.set(Infinity, 0, 0);
  }
}

/** Render the model from the side into a 256x512 picture (linear light, alpha cut-out). */
function bakeCard(renderer: THREE.WebGLRenderer, model: THREE.Object3D, box: THREE.Box3, env: THREE.Texture, name: string): THREE.Texture {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const w = Math.max(size.x, size.z);
  const rt = new THREE.WebGLRenderTarget(256, 512, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const scene = new THREE.Scene();
  scene.environment = env;
  scene.environmentIntensity = 0.75;
  const clone = model.clone(true);
  clone.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const fix = (mm: THREE.Material) => {
      const c = (mm as THREE.MeshStandardMaterial).clone();
      c.metalness = 0;
      c.roughness = 0.85;
      if (/leaves|leaf/i.test(c.name)) {
        c.alphaTest = 0.5;
        c.side = THREE.DoubleSide;
        c.vertexColors = false;
        if (/TwistedTree/i.test(c.name)) c.color.setHex(0x6f9a45);
      }
      return c;
    };
    // Keep the shape: a single material stays single (an array on a mesh
    // without groups draws nothing).
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fix) : fix(mesh.material);
  });
  scene.add(clone);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(-0.6, 1, 1);
  scene.add(sun);
  const cam = new THREE.OrthographicCamera(-w / 2, w / 2, box.max.y, box.min.y, 0.1, 100);
  cam.position.set(center.x, 0, center.z + 20);
  cam.lookAt(center.x, 0, center.z);
  const prev = { target: renderer.getRenderTarget(), clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), tm: renderer.toneMapping };
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.setRenderTarget(prev.target);
  renderer.setClearColor(prev.clear, prev.alpha);
  rt.texture.name = `card-${name}`;
  return rt.texture;
}
