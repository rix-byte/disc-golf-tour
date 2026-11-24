// Same behaviour checks as the Godot tests/test_flight.gd, on the TS port.
import { describe, expect, it } from "vitest";
import { DISCS, STYLES, coeffsFor } from "../src/shared/catalog";
import { Phase, coefficients, makeLaunch, simulate } from "../src/shared/physics";
import { V3 } from "../src/shared/vec";
import { World, flatWorld, makeTree } from "../src/shared/world";

const flat = flatWorld();
const disc = (n: string) => DISCS.findIndex((d) => d.name === n);
const style = (id: string) => STYLES.find((s) => s.id === id)!;

function throwIt(d: string, power: number, hyzer = 0, fh = false, w: World = flat, basket: V3 | null = null, origin = new V3(0, 1, 0)) {
  const st = makeLaunch(origin, 0, power, 9, 0, hyzer, style(fh ? "fh" : "bh_drive"));
  return simulate(w, st, coefficients(DISCS[disc(d)]), basket);
}

describe("flight", () => {
  it("backhand fades left, forehand right", () => {
    expect(throwIt("Pebble", 0.8).finalPos.x).toBeLessThan(-2);
    expect(throwIt("Pebble", 0.8, 0, true).finalPos.x).toBeGreaterThan(2);
  });
  it("hyzer left, anhyzer right", () => {
    const flatR = throwIt("Heron", 1).finalPos.x;
    expect(throwIt("Heron", 1, 15).finalPos.x).toBeLessThan(flatR - 5);
    expect(throwIt("Heron", 1, -15).finalPos.x).toBeGreaterThan(flatR + 5);
  });
  it("understable turns, overstable fades", () => {
    expect(throwIt("Moth", 1).finalPos.x).toBeGreaterThan(5);
    expect(throwIt("Anvil", 1).finalPos.x).toBeLessThan(-10);
  });
  it("distance grows with power", () => {
    let prev = 0;
    for (const p of [0.3, 0.5, 0.7, 0.9]) {
      const d = throwIt("Heron", p).distance();
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });
  it("plausible distances", () => {
    const putt = throwIt("Pebble", 1).distance();
    const drive = throwIt("Comet", 1).distance();
    expect(putt).toBeGreaterThan(50);
    expect(putt).toBeLessThan(95);
    expect(drive).toBeGreaterThan(85);
    expect(drive).toBeLessThan(140);
  });
  it("deterministic", () => {
    expect(throwIt("Moth", 0.9, 5).finalPos).toEqual(throwIt("Moth", 0.9, 5).finalPos);
  });
  it("6 m putt makeable, not automatic", () => {
    const basket = new V3(0, 0, -6);
    let holed = 0;
    let tried = 0;
    for (const line of [6, 9, 12, 15])
      for (const p of [0.3, 0.34, 0.38, 0.42, 0.46]) {
        tried++;
        const st = makeLaunch(new V3(0, 1, 0), 0, p, line, 0, 0, style("bh_drive"));
        if (simulate(flat, st, coefficients(DISCS[0]), basket).phase === Phase.HOLED) holed++;
      }
    expect(holed).toBeGreaterThanOrEqual(2);
    expect(holed).toBeLessThan(tried);
  });
  it("hot putt spits out", () => {
    const st = makeLaunch(new V3(0, 1.05, 0), 0, 1, 0, 0, 0, style("bh_drive"));
    expect(simulate(flat, st, coefficients(DISCS[0]), new V3(0, 0, -6)).phase).not.toBe(Phase.HOLED);
  });
  it("trunk stops a drive", () => {
    const w = flatWorld();
    w.addTree(makeTree(w, 0, -20, 14, "pine", null));
    const st = makeLaunch(new V3(0, 1, 0), 0, 1, 1, 0, 0, style("bh_drive"));
    const r = simulate(w, st, coefficients(DISCS[2]), null);
    expect(r.events).toContain("tree");
    expect(r.distance()).toBeLessThan(40);
  });
});

describe("chaos specials", () => {
  const wall = () => {
    const w = flatWorld();
    for (let x = -12; x <= 12; x += 0.8) w.addTree(makeTree(w, x, -25, 14, "pine", null));
    return w;
  };
  const launch = () => makeLaunch(new V3(0, 1, 0), 0, 0.9, 2, 0, 0, style("bh_drive"));
  it("bomb explodes at first contact", () => {
    const r = simulate(wall(), launch(), coeffsFor(2, "bomb"), null);
    expect(r.exploded).toBe(true);
    expect(r.events).toContain("explode");
  });
  it("chainsaw cuts through the wall", () => {
    const r = simulate(wall(), launch(), coeffsFor(2, "saw"), null);
    expect(r.cut.size).toBeGreaterThan(0);
    expect(r.finalPos.z).toBeLessThan(-30);
  });
  it("ghost passes the first tree", () => {
    const w = flatWorld();
    w.addTree(makeTree(w, 0, -25, 14, "pine", null));
    const r = simulate(w, launch(), coeffsFor(2, "ghost"), null);
    expect(r.events).toContain("ghost");
    expect(r.finalPos.z).toBeLessThan(-30);
  });
  it("magnet bends toward the basket", () => {
    const basket = new V3(12, 0, -60);
    const plain = simulate(flat, launch(), coeffsFor(2, ""), basket);
    const mag = simulate(flat, launch(), coeffsFor(2, "magnet"), basket);
    expect(mag.finalPos.distanceTo(basket)).toBeLessThan(plain.finalPos.distanceTo(basket));
  });
  it("rubber bounces", () => {
    const st = makeLaunch(new V3(0, 1, 0), 0, 0.9, -12, 0, 0, style("bh_drive"));
    expect(simulate(flat, st, coeffsFor(2, "rubber"), null).events).toContain("bounce");
  });
});
