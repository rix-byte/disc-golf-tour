// Bake an animation from one skeleton onto another with different bone names
// and rest orientations. Each mapped bone gets the same world-space rotation
// change from its rest pose as its source bone; unmapped bones keep their
// rest pose. Hip height scales with the size difference.

import * as THREE from "three";

export type BoneMap = Record<string, string>; // target bone -> source bone

const sanitize = (n: string) => THREE.PropertyBinding.sanitizeNodeName(n);

function bones(root: THREE.Object3D): Map<string, THREE.Bone> {
  const out = new Map<string, THREE.Bone>();
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) out.set(o.name, o as THREE.Bone);
  });
  return out;
}

function worldQuats(list: Map<string, THREE.Bone>): Map<string, THREE.Quaternion> {
  const out = new Map<string, THREE.Quaternion>();
  for (const [name, b] of list) out.set(name, b.getWorldQuaternion(new THREE.Quaternion()));
  return out;
}

export function retargetClip(
  src: THREE.Object3D,
  clip: THREE.AnimationClip,
  tgt: THREE.Object3D,
  map: BoneMap,
  opts: { srcHips: string; tgtHips: string; fps?: number; restClip?: THREE.AnimationClip },
): THREE.AnimationClip {
  const fps = opts.fps ?? 30;
  const sb = bones(src);
  const tb = bones(tgt);
  const m: [THREE.Bone, THREE.Bone][] = [];
  for (const [t, s] of Object.entries(map)) {
    const tBone = tb.get(sanitize(t)) ?? tb.get(t);
    const sBone = sb.get(sanitize(s)) ?? sb.get(s);
    if (tBone && sBone) m.push([tBone, sBone]);
  }
  const srcOf = new Map(m.map(([t, s]) => [t, s]));
  src.updateMatrixWorld(true);
  tgt.updateMatrixWorld(true);

  // Rest poses. The source rest can come from a clip (e.g. its T-pose clip)
  // when its bind pose doesn't match the target's bind pose.
  const mixer = new THREE.AnimationMixer(src);
  if (opts.restClip) {
    const a = mixer.clipAction(opts.restClip);
    a.play();
    mixer.setTime(0);
    src.updateMatrixWorld(true);
  }
  const srcRest = worldQuats(sb);
  const srcHipsBone = sb.get(sanitize(opts.srcHips))!;
  const tgtHipsBone = tb.get(sanitize(opts.tgtHips))!;
  const srcHipsRest = srcHipsBone.getWorldPosition(new THREE.Vector3());
  mixer.stopAllAction();
  const tgtRestWorld = worldQuats(tb);
  const tgtRestLocal = new Map([...tb].map(([n, b]) => [n, b.quaternion.clone()]));
  const tgtHipsRestLocal = tgtHipsBone.position.clone();
  const tgtHipsRestWorld = tgtHipsBone.getWorldPosition(new THREE.Vector3());
  const scale = tgtHipsRestWorld.y / Math.max(1e-3, srcHipsRest.y);

  // Parents first.
  const order: THREE.Bone[] = [];
  tgt.traverse((o) => {
    if ((o as THREE.Bone).isBone) order.push(o as THREE.Bone);
  });

  const action = mixer.clipAction(clip);
  action.play();
  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(frames);
  const values = new Map<THREE.Bone, Float32Array>(order.map((b) => [b, new Float32Array(frames * 4)]));
  const hipPos = new Float32Array(frames * 3);
  const world = new Map<THREE.Bone, THREE.Quaternion>();
  const tmp = new THREE.Quaternion();
  const inv = new THREE.Quaternion();
  const parentWorld = (b: THREE.Bone) => {
    const p = b.parent as THREE.Bone;
    return world.get(p) ?? p.getWorldQuaternion(new THREE.Quaternion());
  };
  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / fps);
    times[f] = t;
    mixer.setTime(t);
    src.updateMatrixWorld(true);
    world.clear();
    for (const b of order) {
      const s = srcOf.get(b);
      let w: THREE.Quaternion;
      if (s) {
        // W_t = W_s * inverse(W_s,rest) * W_t,rest
        w = s.getWorldQuaternion(new THREE.Quaternion());
        inv.copy(srcRest.get(s.name)!).invert();
        w.multiply(inv).multiply(tgtRestWorld.get(b.name)!);
      } else {
        w = parentWorld(b).clone().multiply(tgtRestLocal.get(b.name)!);
      }
      world.set(b, w);
      tmp.copy(parentWorld(b)).invert().multiply(w);
      values.get(b)!.set([tmp.x, tmp.y, tmp.z, tmp.w], f * 4);
    }
    // Hips travel: world offset from rest, scaled, into the hips' parent space.
    const d = srcHipsBone.getWorldPosition(new THREE.Vector3()).sub(srcHipsRest).multiplyScalar(scale);
    const parent = tgtHipsBone.parent!;
    const pInv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
    const p = tgtHipsRestWorld.clone().add(d).applyMatrix4(pInv);
    if (!Number.isFinite(p.x)) p.copy(tgtHipsRestLocal);
    hipPos.set([p.x, p.y, p.z], f * 3);
  }
  mixer.stopAllAction();
  const tracks: THREE.KeyframeTrack[] = order.map((b) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values.get(b)!));
  tracks.push(new THREE.VectorKeyframeTrack(`${tgtHipsBone.name}.position`, times, hipPos));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Rest-pose independent retarget for skeletons with the same bone names
 * (e.g. Mixamo -> Mixamo): every frame, each target bone is turned so it
 * points where the source bone points (bone -> aim child), with its roll set
 * by a side vector where one exists (hips: thigh to thigh, spine: shoulder to
 * shoulder). Needed when the source files were saved with arbitrary poses as
 * their rest, which breaks the rest-delta method above.
 */
