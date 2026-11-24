import { describe, expect, it } from "vitest";
import { PULL_PX, Swing } from "../src/game/swing";

function rig() {
  let clock = 0;
  const log: string[] = [];
  let thrown: [number, number] | null = null;
  let pull: [number, number] = [0, 0];
  const s = new Swing(
    {
      pull: (p, h) => (pull = [p, h]),
      thrown: (p, r) => (thrown = [p, r]),
      cancel: () => log.push("cancel"),
    },
    () => clock,
  );
  return { s, log, tick: (ms: number) => (clock += ms), thrown: () => thrown, pull: () => pull };
}

describe("swing gesture", () => {
  it("straight pull and straight flick = full power, clean release", () => {
    const r = rig();
    r.s.down(500, 300);
    r.s.move(500, 300 + PULL_PX);
    expect(r.pull()[0]).toBeCloseTo(1, 2);
    expect(r.pull()[1]).toBeCloseTo(0, 5);
    r.tick(50);
    r.s.move(500, 300 + PULL_PX * 0.5);
    r.tick(50);
    r.s.move(500, 300 - PULL_PX * 0.5);
    const t = r.thrown()!;
    expect(t[0]).toBeCloseTo(1, 2);
    expect(Math.abs(t[1])).toBeLessThan(0.01);
  });

  it("pulling to the left adds hyzer, a half pull is half power", () => {
    const r = rig();
    r.s.down(0, 0);
    r.s.move(-0.3 * PULL_PX, 0.4 * PULL_PX);
    expect(r.pull()[0]).toBeCloseTo(0.5, 2);
    expect(r.pull()[1]).toBeGreaterThan(20);
  });

  it("a flick pushed to the right is a positive release error", () => {
    const r = rig();
    r.s.down(0, 0);
    r.s.move(0, PULL_PX);
    r.s.move(0, PULL_PX * 0.6);
    r.s.move(PULL_PX * 0.4, -PULL_PX * 0.5);
    expect(r.thrown()![1]).toBeGreaterThan(0.5);
  });

  it("letting go without a flick cancels", () => {
    const r = rig();
    r.s.down(0, 0);
    r.s.move(0, PULL_PX * 0.7);
    r.s.up(0, PULL_PX * 0.7);
    expect(r.log).toEqual(["cancel"]);
    expect(r.thrown()).toBeNull();
  });

  it("a slow flick loses a little power", () => {
    const r = rig();
    r.s.down(0, 0);
    r.s.move(0, PULL_PX);
    r.s.move(0, PULL_PX * 0.7);
    r.tick(600);
    r.s.move(0, -PULL_PX * 0.5);
    expect(r.thrown()![0]).toBeCloseTo(0.92, 2);
  });
});
