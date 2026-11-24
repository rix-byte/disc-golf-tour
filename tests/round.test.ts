// Round rules on the real Mežinieki course.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Phase } from "../src/shared/physics";
import { V3 } from "../src/shared/vec";
import { CourseJson, buildWorld } from "../src/shared/world";
import { Round, autoTechnique, rel, scoreName, skill } from "../src/game/round";

const course = JSON.parse(readFileSync("public/courses/mezinieki.json", "utf8")) as CourseJson;
const fresh = () => {
  const r = new Round(buildWorld(course));
  r.startHole(0);
  return r;
};

describe("round rules", () => {
  it("starts on the first tee aiming at the basket with a drive", () => {
    const r = fresh();
    expect(r.strokes).toBe(0);
    expect(r.lie.distanceTo(new V3(r.hole.tee.x, r.hole.tee.y, r.hole.tee.z))).toBeLessThan(1e-6);
    expect(r.distToBasket()).toBeGreaterThan(40);
    expect(["bh_drive", "bh_stand"]).toContain(r.technique);
    expect(r.power).toBeGreaterThan(0.05);
    expect(r.power).toBeLessThanOrEqual(1);
  });

  it("picks technique by distance like Godot", () => {
    expect(autoTechnique(5)).toBe("push_putt");
    expect(autoTechnique(30)).toBe("bh_stand");
    expect(autoTechnique(80)).toBe("bh_drive");
  });

  it("names scores", () => {
    expect(scoreName(1, 3)).toBe("ACE!");
    expect(scoreName(2, 3)).toBe("Birdie");
    expect(scoreName(3, 3)).toBe("Par");
    expect(scoreName(6, 3)).toBe("+3");
    expect(rel(0)).toBe("E");
    expect(rel(2)).toBe("+2");
  });

  it("turns release error into a sideways miss that grows with power", () => {
    expect(skill(0, 1, "bh_drive").yaw).toBe(0);
    expect(skill(1, 1, "bh_drive").yaw).toBeGreaterThan(skill(1, 0.3, "bh_drive").yaw);
    expect(skill(1, 1, "push_putt").yaw).toBeLessThan(skill(1, 1, "bh_drive").yaw);
    expect(skill(2, 1, "bh_drive").wobble).toBeGreaterThan(0);
  });

  it("the suggested power lands a clean throw near the aim distance", () => {
    const r = fresh();
    const want = r.distToBasket();
    const p = r.preview();
    expect(Math.abs(p.distance() - want)).toBeLessThan(want * 0.25);
  });

  it("a clean throw counts a stroke and moves the lie", () => {
    const r = fresh();
    const o = r.throw(r.power, 0);
    expect(r.strokes).toBe(1);
    expect(o.result.positions.length).toBeGreaterThan(10);
    if (!o.holed && !o.penalty) {
      expect(r.afterSettle()).toBe("next_lie");
      expect(r.lie.distanceTo(r.prevLie)).toBeGreaterThan(5);
      expect(r.mode).toBe("aim");
    }
  });

  it("taps in from inside reach and records the hole", () => {
    const r = fresh();
    const b = r.basket;
    r.lie = new V3(b.x + 1.2, b.y, b.z);
    r.setupLie();
    expect(r.isTapIn()).toBe(true);
    const o = r.throw(0.2, 0);
    expect(o.holed).toBe(true);
    expect(o.result.phase).toBe(Phase.HOLED);
    expect(r.afterSettle()).toBe("hole_done");
    expect(r.scores).toEqual([1]);
    expect(r.nextHole()).toBe(true);
    expect(r.holeIdx).toBe(1);
  });

  it("holes a clean 5 m putt most of the time", () => {
    let made = 0;
    for (let k = 0; k < 6; k++) {
      const r = fresh();
      const b = r.basket;
      const a = (k / 6) * Math.PI * 2;
      r.lie = new V3(b.x + Math.cos(a) * 5, 0, b.z + Math.sin(a) * 5);
      r.lie.y = r.world.heightAt(r.lie.x, r.lie.z);
      r.setupLie();
      expect(r.technique).toBe("push_putt");
      if (r.throw(r.power, 0).holed) made++;
    }
    expect(made).toBeGreaterThanOrEqual(4);
  });

  it("OB costs a stroke and plays from relief", () => {
    const r = fresh();
    const o = r.throw(1, 0);
    // Force an OB outcome on a real flight to test the bookkeeping.
    o.result.phase = Phase.OUT;
    o.result.relief = r.prevLie.add(new V3(3, 0, 0));
    o.penalty = true;
    r.afterSettle();
    expect(r.strokes).toBe(2);
    expect(r.lie.distanceTo(o.result.relief)).toBeLessThan(1e-6);
  });

  it("finishes the round after the last hole", () => {
    const r = fresh();
    for (let i = 0; i < r.world.holes.length; i++) {
      if (i > 0) r.nextHole();
      const b = r.basket;
      r.lie = new V3(b.x + 1, b.y, b.z);
      r.setupLie();
      r.throw(0.2, 0);
      const next = r.afterSettle();
      expect(next).toBe(i === r.world.holes.length - 1 ? "round_done" : "hole_done");
    }
    expect(r.scores.length).toBe(9);
    expect(r.total).toBe(9);
    expect(r.nextHole()).toBe(false);
  });
});

describe("flight over the network", () => {
  it("a flight sent as JSON plays back to the same outcome", async () => {
    const { flightToJson, flightFromJson } = await import("../src/game/round");
    const a = fresh();
    const b = fresh();
    const o = a.throw(a.power, 0.3);
    const wire = JSON.parse(JSON.stringify(flightToJson(o.result)));
    const o2 = b.record(flightFromJson(wire));
    expect(o2.text).toBe(o.text);
    expect(o2.holed).toBe(o.holed);
    expect(b.strokes).toBe(1);
    expect(b.afterSettle()).toBe(a.afterSettle());
    expect(b.lie.distanceTo(a.lie)).toBeLessThan(0.002);
  });
});