export function retargetByDirection(
  src: THREE.Object3D,
  clip: THREE.AnimationClip,
  tgt: THREE.Object3D,
  rig: { hips: string; aim: Record<string, string>; side: Record<string, [string, string]>; legs: [string, string, string] },
  fps = 60,
): THREE.AnimationClip {
  const sb = bones(src);
  const tb = bones(tgt);
  const S = (n: string) => sb.get(sanitize(n));
  const T = (n: string) => tb.get(sanitize(n));
  src.updateMatrixWorld(true);
  tgt.updateMatrixWorld(true);

  const order: THREE.Bone[] = [];
  tgt.traverse((o) => {
    if ((o as THREE.Bone).isBone) order.push(o as THREE.Bone);
  });
  const restLocalQ = new Map(order.map((b) => [b, b.quaternion.clone()]));
  const restLocalP = new Map(order.map((b) => [b, b.position.clone()]));
  const hipsT = T(rig.hips)!;
  const hipsS = S(rig.hips)!;

  // Leg length ratio scales the hips' travel (rest poses can't be trusted for heights).
  const legLen = (get: (n: string) => THREE.Bone | undefined) => {
    const [a, b, c] = rig.legs.map((n) => get(n)!.getWorldPosition(new THREE.Vector3()));
    return a.distanceTo(b) + b.distanceTo(c);
  };
  const ratio = legLen(T) / legLen(S);
  const hipsTRest = hipsT.getWorldPosition(new THREE.Vector3());
  const feet = ["mixamorig:LeftToeBase", "mixamorig:RightToeBase", "mixamorig:LeftFoot", "mixamorig:RightFoot"];
  const groundT = Math.min(...feet.map((n) => T(n)?.getWorldPosition(new THREE.Vector3()).y ?? Infinity)) - 0.03;

  const mixer = new THREE.AnimationMixer(src);
  mixer.clipAction(clip).play();

  // Face the throw along +Z (the target's forward): by the hips' travel over
  // the clip, or, when it barely travels (putts), by where the hips face at the start.
  const hipsAt = (t: number) => {
    mixer.setTime(t);
    src.updateMatrixWorld(true);
    return hipsS.getWorldPosition(new THREE.Vector3());
  };
  const travel = hipsAt(clip.duration).sub(hipsAt(0)).setY(0);
  let dir = travel;
  if (travel.length() < 0.15) {
    const side = S("mixamorig:RightUpLeg")!.getWorldPosition(new THREE.Vector3()).sub(S("mixamorig:LeftUpLeg")!.getWorldPosition(new THREE.Vector3()));
    dir = new THREE.Vector3(0, 1, 0).cross(side).setY(0);
  }
  src.rotation.y -= Math.atan2(dir.x, dir.z);
  mixer.setTime(0);
  src.updateMatrixWorld(true);
  const hipsS0 = hipsS.getWorldPosition(new THREE.Vector3());
  // Ground under the source at frame 0 = lowest foot point; keeps the target's feet on its own ground.
  const footS0 = Math.min(...feet.map((n) => S(n)?.getWorldPosition(new THREE.Vector3()).y ?? Infinity)) - 0.03;

  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(frames);
  const values = new Map(order.map((b) => [b, new Float32Array(frames * 4)]));
  const hipPos = new Float32Array(frames * 3);
  const world = new Map<THREE.Bone, THREE.Quaternion>();
  const sp = (n: string) => S(n)!.getWorldPosition(new THREE.Vector3());
  const basis = (primary: THREE.Vector3, side: THREE.Vector3 | null) => {
    const y = primary.clone().normalize();
    if (!side) return null;
    const x = side.clone().sub(y.clone().multiplyScalar(side.dot(y))).normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  };

  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / fps);
    times[f] = t;
    mixer.setTime(t);
    src.updateMatrixWorld(true);
    world.clear();
    for (const b of order) {
      const parent = b.parent as THREE.Bone;
      const pq = world.get(parent) ?? parent.getWorldQuaternion(new THREE.Quaternion());
      let w = pq.clone().multiply(restLocalQ.get(b)!);
      const aim = rig.aim[b.name] ?? rig.aim[b.name.replace(/^mixamorig/, "mixamorig:")];
      const childT = aim ? T(aim) : undefined;
      if (aim && childT && S(b.name) && S(aim)) {
        // Where the bone points now (rest local offset of its aim child) vs where the source points.
        const cur = restLocalP.get(childT)!.clone().applyQuaternion(w);
        const want = sp(aim).sub(sp(b.name));
        const sideNames = rig.side[b.name] ?? rig.side[b.name.replace(/^mixamorig/, "mixamorig:")];
        let rot: THREE.Quaternion;
        if (sideNames && T(sideNames[0]) && T(sideNames[1])) {
          // Full orientation from two vectors: aim + side, measured the same way on both skeletons.
          // Side bones (thighs, shoulders) are children of b, so their rest offsets turn with w.
          const curSide = restLocalP.get(T(sideNames[1])!)!.clone().sub(restLocalP.get(T(sideNames[0])!)!);
          curSide.applyQuaternion(w);
          const wantSide = sp(sideNames[1]).sub(sp(sideNames[0]));
          const bc = basis(cur, curSide)!;
          const bw = basis(want, wantSide)!;
          rot = bw.multiply(bc.invert());
        } else {
          rot = new THREE.Quaternion().setFromUnitVectors(cur.normalize(), want.normalize());
        }
        w = rot.multiply(w);
      }
      world.set(b, w);
      const local = pq.clone().invert().multiply(w);
      values.get(b)!.set([local.x, local.y, local.z, local.w], f * 4);
    }
    // Hips: horizontal travel from frame 0, height above the source's ground, both scaled by leg length.
    const now = sp(rig.hips);
    const hipsWorld = new THREE.Vector3(
      hipsTRest.x + (now.x - hipsS0.x) * ratio,
      groundT + (now.y - footS0) * ratio,
      hipsTRest.z + (now.z - hipsS0.z) * ratio,
    );
    const local = hipsWorld.applyMatrix4(new THREE.Matrix4().copy(hipsT.parent!.matrixWorld).invert());
    hipPos.set([local.x, local.y, local.z], f * 3);
  }
  mixer.stopAllAction();
  const tracks: THREE.KeyframeTrack[] = order.map((b) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values.get(b)!));
  tracks.push(new THREE.VectorKeyframeTrack(`${hipsT.name}.position`, times, hipPos));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/** Aim children and side vectors for a Mixamo skeleton (no fingers needed). */
