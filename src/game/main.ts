// Disc Golf Tour (web): a round of Mežinieki solo, pass & play, or online.
// The world art is the look test's; the rules live in round.ts / match.ts,
// online rooms in net.ts, the start menu in menu.ts.

import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { DISCS } from "../shared/catalog";
import { FRAME_DT, yawForward } from "../shared/physics";
import { V3 } from "../shared/vec";
import { CourseJson, buildWorld } from "../shared/world";
import { grassTime } from "../look/grass";
import { Forest } from "./forest";
import { makeBasket, makeTeePad, makeTeeSign } from "../look/props";
import { buildSkirt, buildTerrain } from "../look/terrain";
import { Golfer } from "./golfer";
import { Hud } from "./hud";
import "./hud.css";
import { ASSIST, Round, TECHNIQUES, ThrowOutcome, Technique, flightFromJson, flightToJson, spreadDeg } from "./round";
import { Match } from "./match";
import { Menu } from "./menu";
import type { Msg, Net } from "./net";
import { AimLine } from "./aimline";
import { Meter, timingToLat, verdict } from "./meter";
import { FrameWatch, LEVELS, initialLevel } from "./quality";
import { Swing } from "./swing";

const W = 1600;
const H = 900;
const params = new URLSearchParams(location.search);
const info = document.getElementById("info")!;
const tv = (v: V3) => new THREE.Vector3(v.x, v.y, v.z);

// Keeping the drawing buffer costs speed; only the screenshot tools need it.
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", preserveDrawingBuffer: params.has("autoplay") || params.has("release") });
renderer.setPixelRatio(1);
const gpuName = (() => {
  const gl = renderer.getContext();
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
})();
let level = initialLevel(gpuName, params.get("q"));
const Q = () => LEVELS[level];
renderer.setSize(Math.round(W * Q().scale), Math.round(H * Q().scale), false);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = !params.has("noshadow");
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);
addEventListener("pagehide", () => {
  renderer.dispose();
  renderer.forceContextLoss();
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, W / H, 0.1, 800);

const texLoader = new THREE.TextureLoader();
const tex = (path: string, srgb: boolean) =>
  texLoader.loadAsync(path).then((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });

function makeDisc(color: number): THREE.Mesh {
  // Lathe profile: flat flight plate, rounded rim, slight dome.
  const pts = [
    [0, 0.014], [0.06, 0.013], [0.095, 0.009], [0.105, 0.0], [0.103, -0.008], [0.095, -0.01], [0.085, -0.004], [0, -0.004],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 40), new THREE.MeshStandardMaterial({ color, roughness: 0.45, side: THREE.DoubleSide }));
  m.castShadow = true;
  m.scale.setScalar(1.6); // readable from the chase camera
  return m;
}

/** A name tag that always faces the camera. */
function nameSprite(name: string, color: number): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.font = "bold 34px system-ui, sans-serif";
  const w = Math.min(248, g.measureText(name).width + 34);
  g.fillStyle = "rgba(12,16,20,0.72)";
  g.beginPath();
  g.roundRect((256 - w) / 2, 8, w, 48, 24);
  g.fill();
  g.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  g.beginPath();
  g.arc((256 - w) / 2 + 22, 32, 8, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.textBaseline = "middle";
  g.fillText(name, (256 - w) / 2 + 36, 33, w - 44);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(2.4, 0.6, 1);
  s.renderOrder = 10;
  return s;
}

/** Soft dark disc on the ground: a cheap stand-in for a real-time shadow. */
function makeBlob(radius: number): THREE.Mesh {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, opacity: 0.5, depthWrite: false }),
  );
  m.renderOrder = 1;
  return m;
}

