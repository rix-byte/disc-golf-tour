// Ground: the course heightfield as one smooth mesh, textured by blending
// four photo textures (rough grass, mown fairway, forest floor, worn dirt)
// with per-vertex weights worked out from the course data.

import * as THREE from "three";
import { createNoise2D } from "simplex-noise";
import { Rng } from "../shared/rng";
import { Surface, World } from "../shared/world";

export interface GroundTextures {
  grass: THREE.Texture;
  grassNormal: THREE.Texture;
  forest: THREE.Texture;
  dirt: THREE.Texture;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function buildTerrain(w: World, tex: GroundTextures): THREE.Mesh {
  const { cols, rows, cell } = w;
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const splat = new Float32Array(n * 3); // fairway, forest, dirt
  const macro = new Float32Array(n);
  const rng = new Rng(11);
  const noise = createNoise2D(() => rng.next());
  const fair = (ix: number, iz: number) => {
    const s = w.surface[Math.min(rows - 1, Math.max(0, iz)) * cols + Math.min(cols - 1, Math.max(0, ix))];
    return s === Surface.FAIRWAY || s === Surface.PAD ? 1 : 0;
  };
  for (let iz = 0; iz < rows; iz++)
    for (let ix = 0; ix < cols; ix++) {
      const i = iz * cols + ix;
      const x = w.origin.x + ix * cell;
      const z = w.origin.y + iz * cell;
      pos[i * 3] = x;
      pos[i * 3 + 1] = w.heights[i];
      pos[i * 3 + 2] = z;
      uv[i * 2] = x / 3.5;
      uv[i * 2 + 1] = z / 3.5;
      // Fairway: 5x5 box blur of the surface map, so its edge is soft.
      let f = 0;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) f += fair(ix + dx, iz + dz);
      // Forest floor under and around trunks.
      let forest = 0;
      for (const t of w.treesNear(x, z)) {
        if (t.kind === "bush") continue;
        const d = Math.hypot(t.x - x, t.z - z);
        forest = Math.max(forest, 1 - smooth(t.trunkR + 1.5, t.trunkR + 6, d));
      }
      // Worn dirt: behind/around tee pads, a ring under each basket, noisy patches.
      let dirt = 0;
      for (const h of w.holes) {
        dirt = Math.max(dirt, 1 - smooth(2.4, 4.2, Math.hypot(h.tee.x - x, h.tee.z - z)));
        const db = Math.hypot(h.basket.x - x, h.basket.z - z);
        dirt = Math.max(dirt, 0.75 * (1 - smooth(0.6, 2.2, Math.abs(db - 1.3))));
      }
      const patch = noise(x * 0.09, z * 0.09);
      dirt = Math.max(dirt, smooth(0.55, 0.8, patch) * 0.6);
      splat[i * 3] = (f / 25) * (1 - forest * 0.6);
      splat[i * 3 + 1] = forest;
      splat[i * 3 + 2] = dirt * (0.8 + 0.2 * noise(x * 0.6, z * 0.6));
      macro[i] = 0.5 + 0.5 * noise(x * 0.012, z * 0.012) * 0.7 + 0.15 * noise(x * 0.05, z * 0.05);
    }
  const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let iz = 0; iz < rows - 1; iz++)
    for (let ix = 0; ix < cols - 1; ix++) {
      const a = iz * cols + ix;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // Same diagonal as World.heightAt: (0,0)-(1,1).
      index.set([a, d, b, a, c, d], k);
      k += 6;
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setAttribute("splat", new THREE.BufferAttribute(splat, 3));
  geo.setAttribute("macro", new THREE.BufferAttribute(macro, 1));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.96,
    metalness: 0,
    normalMap: tex.grassNormal,
    normalScale: new THREE.Vector2(0.7, 0.7),
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.tGrass = { value: tex.grass };
    sh.uniforms.tForest = { value: tex.forest };
    sh.uniforms.tDirt = { value: tex.dirt };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 splat;\nattribute float macro;\nvarying vec3 vSplat;\nvarying float vMacro;\nvarying vec2 vWXZ;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSplat = splat; vMacro = macro; vWXZ = position.xz;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform sampler2D tGrass, tForest, tDirt;\nvarying vec3 vSplat;\nvarying float vMacro;\nvarying vec2 vWXZ;",
      )
      .replace(
        "#include <map_fragment>",
        `
        // Two scales of the grass photo hide the tiling.
        vec3 gA = texture2D(tGrass, vWXZ / 3.5).rgb;
        vec3 gB = texture2D(tGrass, vWXZ / 14.0 + 0.37).rgb;
        vec3 grass = mix(gA, gB, 0.45);
        vec3 rough = grass * mix(vec3(0.62, 0.80, 0.42), vec3(0.85, 0.95, 0.55), vMacro);
        vec3 fairway = grass * vec3(0.92, 1.12, 0.62);
        vec3 forest = mix(texture2D(tForest, vWXZ / 4.0).rgb, texture2D(tForest, vWXZ / 15.0).rgb, 0.4);
        vec3 dirt = texture2D(tDirt, vWXZ / 3.0).rgb;
        vec3 col = mix(rough, fairway, clamp(vSplat.x, 0.0, 1.0));
        col = mix(col, forest, clamp(vSplat.y, 0.0, 1.0));
        col = mix(col, dirt, clamp(vSplat.z, 0.0, 1.0));
        diffuseColor.rgb *= col;
        `,
      );
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/** A big flat ring of ground beyond the map edge, so the horizon isn't a cliff. */
export function buildSkirt(w: World, tex: GroundTextures): THREE.Mesh {
  let sum = 0;
  for (let i = 0; i < w.cols; i++) sum += w.heights[i] + w.heights[(w.rows - 1) * w.cols + i];
  const y = sum / (2 * w.cols) - 0.5;
  const g = new THREE.PlaneGeometry(6000, 6000);
  g.rotateX(-Math.PI / 2);
  const t = tex.grass.clone();
  t.repeat.set(1200, 1200);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: t, color: 0x8fae62, roughness: 1 }));
  m.position.y = y;
  m.receiveShadow = true;
  return m;
}
