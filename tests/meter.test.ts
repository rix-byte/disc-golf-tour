import { describe, expect, it } from "vitest";
import { CHARGE_MAX, Meter, timingToLat, verdict, windowSecs } from "../src/game/meter";

describe("release timing", () => {
  it("window narrows with power and is wider for putts", () => {
    expect(windowSecs(0, "bh_stand")).toBeCloseTo(0.11, 5);
    expect(windowSecs(1, "bh_stand")).toBeCloseTo(0.055, 5);
    expect(windowSecs(1, "push_putt")).toBeGreaterThan(windowSecs(1, "bh_stand"));
  });

  it("late backhand pulls left, late forehand pushes right", () => {
    expect(timingToLat(0.05, 1, "bh_stand")).toBeLessThan(0);
    expect(timingToLat(0.05, 1, "fh")).toBeGreaterThan(0);
    expect(timingToLat(0, 1, "fh")).toBe(0);
  });

  it("names the run-up and releases", () => {
    expect(verdict(0, 1, "bh_drive").text).toBe("Perfect run-up");
    expect(verdict(-0.2, 1, "bh_drive").text).toBe("Early run-up");
    expect(verdict(0.2, 1, "fh").text).toBe("Late release");
    expect(verdict(0.2, 1, "fh").good).toBe(false);
  });
});

describe("keyboard meter", () => {
  it("hold fills power, let go locks it, a tap on time is clean", () => {
    const m = new Meter("bh_stand");
    m.start();
    for (let i = 0; i < 48; i++) m.tick(1 / 60); // 0.8 s of a 1 s bar
    expect(m.charge).toBeCloseTo(0.8, 2);
    expect(m.letGo(0.5)).toBe(true);
    expect(m.power).toBeCloseTo(0.8, 2);
    for (let i = 0; i < 30; i++) m.tick(1 / 60);
    expect(Math.abs(m.needle())).toBeLessThan(0.05);
    m.tap();
    expect(Math.abs(m.result!.errS)).toBeLessThan(0.02);
  });

  it("power caps at overpower", () => {
    const m = new Meter("bh_stand");
    m.start();
    for (let i = 0; i < 200; i++) m.tick(1 / 60);
    expect(m.charge).toBe(CHARGE_MAX);
  });

  it("a quick tap cancels instead of throwing", () => {
    const m = new Meter("bh_stand");
    m.start();
    m.tick(0.01);
    expect(m.letGo(0.5)).toBe(false);
    expect(m.phase).toBe("idle");
  });

  it("no tap counts as late", () => {
    const m = new Meter("bh_stand");
    m.start();
    for (let i = 0; i < 60; i++) m.tick(1 / 60);
    m.letGo(0.4);
    for (let i = 0; i < 120 && !m.result; i++) m.tick(1 / 60);
    expect(m.result!.errS).toBeGreaterThan(0);
  });
});