export function mixamoRig() {
  const m = (n: string) => `mixamorig:${n}`;
  const aim: Record<string, string> = {
    [m("Hips")]: m("Spine"),
    [m("Spine")]: m("Spine1"),
    [m("Spine1")]: m("Spine2"),
    [m("Spine2")]: m("Neck"),
    [m("Neck")]: m("Head"),
    [m("Head")]: m("HeadTop_End"),
  };
  for (const s of ["Left", "Right"]) {
    Object.assign(aim, {
      [m(`${s}Shoulder`)]: m(`${s}Arm`),
      [m(`${s}Arm`)]: m(`${s}ForeArm`),
      [m(`${s}ForeArm`)]: m(`${s}Hand`),
      [m(`${s}UpLeg`)]: m(`${s}Leg`),
      [m(`${s}Leg`)]: m(`${s}Foot`),
      [m(`${s}Foot`)]: m(`${s}ToeBase`),
    });
  }
  const side: Record<string, [string, string]> = {
    [m("Hips")]: [m("LeftUpLeg"), m("RightUpLeg")],
    [m("Spine2")]: [m("LeftShoulder"), m("RightShoulder")],
  };
  return { hips: m("Hips"), aim, side, legs: [m("LeftUpLeg"), m("LeftLeg"), m("LeftFoot")] as [string, string, string] };
}

/** Universal Animation Library (Godot/Rigify names) -> Unreal mannequin names. */
export function ualToUnreal(): BoneMap {
  const map: BoneMap = {
    pelvis: "DEF-hips",
    spine_01: "DEF-spine.001",
    spine_02: "DEF-spine.002",
    spine_03: "DEF-spine.003",
    neck_01: "DEF-neck",
    Head: "DEF-head",
  };
  for (const [s, S] of [["l", "L"], ["r", "R"]]) {
    Object.assign(map, {
      [`clavicle_${s}`]: `DEF-shoulder.${S}`,
      [`upperarm_${s}`]: `DEF-upper_arm.${S}`,
      [`lowerarm_${s}`]: `DEF-forearm.${S}`,
      [`hand_${s}`]: `DEF-hand.${S}`,
      [`thigh_${s}`]: `DEF-thigh.${S}`,
      [`calf_${s}`]: `DEF-shin.${S}`,
      [`foot_${s}`]: `DEF-foot.${S}`,
      [`ball_${s}`]: `DEF-toe.${S}`,
    });
    for (const f of ["index", "middle", "ring", "pinky"])
      for (const k of [1, 2, 3]) map[`${f}_0${k}_${s}`] = `DEF-f_${f}.0${k}.${S}`;
    for (const k of [1, 2, 3]) map[`thumb_0${k}_${s}`] = `DEF-thumb.0${k}.${S}`;
  }
  return map;
}
