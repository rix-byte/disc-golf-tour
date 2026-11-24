// Discs, throw styles, the release-skill model and the Chaos specials.

import type { Coeffs, DiscDef, Style } from "./physics";
import { coefficients } from "./physics";

export const DISCS: DiscDef[] = [
  { name: "Pebble", kind: "Putter", speed: 2, glide: 3, turn: 0, fade: 1, color: 0xf2d933 },
  { name: "Driftwood", kind: "Midrange", speed: 5, glide: 5, turn: -1, fade: 1, color: 0x4dbff2 },
  { name: "Heron", kind: "Fairway", speed: 7, glide: 5, turn: -1, fade: 2, color: 0xf27333 },
  { name: "Moth", kind: "Fairway (understable)", speed: 7, glide: 6, turn: -3, fade: 1, color: 0xd966e6 },
  { name: "Comet", kind: "Distance driver", speed: 12, glide: 5, turn: -1, fade: 3, color: 0xf2404d },
  { name: "Anvil", kind: "Overstable driver", speed: 11, glide: 4, turn: 0, fade: 4, color: 0x595966 },
];

export const STYLES: Style[] = [
  { id: "bh_drive", name: "Backhand drive", forehand: false, max_speed: 27, spin_ratio: 4.6, line: 9, hyzer: 0, nose: 0, wobble: 0.1 },
  { id: "bh_stand", name: "Backhand", forehand: false, max_speed: 22, spin_ratio: 4.4, line: 8, hyzer: 0, nose: 0, wobble: 0.06 },
  { id: "fh", name: "Forehand", forehand: true, max_speed: 25, spin_ratio: 3.7, line: 7, hyzer: 5, nose: 0, wobble: 0.14 },
  { id: "push_putt", name: "Push putt", forehand: false, max_speed: 13, spin_ratio: 2.6, line: 3, hyzer: 0, nose: 1, wobble: 0.03 },
  { id: "spin_putt", name: "Spin putt", forehand: false, max_speed: 15, spin_ratio: 4.2, line: 3, hyzer: 0, nose: 0, wobble: 0.03 },
  { id: "tomahawk", name: "Tomahawk", forehand: true, max_speed: 21, spin_ratio: 3.4, line: 24, hyzer: -90, nose: 0, wobble: 0.12 },
  { id: "roller", name: "Roller", forehand: false, max_speed: 23, spin_ratio: 4.6, line: 2, hyzer: -70, nose: -2, wobble: 0.08 },
];

/** Metres from lie to basket that count as "can reach it" (automatic tap-in). */
export const REACH = 1.9;

export interface Special { id: string; name: string; color: number; mods: Partial<Coeffs>; start: number; hint: string }

export const SPECIALS: Record<string, Special> = {
  bomb: { id: "bomb", name: "Bomb", color: 0xf24026, mods: { bomb: true }, start: 2, hint: "explodes on first contact: crater + trees blown over" },
  saw: { id: "saw", name: "Chainsaw", color: 0xffb81a, mods: { saw: true }, start: 2, hint: "cuts down every tree in its way" },
  rubber: { id: "rubber", name: "Rubber", color: 0x4de666, mods: { bounce: 0.65 }, start: 3, hint: "bounces off the ground and trunks" },
  magnet: { id: "magnet", name: "Magnet", color: 0x598cff, mods: { magnet: true }, start: 1, hint: "bends toward the basket in the last 25 m" },
  ghost: { id: "ghost", name: "Ghost", color: 0xd9d9ff, mods: { ghost: true }, start: 2, hint: "passes through the first tree it touches" },
};
export const SPECIAL_ORDER = ["bomb", "saw", "rubber", "magnet", "ghost"];
export const BLAST_R = 6;
export const CRATER_DEPTH = 1.4;
export const FELL_R = 10;

export const PLAYER_COLORS = [0xf24d40, 0x4d8cff, 0x59d959, 0xffd933, 0xc05cff, 0xff8a3d, 0x3de0d0, 0xff6fb5];

export function coeffsFor(disc: number, special: string): Coeffs {
  const c = coefficients(DISCS[disc] ?? DISCS[0]);
  return special && SPECIALS[special] ? { ...c, ...SPECIALS[special].mods } : c;
}

/** Degrees of aim error for |lat| = 1 (Standard assist). */
export function spreadDeg(power: number, style: Style): number {
  const putt = style.id === "push_putt" || style.id === "spin_putt";
  return putt ? 1.15 + 0.8 * power : 2.5 + 4.5 * power;
}

/** Technique the game suggests for a distance. */
export function autoStyle(dist: number): number {
  if (dist < 11) return 3;
  if (dist < 20) return 4;
  if (dist < 55) return 1;
  return 0;
}
