import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { V3 } from "../src/shared/vec";
import { CourseJson, buildWorld } from "../src/shared/world";
import { Match } from "../src/game/match";

const course = JSON.parse(readFileSync("public/courses/mezinieki.json", "utf8")) as CourseJson;
const make = (n: number) => new Match(buildWorld(course), Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, local: true })));

/** Put the current player `d` metres from the basket and settle that as their throw. */
function moveTo(m: Match, d: number) {
  const r = m.current.round;
  const b = r.basket;
  r.strokes++;
  r.lie = new V3(b.x + d, b.y, b.z);
}
/** Hole out the current player with `strokes` total. */
function holeOut(m: Match, strokes: number) {
  const r = m.current.round;
  r.strokes = strokes;
  r.scores.push(strokes);
}

describe("match turn order", () => {
  it("everyone tees off in join order on hole 1", () => {
    const m = make(3);
    expect(m.current.id).toBe("p0");
    moveTo(m, 40);
    expect(m.next()).toBe("turn");
    expect(m.current.id).toBe("p1");
    moveTo(m, 20);
    m.next();
    expect(m.current.id).toBe("p2");
  });

  it("after the tee, farthest from the basket throws next", () => {
    const m = make(3);
    moveTo(m, 40); // p0
    m.next();
    moveTo(m, 20); // p1
    m.next();
    moveTo(m, 30); // p2
    m.next();
    expect(m.current.id).toBe("p0"); // 40 m
    moveTo(m, 10);
    m.next();
    expect(m.current.id).toBe("p2"); // 30 m
  });

  it("the hole ends when all have holed out; best score tees first next", () => {
    const m = make(2);
    holeOut(m, 4); // p0
    expect(m.next()).toBe("turn");
    expect(m.current.id).toBe("p1");
    holeOut(m, 2); // p1
    expect(m.next()).toBe("hole_done");
    expect(m.nextHole()).toBe(true);
    expect(m.holeIdx).toBe(1);
    expect(m.current.id).toBe("p1"); // birdie has the honour
    expect(m.seats.every((s) => s.round.strokes === 0)).toBe(true);
  });

  it("a player who leaves is skipped", () => {
    const m = make(2);
    moveTo(m, 40);
    m.next();
    expect(m.current.id).toBe("p1");
    expect(m.leave("p1")).toBe(true);
    expect(m.next()).toBe("turn");
    expect(m.current.id).toBe("p0");
  });

  it("reports the round finished after the last hole", () => {
    const m = make(2);
    for (let h = 0; h < 9; h++) {
      holeOut(m, 3);
      m.next();
      holeOut(m, 3);
      const r = m.next();
      if (h < 8) {
        expect(r).toBe("hole_done");
        m.nextHole();
      } else expect(r).toBe("round_done");
    }
    expect(m.standings().map((s) => s.toPar)).toEqual([0, 0]);
  });
});
