// The AI golfer in play: idle at the lie, a throw clip per technique, and
// the moment the disc leaves his hand.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mixamoRig, retargetByDirection } from "../look/retarget";

const HAND = "mixamorigRightHand";
/** Per-technique release moment (s) and turn (deg) where the automatic measure is wrong. */
const HAND_FIXES: Record<string, { release: number; yawDeg: number }> = {
  bh_stand: { release: 1.4, yawDeg: 0 },
  bh_drive: { release: 1.1, yawDeg: 95 },
};
const HIPS = "mixamorigHips";

interface ThrowClip {
  clip: THREE.AnimationClip;
  /** Seconds into the clip when the disc leaves the hand. */
  release: number;
  /** Hips offset from the clip's start at release, in the golfer's own space (to place him). */
  hipsAtRelease: THREE.Vector3;
  /** Extra yaw so the hand's release direction points forward. */
  yawFix: number;
}

export class Golfer {
  root!: THREE.Group;
  private mixer!: THREE.AnimationMixer;
  private idle!: THREE.AnimationAction;
  private clips = new Map<string, ThrowClip>();
  private current: THREE.AnimationAction | null = null;
  private releaseAt = -1;
  private onRelease: (() => void) | null = null;
  private t = 0;
  private hand!: THREE.Object3D;