async function main() {
  // Test tools skip the menu (solo round straight away).
  const testRun = params.has("autoplay") || params.has("perf") || params.has("release");
  const menu = testRun ? null : new Menu("Mežinieki · Alūksne", 9);
  const choice = menu ? menu.open(params.get("join") ?? undefined) : null;
  const [course, hdr, grass, grassNormal, forestFloor, dirt] = await Promise.all([
    fetch("courses/mezinieki.json").then((r) => r.json() as Promise<CourseJson>),
    new HDRLoader().loadAsync("art/sky/kloofendal_puresky_2k.hdr"),
    tex("art/ground/leafy_grass_diff_2k.jpg", true),
    tex("art/ground/leafy_grass_nor_gl_2k.jpg", false),
    tex("art/ground/forest_ground_04_diff_2k.jpg", true),
    tex("art/ground/brown_mud_leaves_01_diff_2k.jpg", true),
  ]);
  info.textContent = "Building course…";
  const world = buildWorld(course);
  // Until the menu picks the players: a placeholder solo match (the scene renders behind the menu).
  let match = new Match(world, [{ id: "p0", name: "You", local: true }]);
  let round: Round = match.current.round;
  let net: Net | null = null;
  /** Throws from this browser right now (solo / pass & play: always; online: your turn only). */
  const myTurn = () => started && match.current.local && !match.current.left;
  let started = testRun;

  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = hdr;
  scene.environment = hdr;
  scene.environmentIntensity = 0.75;
  scene.backgroundIntensity = 0.9;
  scene.fog = new THREE.FogExp2(0xb9cbd6, 0.0028);
  const ground = { grass, grassNormal, forest: forestFloor, dirt };
  scene.add(buildTerrain(world, ground), buildSkirt(world, ground));

  // Furniture for every hole.
  world.holes.forEach((h, i) => {
    const first = h.path[1];
    const fwd = new THREE.Vector3(first.x - h.tee.x, 0, first.y - h.tee.z).normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const yaw = Math.atan2(fwd.x, fwd.z);
    const pad = makeTeePad();
    pad.position.set(h.tee.x, 0, h.tee.z).addScaledVector(fwd, 1.0);
    pad.position.y = world.heightAt(pad.position.x, pad.position.z) - 0.03;
    pad.rotation.y = yaw;
    const sign = makeTeeSign(i + 1, h.par, Math.round(h.length));
    sign.position.set(h.tee.x, 0, h.tee.z).addScaledVector(fwd, -0.6).addScaledVector(right, -1.9);
    sign.position.y = world.heightAt(sign.position.x, sign.position.z);
    sign.rotation.y = yaw + Math.PI * 0.85;
    const basket = makeBasket();
    basket.position.set(h.basket.x, h.basket.y, h.basket.z);
    scene.add(pad, sign, basket);
  });

  // One fixed afternoon sun for the whole course. Its shadow map covers the
  // course and is rendered ONCE (bakeShadows): trees, pads, signs and baskets
  // don't move, so there is no per-frame shadow cost. Golfer and disc get blob shadows.
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.8);
  const sunDir = new THREE.Vector3(-0.55, 0.62, 0.56).normalize();
  const courseMid = new THREE.Vector3(world.origin.x + (world.cols * world.cell) / 2, 0, world.origin.y + (world.rows * world.cell) / 2);
  courseMid.y = world.heightAt(courseMid.x, courseMid.z);
  sun.position.copy(courseMid).addScaledVector(sunDir, 300);
  sun.target.position.copy(courseMid);
  sun.castShadow = true;
  sun.shadow.mapSize.set(Q().shadow, Q().shadow);
  const half = (Math.max(world.cols, world.rows) * world.cell) / 2 + 20;
  Object.assign(sun.shadow.camera, { left: -half, bottom: -half, right: half, top: half, near: 50, far: 650 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.08;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);
  renderer.shadowMap.autoUpdate = false;
  camera.far = Q().far;
  camera.updateProjectionMatrix();

  info.textContent = "Planting trees…";
  const [forest, golfer] = await Promise.all([Forest.build(world, renderer, hdr, Q().near), Golfer.load()]);
  if (!params.has("notrees")) scene.add(forest.group);
  scene.add(golfer.root);
  golfer.root.traverse((o) => (o.castShadow = false));
  const golferBlob = makeBlob(0.55);
  const discBlob = makeBlob(0.25);
  scene.add(golferBlob, discBlob);
  discBlob.visible = false;

  /** Render the static shadow map with every tree as its real model, then go back to near/far. */
  function bakeShadows() {
    forest.allNear();
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    forest.update(camera.position, true);
  }

  // Disc, trail, aim preview.
  let disc = makeDisc(DISCS[round.discIdx].color);
  scene.add(disc);
  disc.visible = false;
  const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
  trail.frustumCulled = false;
  const aimLine = new AimLine();
  scene.add(trail, aimLine.group);
  let previewDirty = true;
  /** T: the whole predicted flight instead of its first 40 %. */
  let fullLine = false;

  /** Post chain for the current quality level (ambient occlusion only on high). */
  const makeComposer = () => {
    const q = Q();
    const w = Math.round(W * q.scale);
    const h = Math.round(H * q.scale);
    const c = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: q.msaa }));
    c.setPixelRatio(1);
    c.setSize(w, h);
    c.addPass(new RenderPass(scene, camera));
    if (q.ao) {
      const gtao = new GTAOPass(scene, camera, w, h);
      gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.6, thickness: 1.5, scale: 1.1, samples: 12 });
      gtao.blendIntensity = 0.85;
      c.addPass(gtao);
    }
    c.addPass(new OutputPass());
    return c;
  };
  let composer = makeComposer();
  const watch = new FrameWatch();
  /** Switch quality: resolution, post effects, shadows, camera range and (rebuilt) grass. */
  async function setLevel(i: number, why: string) {
    level = Math.max(0, Math.min(LEVELS.length - 1, i));
    const q = Q();
    renderer.setSize(Math.round(W * q.scale), Math.round(H * q.scale), false);
    composer.dispose();
    composer = makeComposer();
    sun.shadow.mapSize.set(q.shadow, q.shadow);
    sun.shadow.map?.dispose();
    sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    camera.far = q.far;
    camera.updateProjectionMatrix();
    forest.setNearDistance(q.near);
    bakeShadows();
    hud.say(`Graphics: ${q.name}${why}`, 2);
    watch.reset();
  }

  const hud = new Hud(document.body, world.name.replace(/\s*\(.*\)/, ""));
  info.style.display = "none";

  // ---------------------------------------------------------------- camera
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const camWantPos = new THREE.Vector3();
  const camWantLook = new THREE.Vector3();
  function aimCamera(snap: boolean) {
    const lie = tv(round.lie);
    const fwd = tv(yawForward(round.aimYaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const putt = round.technique === "push_putt";
    camWantPos.copy(lie).addScaledVector(fwd, putt ? -3.2 : -4.6).addScaledVector(right, 0.9);
    camWantPos.y = Math.max(camWantPos.y, world.heightAt(camWantPos.x, camWantPos.z)) + (putt ? 1.9 : 2.4);
    camWantLook.copy(lie).addScaledVector(fwd, Math.min(30, round.distToBasket())).setY(lie.y + 0.7);
    if (snap) {
      camPos.copy(camWantPos);
      camLook.copy(camWantLook);
    }
  }

  // ---------------------------------------------------------------- flight
  let flight: { outcome: ThrowOutcome; t: number; from: THREE.Vector3; settle: number } | null = null;
  const discPos = (i: number) => tv(flight!.outcome.result.positions[Math.min(i, flight!.outcome.result.positions.length - 1)]);
  const up = new THREE.Vector3(0, 1, 0);

  function startFlight(outcome: ThrowOutcome) {
    flight = { outcome, t: 0, from: golfer.handPosition(), settle: -1 };
    disc.visible = true;
  }

  function tickFlight(dt: number) {
    if (!flight) return;
    const res = flight.outcome.result;
    const n = res.positions.length;
    const dur = (n - 1) * FRAME_DT;
    if (flight.settle < 0) {
      flight.t = Math.min(dur, flight.t + dt);
      const f = flight.t / FRAME_DT;
      const i = Math.floor(f);
      const p = discPos(i).lerp(discPos(i + 1), f - i);
      // First 0.15 s: blend from the hand into the physics line.
      const blend = Math.min(1, flight.t / 0.15);
      disc.position.copy(flight.from.clone().lerp(p, blend));
      // Blob shadow straight below, fading as the disc climbs.
      const gy = world.heightAt(disc.position.x, disc.position.z);
      const hAbove = disc.position.y - gy;
      discBlob.position.set(disc.position.x, gy + 0.03, disc.position.z);
      (discBlob.material as THREE.MeshBasicMaterial).opacity = 0.55 * Math.max(0, 1 - hAbove / 10);
      discBlob.visible = true;
      const nrm = res.normals[Math.min(i, res.normals.length - 1)];
      disc.quaternion.setFromUnitVectors(up, tv(nrm).normalize());
      const pts = res.positions.slice(0, i + 1).map(tv);
      trail.geometry.setFromPoints(pts);
      // Chase camera: behind the travel direction, above.
      const travel = discPos(i + 3).sub(discPos(Math.max(0, i - 3))).setY(0);
      if (travel.lengthSq() > 1e-4) travel.normalize();
      else travel.copy(tv(yawForward(round.aimYaw)));
      camWantPos.copy(disc.position).addScaledVector(travel, -7).setY(Math.max(disc.position.y, world.heightAt(disc.position.x, disc.position.z)) + 3.2);
      camWantLook.copy(disc.position);
      if (flight.t >= dur) {
        flight.settle = 1.6;
        hud.say(flight.outcome.text, flight.outcome.holed ? 3.5 : 2.4);
      }
    } else {
      flight.settle -= dt;
      if (flight.settle <= 0) {
        flight = null;
        afterFlight();
      }
    }
  }

  /** False while between shots (settle, scorecard, re-dressing a hole): no throws then. */
  let ready = false;

  async function afterFlight() {
    ready = false;
    round.afterSettle();
    trail.geometry.setFromPoints([]);
    discBlob.visible = false;
    disc.visible = false;
    const next = match.next();
    if (next === "turn") {
      readyAtLie();
      return;
    }
    // Hole (or round) over for everyone: scorecard, then the next tee.
    const rows = match.seats.filter((s) => !s.left).map((s) => ({ name: s.name, color: s.color, scores: s.round.scores }));
    const final = next === "round_done";
    await hud.showScorecard(world.holes, rows, final, net && !final ? 8 : 0);
    if (final) {
      net?.close();
      location.reload(); // back to the menu
      return;
    }
    match.nextHole();
    readyAtLie();
  }

  // Everyone else's disc where it lies, with their name over it.
  const markers = new THREE.Group();
  scene.add(markers);
  function updateMarkers() {
    for (const m of [...markers.children]) {
      markers.remove(m);
      m.traverse((o) => ((o as THREE.Mesh).geometry?.dispose()));
    }
    if (match.seats.length < 2) return;
    for (const s of match.seats) {
      if (s === match.current || !match.playing(s)) continue;
      const g = new THREE.Group();
      const d = makeDisc(s.color);
      d.position.set(s.round.lie.x, s.round.lie.y + 0.03, s.round.lie.z);
      const label = nameSprite(s.name, s.color);
      label.position.set(s.round.lie.x, s.round.lie.y + 1.6, s.round.lie.z);
      g.add(d, label);
      markers.add(g);
    }
  }

  function readyAtLie() {
    round = match.current.round;
    golfer.standAt(tv(round.lie), tv(yawForward(round.aimYaw)));
    aimCamera(true);
    previewDirty = true;
    swapDisc();
    updateMarkers();
    ready = true;
    const cur = match.current;
    if (match.seats.length > 1) hud.say(cur.local ? `${cur.name}'s turn` : `${cur.name} is throwing…`, 2);
    playQueued();
  }

  function swapDisc() {
    scene.remove(disc);
    disc = makeDisc(DISCS[round.discIdx].color);
    disc.visible = false;
    scene.add(disc);
  }

  // ---------------------------------------------------------------- throwing
  // A throw has two halves that can finish in either order: the golfer's
  // animation reaching its release frame, and the player's input settling
  // power + release error. The disc launches once both have happened.
  //   Sim    mouse pull + flick (swing.ts); on the X-step, holding the pull
  //          starts the run-up and the flick must land on the plant
  //   Arcade hold Space = power, let go = wind-up starts, Space again in the zone
  let playMode: "sim" | "arcade" = (() => {
    try {
      return localStorage.getItem("dg-mode") === "arcade" ? "arcade" : "sim";
    } catch {
      return "sim";
    }
  })();
  let baseHyzer = 0;
  let throwing = false;
  let pending: { outcome: ThrowOutcome | null; released: boolean } | null = null;
  let meter: Meter | null = null;
  /** Sim run-up: power locked by holding the pull still; the flick then counts its timing. */
  let runup: { meter: Meter; steady: number; last: number } | null = null;

  function tryLaunch() {
    if (pending?.outcome && pending.released && !flight) {
      startFlight(pending.outcome);
      pending = null;
    }
  }

  /** Start the golfer's throw (stance and wind-up); returns seconds until his release frame. */
  function startAnimation(): number {
    ready = false;
    throwing = true;
    const technique = round.isTapIn() ? "push_putt" : round.technique;
    pending = { outcome: null, released: false };
    golfer.throwFrom(technique, tv(round.lie), tv(yawForward(round.aimYaw)), () => {
      if (pending) pending.released = true;
      tryLaunch();
    });
    aimLine.hide();
    return golfer.releaseTime(technique);
  }

  /** Settle the throw: power and release error (deg) -> outcome; the disc goes at the release frame. */
  function settle(power: number, releaseDeg: number, note?: { text: string; good: boolean }) {
    const lat = releaseDeg / spreadDeg(power, round.technique);
    const aim = { yaw: round.aimYaw, tech: round.technique, disc: round.discIdx, hyzer: round.hyzerDeg, line: round.lineDeg };
    const outcome = round.throw(power, lat);
    // Online: everyone else plays back this exact flight.
    if (net) net.send({ t: "throw", id: match.current.id, ...aim, power, deg: releaseDeg, note: note?.text, flight: flightToJson(outcome.result) });
    hud.releasePill(releaseDeg, power, note?.text);
    if (pending) pending.outcome = outcome;
    tryLaunch();
  }

  // ---------------------------------------------------------------- online
  // Other players' throws wait here until this browser is ready for them
  // (still on a scorecard, or the previous flight still landing).
  const queue: Extract<Msg, { t: "throw" }>[] = [];
  function playQueued() {
    const m = queue[0];
    if (!m || !ready || throwing || flight || m.id !== match.current.id) return;
    queue.shift();
    applyAim(m);
    startAnimation();
    const outcome = round.record(flightFromJson(m.flight));
    hud.releasePill(m.deg, m.power, m.note);
    if (pending) pending.outcome = outcome;
    tryLaunch();
  }
  /** Show another player's aim: their yaw, technique, disc, tilt and line. */
  function applyAim(m: { yaw: number; tech: string; disc: number; hyzer: number; line: number }) {
    if (m.tech !== round.technique && (TECHNIQUES as readonly string[]).includes(m.tech)) round.setTechnique(m.tech as Technique, false);
    if (m.disc !== round.discIdx) {
      round.discIdx = m.disc;
      swapDisc();
    }
    round.aimYaw = m.yaw;
    round.hyzerDeg = m.hyzer;
    round.lineDeg = m.line;
    const f = yawForward(round.aimYaw);
    golfer.root.rotation.y = Math.atan2(f.x, f.z);
    aimCamera(false);
    previewDirty = true;
  }
  function onNet(m: Msg) {
    if (m.t === "throw") {
      queue.push(m);
      playQueued();
    } else if (m.t === "aim" && ready && !throwing && m.id === match.current.id && !match.current.local) {
      applyAim(m);
    } else if (m.t === "left") {
      const s = match.seats.find((x) => x.id === m.id);
      if (s) hud.say(`${s.name} left the game`, 3);
      // Their turn, and nobody will throw for them: move on.
      if (match.leave(m.id) && ready && !throwing && !flight) {
        ready = false;
        const next = match.next();
        if (next === "turn") readyAtLie();
        else afterFlightHoleOver(next);
      }
      updateMarkers();
    } else if (m.t === "closed") {
      hud.say("The host left — back to the menu", 4);
      setTimeout(() => location.reload(), 4000);
    }
  }
  /** A hole ended without a flight (the last player still on it left). */
  async function afterFlightHoleOver(next: "hole_done" | "round_done") {
    const rows = match.seats.filter((s) => !s.left).map((s) => ({ name: s.name, color: s.color, scores: s.round.scores }));
    await hud.showScorecard(world.holes, rows, next === "round_done", next === "round_done" ? 0 : 8);
    if (next === "round_done") {
      net?.close();
      location.reload();
      return;
    }
    match.nextHole();
    readyAtLie();
  }
  let aimSent = "";
  let aimSendT = 0;
  /** While you aim online: tell the others ~8 times a second (only when something changed). */
  function sendAim(dt: number) {
    if (!net || !myTurn() || !ready || throwing) return;
    aimSendT -= dt;
    if (aimSendT > 0) return;
    aimSendT = 0.12;
    const m: Msg = { t: "aim", id: match.current.id, yaw: round.aimYaw, tech: round.technique, disc: round.discIdx, hyzer: round.hyzerDeg, line: round.lineDeg };
    const key = JSON.stringify(m);
    if (key === aimSent) return;
    aimSent = key;
    net.send(m);
  }

  /** One-shot throw (Sim flick / easy throw / test hook): animation and outcome together. */
  function beginThrow(power: number, releaseDeg: number) {
    if (round.mode !== "aim" || !ready || throwing || !myTurn()) return;
    startAnimation();
    settle(power, releaseDeg);
  }

  /** Timing error (s) of a run-up or meter tap -> degrees, plus the verdict. */
  function timedRelease(m: Meter, extraDeg = 0) {
    const r = m.result!;
    const tech = round.technique;
    const lat = Math.max(-1.5, Math.min(1.5, timingToLat(r.errS, r.power, tech)));
    const deg = lat * spreadDeg(r.power, tech) + extraDeg;
    // A badly timed run-up costs pace too, not just line.
    const p = tech === "bh_drive" ? r.power * (1 - Math.min(0.15, Math.abs(r.errS) * 0.6)) : r.power;
    settle(p, deg, verdict(r.errS, r.power, tech));
  }

  const swing = new Swing({
    pull: (p, h) => {
      hud.swing = { ...hud.swing, power: p, active: true };
      round.hyzerDeg = baseHyzer + h;
      previewDirty = true;
    },
    thrown: (p, deg) => {
      hud.swing = { x: 0, y: 0, power: 0, active: false };
      if (runup) {
        // X-step: the flick's moment against the plant, plus its direction.
        runup.meter.tap();
        timedRelease(runup.meter, deg);
        runup = null;
        return;
      }
      beginThrow(Math.min(1.05, p), deg);
    },
    cancel: () => {
      hud.swing = { x: 0, y: 0, power: 0, active: false };
      if (runup) {
        // Let go during the run-up without a flick: a ragged, late release.
        runup.meter.tap();
        timedRelease(runup.meter, 0);
        runup = null;
        return;
      }
      round.hyzerDeg = baseHyzer;
      previewDirty = true;
    },
  });
  const canvas = renderer.domElement;
  const toCanvas = (e: PointerEvent) => [e.clientX, e.clientY] as const;
  canvas.addEventListener("pointerdown", (e) => {
    if (meter?.phase === "timing") {
      meter.tap(); // a click also counts as the Arcade timing tap
      return;
    }
    if (playMode !== "sim" || round.mode !== "aim" || throwing || !myTurn()) return;
    baseHyzer = round.hyzerDeg;
    canvas.setPointerCapture(e.pointerId);
    swing.down(...toCanvas(e));
    runup = null;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (swing.phase === "idle") return;
    swing.move(...toCanvas(e));
    hud.swing = { ...hud.swing, x: swing.dot.x, y: swing.dot.y };
  });
  canvas.addEventListener("pointerup", (e) => swing.up(...toCanvas(e)));

  function setMode(m: "sim" | "arcade") {
    playMode = m;
    try {
      localStorage.setItem("dg-mode", m);
    } catch {
      /* private mode */
    }
    hud.setMode(m);
    hud.say(m === "sim" ? "Sim: mouse swing" : "Arcade: keyboard meter", 1.8);
  }

  const keys = new Set<string>();
  addEventListener("keydown", (e) => {
    keys.add(e.key);
    if (e.key === " ") e.preventDefault();
    // Arcade timing tap (works while the wind-up runs).
    if (e.key === " " && !e.repeat && meter?.phase === "timing") {
      meter.tap();
      return;
    }
    if (!started || round.mode !== "aim" || throwing || e.repeat) return;
    const k = e.key.toLowerCase();
    // Settings work any time; everything else only on your own turn.
    if (k === "g") return setLevel((level + 1) % LEVELS.length, "");
    if (k === "m") return setMode(playMode === "sim" ? "arcade" : "sim");
    if (k === "t") {
      fullLine = !fullLine;
      previewDirty = true;
      return;
    }
    if (!myTurn()) return;
    if (e.key === "[" || e.key === "]") {
      round.selectDisc(round.discIdx + (e.key === "]" ? 1 : -1));
      swapDisc();
      previewDirty = true;
    } else if (k === "f") {
      const i = TECHNIQUES.indexOf(round.technique);
      round.setTechnique(TECHNIQUES[(i + 1) % TECHNIQUES.length]);
      aimCamera(false);
      previewDirty = true;
    } else if (k === "g") {
      setLevel((level + 1) % LEVELS.length, "");
    } else if (k === "m") {
      setMode(playMode === "sim" ? "arcade" : "sim");
    } else if (k === "t") {
      fullLine = !fullLine;
      previewDirty = true;
    } else if (e.key === " ") {
      if (!ready) return;
      if (round.isTapIn()) {
        beginThrow(0.2, 0);
      } else if (playMode === "arcade") {
        meter = new Meter(round.technique);
        meter.start();
      } else {
        // Sim's easy throw: the suggested power, an ordinary human release.
        const g = (Math.random() + Math.random() + Math.random() - 1.5) * 0.9;
        beginThrow(round.power, g * spreadDeg(round.power, round.technique) * 0.5);
      }
    }
  });
  addEventListener("keyup", (e) => {
    keys.delete(e.key);
    // Arcade: letting go locks the power and starts the wind-up; the tap comes next.
    if (e.key === " " && meter?.phase === "charge") {
      if (!meter.letGo(0)) {
        meter = null;
        return;
      }
      meter.releaseIn = startAnimation();
    }
  });

  /** Per frame while aiming / throwing: aim keys, meters and the run-up. */
  function tickInput(dt: number) {
    if (meter) {
      meter.tick(dt);
      if (meter.result) {
        timedRelease(meter);
        meter = null;
      }
    }
    if (runup) {
      runup.meter.tick(dt);
      // Never flicked: the meter called it late on its own; throw it like that.
      if (runup.meter.result) {
        timedRelease(runup.meter, 0);
        runup = null;
      }
    }
    // Sim X-step: holding the pull still for 0.35 s locks power and starts the run-up.
    if (playMode === "sim" && swing.phase === "pull" && !runup && round.technique === "bh_drive" && ready) {
      const p = hud.swing.power;
      if (p > 0.15 && Math.abs(p - (simHold.last ?? 0)) < 0.004) simHold.steady += dt;
      else simHold.steady = 0;
      simHold.last = p;
      if (simHold.steady >= 0.35) {
        const m = new Meter("bh_drive");
        m.start();
        m.charge = p;
        m.letGo(0);
        m.releaseIn = startAnimation();
        runup = { meter: m, steady: 0, last: p };
        simHold.steady = 0;
      }
    }
    hud.meter = meter ?? runup?.meter ?? null;
  }
  const simHold: { steady: number; last: number | null } = { steady: 0, last: null };

  // ---------------------------------------------------------------- loop
  round.startHole(0);
  if (started) readyAtLie();
  else golfer.standAt(tv(round.lie), tv(yawForward(round.aimYaw)));
  aimCamera(true);
  hud.setMode(playMode);
  camera.position.copy(camPos);
  bakeShadows();

  const clock = new THREE.Timer();
  let t = 0;
  let previewT = 0;
  function frame(dt: number) {
    t += dt;
    grassTime.value = t;
    tickInput(dt);
    sendAim(dt);
    if (round.mode === "aim" && !throwing && myTurn()) {
      // Shift = fine. ←/→ (A/D) aim, W/S release angle (line), Z/X disc tilt (hyzer / anhyzer).
      const fine = keys.has("Shift") ? 0.25 : 1;
      const has = (...ks: string[]) => ks.some((k) => keys.has(k));
      const turn = (has("ArrowLeft", "a", "A") ? -1 : 0) + (has("ArrowRight", "d", "D") ? 1 : 0);
      const line = (has("w", "W") ? 1 : 0) - (has("s", "S") ? 1 : 0);
      const tilt = (has("z", "Z") ? 1 : 0) - (has("x", "X") ? 1 : 0);
      if (turn) {
        round.aimYaw += turn * 0.6 * fine * dt;
        const f = yawForward(round.aimYaw);
        golfer.root.rotation.y = Math.atan2(f.x, f.z);
        aimCamera(false);
        previewDirty = true;
      }
      if (line) {
        round.lineDeg = Math.max(-5, Math.min(35, round.lineDeg + line * 10 * fine * dt));
        previewDirty = true;
      }
      if (tilt) {
        round.hyzerDeg = Math.max(-60, Math.min(60, round.hyzerDeg + tilt * 25 * fine * dt));
        previewDirty = true;
      }
    }
    if (round.mode === "aim" && !throwing) {
      previewT -= dt;
      if (previewDirty && previewT <= 0) {
        previewDirty = false;
        previewT = 0.08;
        if (round.isTapIn()) aimLine.hide();
        else {
          const power = swing.phase !== "idle" ? Math.max(0.05, hud.swing.power) : meter?.phase === "charge" ? Math.max(0.05, meter.charge) : round.power;
          const p = round.preview(power);
          aimLine.update(world, p, fullLine ? 1 : ASSIST.preview, spreadDeg(power, round.technique));
        }
      }
      if (meter?.phase === "charge") previewDirty = true; // the line follows the filling bar
    }
    golfer.update(dt);
    const hips = golfer.hipsPosition();
    golferBlob.position.set(hips.x, world.heightAt(hips.x, hips.z) + 0.03, hips.z);
    // Keep the view clear: trees between the camera and what it follows are left out.
    forest.focus = flight && disc.visible ? disc.position : hips;
    forest.update(camera.position);
    if (throwing && flight) throwing = false;
    tickFlight(dt);
    camPos.lerp(camWantPos, 1 - Math.exp(-dt * 4));
    camLook.lerp(camWantLook, 1 - Math.exp(-dt * 5));
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    if (!params.has("nohud")) {
      const cur = match.current;
      const others = match.seats.length > 1 ? match.standings().filter((x) => x.seat !== cur).map((x) => ({ name: x.seat.name, color: x.seat.color, text: `${x.toPar === 0 ? "E" : x.toPar > 0 ? `+${x.toPar}` : x.toPar}${match.playing(x.seat) ? ` · ${x.seat.round.strokes}` : " ✓"}` })) : [];
      hud.update(round, round.aimYaw, { name: match.seats.length > 1 ? cur.name : "YOU", color: cur.color }, others);
    }
    composer.render(dt);
    // Too slow for two and a half seconds running: drop a quality level (not in tests).
    if (started && !params.has("q") && !params.has("perf") && !params.has("autoplay") && level > 0 && watch.tooSlow(dt)) setLevel(level - 1, " (auto)");
  }
  function loop() {
    clock.update();
    frame(Math.min(clock.getDelta(), 0.1));
    requestAnimationFrame(loop);
  }
  loop();

  // Dev / test hooks: game.throw(power, deg), game.state(); ?autoplay=1 throws by itself.
  const capture = async (name: string) => {
    const blob = await new Promise<Blob>((res) => renderer.domElement.toBlob((b) => res(b!), "image/png"));
    await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: "POST", body: blob });
  };
  Object.assign(window, {
    game: {
      get round() {
        return round;
      },
      forest,
      golfer,
      renderer,
      hud,
      throw: (p = round.power, deg = 0) => beginThrow(p, deg),
      state: () => ({ mode: round.mode, ready, inFlight: !!flight, hole: round.holeIdx + 1, strokes: round.strokes, scores: [...round.scores], toBasket: round.distToBasket() }),
      step: (dt = 1 / 60) => frame(dt),
      /** Test hook: play the next shot from (x, z). */
      placeLie: (x: number, z: number) => {
        round.lie = new V3(x, world.heightAt(x, z), z);
        round.setupLie(false);
        readyAtLie();
      },
      capture,
    },
  });
  // The menu: the course shows behind it while you pick a game.
  if (menu && choice) {
    menu.setReady();
    const ch = await choice;
    menu.close();
    if (ch.mode !== playMode) setMode(ch.mode);
    const qi = LEVELS.findIndex((q) => q.name === ch.quality);
    if (qi >= 0 && qi !== level) await setLevel(qi, "");
    match = new Match(world, ch.players);
    round = match.current.round;
    net = ch.net;
    net?.on(onNet);
    // Leaving the page closes the room for the others (or leaves it).
    addEventListener("pagehide", () => net?.close());
    started = true;
    readyAtLie();
  }
  if (params.get("autoplay")) autoplay(params.get("autoplay")!, capture, frame);
  if (params.get("perf")) perfProbe(params.get("perf")!, renderer, () => ({ resorts: forest.resorts, lineBuilds: aimLine.rebuilds }));
  // ?release=<prefix>&tech=<id>: throw that technique from the first tee and
  // capture the frame the disc leaves the hand (checks the golfer faces the line).
  if (params.get("release")) {
    const prefix = params.get("release")!;
    const tech = (params.get("tech") ?? "bh_drive") as (typeof TECHNIQUES)[number];
    for (let i = 0; i < 30; i++) frame(1 / 30);
    round.setTechnique(tech);
    beginThrow(round.power, 0);
    for (let i = 0; i < 600 && !flight; i++) frame(1 / 60);
    frame(1 / 60);
    await capture(`${prefix}_${tech}`);
    await fetch(`/__shot?name=${encodeURIComponent(prefix)}_done`, { method: "POST", body: "" });
  }
}

