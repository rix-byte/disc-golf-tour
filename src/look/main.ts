// Look test: one Mežinieki hole rendered as well as the browser allows, to
// compare with the Godot game before building any gameplay on the web.
// Keys 1–5 switch camera shots. ?hole=N picks the hole (default 1).

import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { CourseJson, buildWorld } from "../shared/world";
import { buildGrass, grassTime } from "./grass";
import { buildScatter, buildTrees } from "./nature";
import { makeBasket, makeGolfer, makeTeePad, makeTeeSign } from "./props";
import { buildSkirt, buildTerrain } from "./terrain";

const W = 1600;
const H = 900;
const info = document.getElementById("info")!;

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
// Khronos PBR Neutral keeps hues and saturation (AgX washed the greens out).
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);
// Give the GPU memory back on reload; otherwise a few dev reloads in a row
// exhaust a 4 GB card and the browser disables WebGL for the session.
addEventListener("pagehide", () => {
  renderer.dispose();
  renderer.forceContextLoss();
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 3000);

const params = new URLSearchParams(location.search);
const holeIdx = Math.max(0, Number(params.get("hole") ?? 1) - 1);

const texLoader = new THREE.TextureLoader();
function tex(path: string, srgb: boolean): Promise<THREE.Texture> {
  return texLoader.loadAsync(path).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

async function main() {
  const [course, hdr, grass, grassNormal, forest, dirt] = await Promise.all([
    fetch("courses/mezinieki.json").then((r) => r.json() as Promise<CourseJson>),
    new HDRLoader().loadAsync("art/sky/kloofendal_puresky_2k.hdr"),
    tex("art/ground/leafy_grass_diff_2k.jpg", true),
    tex("art/ground/leafy_grass_nor_gl_2k.jpg", false),
    tex("art/ground/forest_ground_04_diff_2k.jpg", true),
    tex("art/ground/brown_mud_leaves_01_diff_2k.jpg", true),
  ]);
  info.textContent = "Building course…";
  const world = buildWorld(course);
  const hole = world.holes[Math.min(holeIdx, world.holes.length - 1)];

  // Sky and image-based light from the HDRI.
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = hdr;
  scene.environment = hdr;
  scene.environmentIntensity = 0.75;
  scene.backgroundIntensity = 0.9;
  scene.fog = new THREE.FogExp2(0xb9cbd6, 0.0028);

  const ground = { grass, grassNormal, forest, dirt };
  scene.add(buildTerrain(world, ground), buildSkirt(world, ground));

  // Hole axes.
  const tee = new THREE.Vector3(hole.tee.x, hole.tee.y, hole.tee.z);
  const basketPos = new THREE.Vector3(hole.basket.x, hole.basket.y, hole.basket.z);
  const first = hole.path[1];
  const fwd = new THREE.Vector3(first.x - tee.x, 0, first.y - tee.z).normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const yaw = Math.atan2(fwd.x, fwd.z);

  // Afternoon sun from behind-left of the thrower, so the fairway shows long side shadows.
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.8);
  const sunDir = fwd.clone().multiplyScalar(-0.55).add(right.clone().multiplyScalar(-0.75)).setY(0.62).normalize();
  const mid = tee.clone().lerp(basketPos, 0.5);
  sun.position.copy(mid).addScaledVector(sunDir, 150);
  sun.target.position.copy(mid);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -85;
  sc.right = sc.top = 85;
  sc.near = 10;
  sc.far = 400;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // Hole furniture.
  const pad = makeTeePad();
  pad.position.copy(tee).addScaledVector(fwd, 1.0);
  pad.position.y = world.heightAt(pad.position.x, pad.position.z) - 0.03;
  pad.rotation.y = yaw;
  const sign = makeTeeSign(holeIdx + 1, hole.par, Math.round(hole.length));
  sign.position.copy(tee).addScaledVector(fwd, -0.6).addScaledVector(right, -1.9);
  sign.position.y = world.heightAt(sign.position.x, sign.position.z);
  sign.rotation.y = yaw + Math.PI * 0.85;
  const basket = makeBasket();
  basket.position.copy(basketPos);
  scene.add(pad, sign, basket);

  info.textContent = "Planting trees…";
  const focus = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ x: tee.x + (basketPos.x - tee.x) * t, z: tee.z + (basketPos.z - tee.z) * t }));
  const [trees, scatter, golfer] = await Promise.all([buildTrees(world), buildScatter(world, focus, 40), makeGolfer(params.get("golfer") ?? "ai", params.get("rest") === "tpose" ? "tpose" : "bind")]);
  scene.add(trees, scatter, buildGrass(world, { focus, radius: 48 }, 240000));
  golfer.root.position.copy(tee).addScaledVector(fwd, 0.4);
  golfer.root.position.y = pad.position.y + 0.12;
  golfer.root.rotation.y = yaw;
  scene.add(golfer.root);

  // Post: ambient occlusion, then tone mapping + sRGB.
  const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(1);
  composer.setSize(W, H);
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, camera, W, H);
  gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.6, thickness: 1.5, scale: 1.1, samples: 16 });
  gtao.blendIntensity = 0.85;
  composer.addPass(gtao);
  composer.addPass(new OutputPass());

  // Camera shots.
  const at = (p: THREE.Vector3, dx: number, dy: number, dz: number) => p.clone().addScaledVector(right, dx).addScaledVector(fwd, dz).setY(p.y + dy);
  const shots: Record<string, () => [THREE.Vector3, THREE.Vector3, number]> = {
    tee: () => [at(tee, 0.9, 2.3, -4.6), at(tee, 0, 0.6, 30), 48],
    fairway: () => {
      const p = tee.clone().lerp(basketPos, 0.55);
      p.y = world.heightAt(p.x, p.z);
      return [at(p, -1.5, 1.7, 0), basketPos.clone().setY(basketPos.y + 1.0), 50];
    },
    basket: () => [at(basketPos, 1.4, 1.05, -3.0), basketPos.clone().setY(basketPos.y + 0.85), 45],
    overview: () => [at(tee, -22, 48, -30), mid.clone().setY(mid.y + 2), 45],
    golfer: () => {
      const g = golfer.root.position;
      return [at(g, 1.6, 1.45, 2.6), g.clone().setY(g.y + 1.05), 40];
    },
    low: () => {
      const p = at(tee, 2.5, 0, 7);
      p.y = world.heightAt(p.x, p.z) + 0.4;
      return [p, at(tee, 1.5, 1.2, 40), 55];
    },
  };
  const names = Object.keys(shots);
  let current = "tee";
  const setShot = (name: string) => {
    const s = shots[name];
    if (!s) return;
    current = name;
    const [pos, look, fov] = s();
    camera.position.copy(pos);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.lookAt(look);
    info.textContent = `Hole ${holeIdx + 1} · shot "${name}" · keys 1–${names.length}: ${names.join(", ")}`;
  };
  setShot(params.get("shot") ?? "tee");
  addEventListener("keydown", (e) => {
    const i = Number(e.key) - 1;
    if (i >= 0 && i < names.length) setShot(names[i]);
  });

  const clock = new THREE.Clock();
  let t = 0;
  const frame = (dt: number) => {
    t += dt;
    grassTime.value = t;
    golfer.mixer.update(dt);
    composer.render(dt);
  };
  const loop = () => {
    frame(Math.min(clock.getDelta(), 0.1));
    requestAnimationFrame(loop);
  };
  loop();

  // For screenshots from the dev tools: look.capture("name") saves shots/<name>.png.
  Object.assign(window, {
    look: {
      shots: names,
      shot: setShot,
      current: () => current,
      step: (dt = 1 / 60) => frame(dt),
      capture: async (name: string) => {
        frame(1 / 60);
        const blob = await new Promise<Blob>((res) => renderer.domElement.toBlob((b) => res(b!), "image/png"));
        await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: "POST", body: blob });
        return name;
      },
      info: () => renderer.info.render,
    },
  });

  // ?autoshot=prefix:shot1,shot2 — capture those shots after load, then
  // post "<prefix>_done" (for headless browsers, which can't be scripted here).
  const auto = params.get("autoshot");
  if (auto) {
    const [prefix, list] = auto.split(":");
    const look = (window as unknown as { look: { capture: (n: string) => Promise<string> } }).look;
    for (const name of (list ?? names.join(",")).split(",")) {
      setShot(name);
      for (let i = 0; i < 30; i++) frame(1 / 30);
      await look.capture(`${prefix}_${name}`);
    }
    await fetch(`/__shot?name=${encodeURIComponent(prefix)}_done`, { method: "POST", body: "" });
  }
}

main().catch((e) => {
  info.textContent = `Error: ${e instanceof Error ? e.message : e}`;
  console.error(e);
});