  static async load(): Promise<Golfer> {
    const g = new Golfer();
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync("art/golfer/golfer_rigged.glb");
    g.root = gltf.scene as unknown as THREE.Group;
    g.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.roughness = 0.75;
      mat.metalness = 0;
    });
    g.hand = g.root.getObjectByName(HAND)!;
    g.mixer = new THREE.AnimationMixer(g.root);
    const byName = (n: string) => gltf.animations.find((a) => a.name === n)!;
    g.idle = g.mixer.clipAction(byName("Idle"));
    g.idle.play();
    // Backhand standstill = Mixamo's own Frisbee Throw on this rig; the rest are retargeted.
    // The approved throws carry their release moment (fraction of the clip) from the mocap work.
    type Src = [string, Promise<{ clip: THREE.AnimationClip; release?: number }>];
    const sources: Src[] = [
      ["bh_stand", Promise.resolve({ clip: byName("FrisbeeThrow") })],
      ...(["bh_drive", "fh", "push_putt"] as const).map((id): Src => [
        id,
        Promise.all([
          loader.loadAsync(`art/golfer/throws/${id}.glb`),
          fetch(`art/golfer/throws/${id}.timing.json`).then((r) => r.json() as Promise<{ release: number }>),
        ]).then(([src, timing]) => ({ clip: retargetByDirection(src.scene, src.animations[0], g.root, mixamoRig(), 60), release: timing.release })),
      ]),
    ];
    for (const [id, p] of sources) {
      const { clip, release } = await p;
      const tc = g.measure(clip, release);
      // Measured by hand (hand path + hip travel, 2026-11-24) where the automatic guess is off:
      //   Frisbee Throw: the hand peaks mid pull-through on his left; release is at full
      //     extension in front, and that already points forward.
      //   X-step: the clip's whole throw runs ~95° to the side (hips and hand agree).
      const fix = HAND_FIXES[id];
      if (fix) {
        tc.release = fix.release;
        tc.yawFix = (fix.yawDeg * Math.PI) / 180;
        tc.hipsAtRelease = g.hipsOffsetAt(clip, fix.release).applyAxisAngle(new THREE.Vector3(0, 1, 0), tc.yawFix);
      }
      g.clips.set(id, tc);
    }
    g.mixer.stopAllAction();
    g.idle.reset().play();
    return g;
  }

  /**
   * Release = the clip's known release fraction, or else the fastest moment of
   * the throwing hand; also where the hips are then and which way the hand moves.
   */
  private measure(clip: THREE.AnimationClip, releaseFrac?: number): ThrowClip {
    const mixer = new THREE.AnimationMixer(this.root);
    const a = mixer.clipAction(clip);
    a.play();
    const hips = this.root.getObjectByName(HIPS)!;
    const at = (t: number) => {
      mixer.setTime(t);
      this.root.updateMatrixWorld(true);
      return { hand: this.hand.getWorldPosition(new THREE.Vector3()), hips: hips.getWorldPosition(new THREE.Vector3()) };
    };
    const start = at(0).hips;
    let best = 0;
    let bestT = clip.duration * 0.6;
    const dt = 1 / 60;
    // With a recorded release, look for the hand's peak just around it (the
    // recorded moment sits a little after the true peak); else over the whole clip.
    const from = releaseFrac !== undefined ? Math.max(dt, (releaseFrac - 0.12) * clip.duration) : dt;
    const to = releaseFrac !== undefined ? Math.min(clip.duration * 0.95, (releaseFrac + 0.05) * clip.duration) : clip.duration * 0.95;
    let prev = at(from - dt).hand;
    for (let t = from; t < to; t += dt) {
      const h = at(t).hand;
      const v = h.distanceTo(prev) / dt;
      if (v > best) {
        best = v;
        bestT = t;
      }
      prev = h;
    }
    // Which way the hand moves at release, in the golfer's own space; the throw
    // is turned so that this points at the target (clips face all sorts of ways).
    const dir = at(Math.min(clip.duration, bestT + dt)).hand.sub(at(Math.max(0, bestT - dt)).hand).setY(0);
    const yawFix = dir.lengthSq() > 1e-8 ? -Math.atan2(dir.x, dir.z) : 0;
    const hipsAtRelease = at(bestT).hips.sub(start).setY(0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yawFix);
    a.stop();
    mixer.uncacheRoot(this.root);
    this.facing[clip.name] = Math.round((-yawFix * 180) / Math.PI);
    return { clip, release: bestT, hipsAtRelease, yawFix };
  }

  /** Hips offset from the clip's start at time t (golfer space, horizontal). */
  hipsOffsetAt(clip: THREE.AnimationClip, t: number): THREE.Vector3 {
    const mixer = new THREE.AnimationMixer(this.root);
    const a = mixer.clipAction(clip);
    a.play();
    const hips = this.root.getObjectByName(HIPS)!;
    const keepR = this.root.rotation.y;
    const keepP = this.root.position.clone();
    this.root.rotation.y = 0;
    this.root.position.set(0, 0, 0);
    const at = (x: number) => {
      mixer.setTime(x);
      this.root.updateMatrixWorld(true);
      return hips.getWorldPosition(new THREE.Vector3());
    };
    const off = at(t).sub(at(0)).setY(0);
    a.stop();
    mixer.uncacheRoot(this.root);
    this.root.rotation.y = keepR;
    this.root.position.copy(keepP);
    return off;
  }

  /** Measured hand direction at release per clip, in degrees off forward (for checks). */
  facing: Record<string, number> = {};

  /** Stand at the lie facing along `fwd` (world), idling. */
  standAt(lie: THREE.Vector3, fwd: THREE.Vector3) {
    this.root.position.copy(lie);
    this.root.rotation.set(0, Math.atan2(fwd.x, fwd.z), 0);
    if (this.current) {
      this.current.fadeOut(0.25);
      this.current = null;
    }
    this.idle.reset().fadeIn(0.25).play();
  }

  /**
   * Play the technique's throw so that the release happens over the lie,
   * then call `release` at the release moment.
   */
  throwFrom(technique: string, lie: THREE.Vector3, fwd: THREE.Vector3, release: () => void) {
    const tc = this.clips.get(technique) ?? this.clips.get("bh_stand")!;
    const yaw = Math.atan2(fwd.x, fwd.z) + tc.yawFix;
    this.root.rotation.set(0, yaw, 0);
    const offset = tc.hipsAtRelease.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.root.position.copy(lie).sub(offset);
    this.idle.fadeOut(0.15);
    const a = this.mixer.clipAction(tc.clip);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.fadeIn(0.15).play();
    this.current = a;
    this.t = 0;
    this.releaseAt = tc.release;
    this.onRelease = release;
  }

  /** Seconds from the start of this technique's throw to the disc leaving his hand. */
  releaseTime(technique: string): number {
    return (this.clips.get(technique) ?? this.clips.get("bh_stand")!).release;
  }

  /** Hips in world space (where his blob shadow goes). */
  hipsPosition(): THREE.Vector3 {
    return this.root.getObjectByName(HIPS)!.getWorldPosition(new THREE.Vector3());
  }

  /** The throwing hand in world space (the disc starts here). */
  handPosition(): THREE.Vector3 {
    return this.hand.getWorldPosition(new THREE.Vector3());
  }

  update(dt: number) {
    this.mixer.update(dt);
    if (this.onRelease && this.current) {
      this.t += dt;
      if (this.t >= this.releaseAt) {
        const cb = this.onRelease;
        this.onRelease = null;
        cb();
      }
    }
  }
}