/** ?perf=<name>: record real frame times for 6 s, post shots/<name>.png as JSON (GPU, avg, p95, triangles). */
async function perfProbe(name: string, renderer: THREE.WebGLRenderer, counts: () => Record<string, number>) {
  await new Promise((r) => setTimeout(r, 3000)); // let shaders compile
  const c0 = counts();
  const gl = renderer.getContext();
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
  const times: number[] = [];
  let last = performance.now();
  await new Promise<void>((done) => {
    const f = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      if (times.length < 360 && now - (times.length ? 0 : 0) < 1e12) requestAnimationFrame(f);
      else done();
    };
    requestAnimationFrame(f);
    setTimeout(done, 8000);
  });
  const c1 = counts();
  times.shift();
  const sorted = [...times].sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const body = JSON.stringify({ gpu, frames: times.length, avgMs: +avg.toFixed(1), p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1), maxMs: +sorted[sorted.length - 1].toFixed(0), over100: times.filter((x) => x > 100).length, slowAt: times.map((x, i) => (x > 100 ? `${i}:${Math.round(x)}` : "")).filter(Boolean).join(" "), triangles: renderer.info.render.triangles, calls: renderer.info.render.calls, counts: Object.fromEntries(Object.entries(c1).map(([k, v]) => [k, v - (c0[k] ?? 0)])) });
  await fetch(`/__shot?name=${encodeURIComponent(name)}`, { method: "POST", body });
  await fetch(`/__shot?name=${encodeURIComponent(name)}_done`, { method: "POST", body: "" });
}

