// A match: 1–4 players on one course, each with their own Round (lie,
// strokes, scores). Real disc golf turn order: on the tee, the best score on
// the previous hole throws first (join order on hole 1); after that, whoever
// is farthest from the basket throws next. The hole ends when everyone has
// holed out. Pure logic: every client runs the same match from the same
// throws, so all of them agree without a server.

import { Round } from "./round";
import { World } from "../shared/world";

export const PLAYER_COLORS = [0xd8402f, 0x2f7fd8, 0x2fb36a, 0xe0a52a];

export interface SeatInfo {
  id: string;
  name: string;
  /** Throws from this browser (solo / pass & play: everyone; online: only you). */
  local: boolean;
}

export interface Seat extends SeatInfo {
  color: number;
  round: Round;
  /** Left an online game: skipped from then on. */
  left: boolean;
}

export class Match {
  seats: Seat[];
  holeIdx = 0;
  turn = 0;
  /** Tee order for the current hole (seat indices). */
  private teeOrder: number[];

  constructor(world: World, players: SeatInfo[]) {
    this.seats = players.map((p, i) => {
      const round = new Round(world);
      round.startHole(0);
      return { ...p, color: PLAYER_COLORS[i % PLAYER_COLORS.length], round, left: false };
    });
    this.teeOrder = this.seats.map((_, i) => i);
    this.turn = this.teeOrder[0];
  }

  get current(): Seat {
    return this.seats[this.turn];
  }

  /** Still to hole out on this hole (and present). */
  playing(s: Seat): boolean {
    return !s.left && s.round.scores.length <= this.holeIdx;
  }

  /**
   * After the current player's throw has settled (round.afterSettle() done):
   * pick who throws next, or report the hole / round finished.
   */
  next(): "turn" | "hole_done" | "round_done" {
    const left = this.seats.filter((s) => this.playing(s));
    if (!left.length) return this.holeIdx + 1 >= this.seats[0].round.world.holes.length ? "round_done" : "hole_done";
    // Anyone still on the tee goes in tee order first; then farthest from the basket.
    const onTee = this.teeOrder.filter((i) => this.playing(this.seats[i]) && this.seats[i].round.strokes === 0);
    if (onTee.length) {
      this.turn = onTee[0];
      return "turn";
    }
    let best = left[0];
    for (const s of left) if (s.round.distToBasket() > best.round.distToBasket() + 1e-6) best = s;
    this.turn = this.seats.indexOf(best);
    return "turn";
  }

  /** Everyone moves to the next hole's tee; best score on this hole throws first. */
  nextHole(): boolean {
    if (this.holeIdx + 1 >= this.seats[0].round.world.holes.length) return false;
    const h = this.holeIdx;
    this.holeIdx++;
    for (const s of this.seats) {
      if (s.left) continue;
      if (s.round.scores.length <= h) s.round.scores.push(s.round.hole.par + 3); // left mid-hole safety
      s.round.startHole(this.holeIdx);
    }
    this.teeOrder = this.seats
      .map((s, i) => ({ i, sc: s.round.scores[h] ?? 99 }))
      .sort((a, b) => a.sc - b.sc || a.i - b.i)
      .map((x) => x.i);
    this.next();
    return true;
  }

  /** An online player left: they're skipped from now on. Returns true if it was their turn. */
  leave(id: string): boolean {
    const s = this.seats.find((x) => x.id === id);
    if (!s || s.left) return false;
    s.left = true;
    return this.current === s;
  }

  /** Standings: total strokes and against par for the holes played. */
  standings() {
    const holes = this.seats[0].round.world.holes;
    return this.seats.map((s) => {
      const total = s.round.scores.reduce((a, b) => a + b, 0);
      const par = s.round.scores.reduce((a, _, i) => a + holes[i].par, 0);
      return { seat: s, total, toPar: total - par };
    });
  }
}
