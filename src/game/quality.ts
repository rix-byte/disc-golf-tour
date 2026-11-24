// Graphics quality levels. The game starts from a guess based on the GPU,
// steps down on its own when frames run slow, and G cycles them by hand.
// The budget target is a laptop's built-in GPU (Intel UHD) at "low"/"medium".

export interface Quality {
  name: string;
  /** Render resolution as a fraction of 1600x900 (the canvas is stretched to the window). */
  scale: number;
  /** Grass tufts per focus point (lie, look-ahead or landing spot; ~28 m radius each). */
  grass: number;
  blades: number;
  /** Static (baked once) shadow map size for the whole course. */
  shadow: number;
  /** Trees closer than this are real models; further ones are picture cards. */
  near: number;
  ao: boolean;
  msaa: number;
  far: number;
}

export const LEVELS: Quality[] = [
  { name: "low", scale: 0.67, grass: 5000, blades: 5, shadow: 2048, near: 32, ao: false, msaa: 0, far: 420 },
  { name: "medium", scale: 0.85, grass: 11000, blades: 7, shadow: 4096, near: 50, ao: false, msaa: 2, far: 600 },
  { name: "high", scale: 1, grass: 22000, blades: 8, shadow: 4096, near: 80, ao: true, msaa: 4, far: 800 },
];

/**
 * ?q=low|medium|high wins; otherwise medium (Intel UHD ~19 ms, RTX 3050 ~8 ms),
 * software renderers low. Too slow -> FrameWatch steps down.
 */
export function initialLevel(gpu: string, wanted: string | null): number {
  const i = LEVELS.findIndex((l) => l.name === wanted);
  if (i >= 0) return i;
  return /swiftshader|llvmpipe|microsoft basic/i.test(gpu) ? 0 : 1;
}

/** Watches frame times; says when the current level is too heavy. */
export class FrameWatch {
  private sum = 0;
  private n = 0;
  private grace = 3; // seconds to ignore after a change (shaders compiling)
  tooSlow(dt: number): boolean {
    if (this.grace > 0) {
      this.grace -= dt;
      return false;
    }
    this.sum += dt;
    this.n++;
    if (this.sum < 2.5) return false;
    const avg = this.sum / this.n;
    this.sum = 0;
    this.n = 0;
    return avg > 1 / 30;
  }
  reset() {
    this.sum = 0;
    this.n = 0;
    this.grace = 3;
  }
}