/**
 * ?autoplay=<prefix> plays the round on its own with a fixed time step (for
 * headless checks), capturing a few moments into shots/<prefix>_*.png and
 * posting <prefix>_done when the round is over or after `?holes=N` holes.
 */
async function autoplay(prefix: string, capture: (n: string) => Promise<void>, frame: (dt: number) => void) {
  const g = (window as unknown as { game: { round: Round; throw: (p?: number, d?: number) => void; state: () => { ready: boolean } } }).game;
  const r = g.round;
  const holes = Number(params.get("holes") ?? 9);
  let shots = 0;
  let lastHole = -1;
  let tick = 0;
  const step = async (n: number) => {
    for (let i = 0; i < n; i++) frame(1 / 30);
    if (++tick % 4 === 0) await new Promise((res) => setTimeout(res, 0));
  };
  for (let guard = 0; guard < 30000; guard++) {
    await step(1);
    const overlay = document.querySelector(".hud-overlay.show");
    if (overlay) {
      if (r.scores.length <= 2 || r.scores.length === 9) await capture(`${prefix}_card${r.scores.length}`);
      if (r.scores.length >= holes) break;
      dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      continue;
    }
    if (r.mode === "aim" && g.state().ready) {
      await step(20);
      if (r.holeIdx !== lastHole) {
        lastHole = r.holeIdx;
        if (r.holeIdx < 2) await capture(`${prefix}_h${r.holeIdx + 1}_tee`);
      }
      const throwNo = r.strokes;
      g.throw(r.power, (Math.random() - 0.5) * 1.5);
      // Capture the first throws mid-flight.
      for (let k = 0; k < 400 && (r.mode as string) === "flight"; k++) {
        await step(1);
        if (shots < 4 && k === 45) {
          await capture(`${prefix}_h${r.holeIdx + 1}_t${throwNo + 1}_flight`);
          shots++;
        }
      }
    }
  }
  const summary = JSON.stringify({ scores: r.scores, total: r.total, par: r.world.holes.slice(0, r.scores.length).reduce((s, h) => s + h.par, 0) });
  await fetch(`/__shot?name=${encodeURIComponent(prefix)}_summary`, { method: "POST", body: summary });
  await fetch(`/__shot?name=${encodeURIComponent(prefix)}_done`, { method: "POST", body: "" });
}

main().catch((e) => {
  info.textContent = `Error: ${e instanceof Error ? e.message : e}`;
  console.error(e);
});
