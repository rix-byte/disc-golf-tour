// Tour-broadcast HUD (ported layout from Godot tour_hud.gd), as HTML over the canvas:
//   top-left    player card: name, score vs par, hole, throw boxes, FOR BIRDIE/PAR
//   top-centre  course · HOLE · PAR · distance
//   right       disc rail: disc, flight numbers, category, technique, stance
//   bottom      swing dial + power bar (target tick) + release pill + wind
//   overlays    toast, scorecard after each hole, round summary

import { DISCS } from "../shared/catalog";
import type { Meter } from "./meter";
import type { Hole } from "../shared/world";
import { Round, rel, scoreName, stanceOf, techniqueName } from "./round";

const WIND_NAMES: [number, string][] = [[0.5, "CALM"], [1.6, "LIGHT AIR"], [3.4, "LIGHT BREEZE"], [5.5, "GENTLE BREEZE"], [8, "MODERATE BREEZE"], [99, "FRESH BREEZE"]];
const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function category(kind: string): string {
  const k = kind.toLowerCase();
  return k.startsWith("putter") ? "PUTTER" : k.startsWith("midrange") ? "MIDRANGE" : k.startsWith("fairway") ? "FAIRWAY" : "DISTANCE";
}

export class Hud {
  private el = document.createElement("div");
  private card = document.createElement("div");
  private holeBox = document.createElement("div");
  private rail = document.createElement("div");
  private bottom = document.createElement("div");
  private dial = document.createElement("canvas");
  private wind = document.createElement("div");
  private pill = document.createElement("div");
  private toast = document.createElement("div");
  private overlay = document.createElement("div");
  private hints = document.createElement("div");
  private meterCv = document.createElement("canvas");
  private modeTag = document.createElement("div");
  private toastUntil = 0;
  private lastCard = "";
  /** Live swing picture: dot (x, y down) and current pull power. */
  swing = { x: 0, y: 0, power: 0, active: false };
  /** Arcade meter or Sim run-up in progress (drawn as the bar above the dial). */
  meter: Meter | null = null;

  constructor(parent: HTMLElement, private courseName: string) {
    this.el.id = "hud";
    this.card.className = "hud-card";
    this.holeBox.className = "hud-hole";
    this.rail.className = "hud-rail";
    this.bottom.className = "hud-bottom";
    this.dial.width = this.dial.height = 150;
    this.dial.className = "hud-dial";
    this.wind.className = "hud-wind";
    this.pill.className = "hud-pill";
    this.toast.className = "hud-toast";
    this.overlay.className = "hud-overlay";
    this.hints.className = "hud-hints";
    this.meterCv.width = 360;
    this.meterCv.height = 44;
    this.meterCv.className = "hud-meter";
    this.modeTag.className = "hud-mode";
    this.bottom.append(this.meterCv, this.dial, this.pill, this.wind);
    this.el.append(this.card, this.holeBox, this.rail, this.bottom, this.toast, this.overlay, this.hints, this.modeTag);
    parent.appendChild(this.el);
    this.setMode("sim");
  }

  /** Key hints and the mode tag for Sim (mouse swing) or Arcade (keyboard meter). */
  setMode(mode: "sim" | "arcade") {
    const k = (key: string, what: string) => `<span><b>${key}</b> ${what}</span>`;
    const throwKeys = mode === "sim" ? k("DRAG", "pull back, flick up") + k("SPACE", "easy throw") : k("SPACE", "hold power · let go · tap in zone");
    this.hints.innerHTML = throwKeys + k("← →", "aim") + k("W S", "angle") + k("Z X", "tilt") + k("[ ]", "disc") + k("F", "technique") + k("T", "line") + k("M", "mode") + k("G", "graphics");
    this.modeTag.textContent = mode === "sim" ? "SIM" : "ARCADE";
  }

  say(text: string, secs = 2.5) {
    this.toast.textContent = text;
    this.toast.classList.add("show");
    this.toastUntil = performance.now() + secs * 1000;
  }

  releasePill(deg: number, power: number, note?: string) {
    const clean = Math.abs(deg) < 0.6;
    this.pill.textContent = `${note ? `${note}  ·  ` : ""}${Math.round(power * 100)}%  ·  ${deg >= 0 ? "+" : ""}${deg.toFixed(1)}°`;
    this.pill.className = `hud-pill show ${clean ? "good" : Math.abs(deg) < 2.5 ? "ok" : "bad"}`;
    setTimeout(() => this.pill.classList.remove("show"), 2200);
  }

  /**
   * `who` = whose turn it is (name + colour); `others` = the rest of the
   * group for the little standings list under the card (empty when solo).
   */
  update(r: Round, camYaw: number, who = { name: "YOU", color: 0xd8402f }, others: { name: string; color: number; text: string }[] = []) {
    if (this.toastUntil && performance.now() > this.toastUntil) {
      this.toast.classList.remove("show");
      this.toastUntil = 0;
    }
    const h = r.hole;
    const toBasket = Math.round(r.distToBasket());
    const scoreRel = r.total - r.par;
    const forWhat = r.mode === "aim" ? (["FOR ACE", "FOR BIRDIE", "FOR PAR", "FOR BOGEY"][r.strokes] ?? "") : "";
    const boxes = Array.from({ length: Math.max(h.par, r.strokes + 1) }, (_, i) => `<i class="${i < r.strokes ? "done" : i === r.strokes ? "now" : ""}">${i + 1}</i>`).join("");
    const list = others.map((o) => `<div class="other"><i style="background:${hex(o.color)}"></i>${escHtml(o.name)}<b>${o.text}</b></div>`).join("");
    const html = `<div class="name" style="background:${hex(who.color)}"><span>${escHtml(who.name.toUpperCase())}</span><b>${rel(scoreRel)}</b></div><div class="row"><b class="holeno">${r.holeIdx + 1}</b>${boxes}<span class="for">${forWhat}</span></div>${list}`;
    if (html !== this.lastCard) this.card.innerHTML = this.lastCard = html;
    this.holeBox.innerHTML = `<small>${this.courseName.toUpperCase()}</small><div>HOLE ${r.holeIdx + 1}&nbsp;&nbsp;PAR ${h.par}&nbsp;&nbsp;${toBasket} M</div>`;
    const d = DISCS[r.discIdx];
    this.rail.innerHTML = `<div class="disc" style="--c:${hex(d.color)}"></div><div class="fn">${d.speed} &nbsp;${d.glide} &nbsp;${d.turn} &nbsp;${d.fade}</div><div class="arrow">‹ <b>${d.name.toUpperCase()}</b> ›</div><div class="arrow">‹ ${category(d.kind)} ›</div><div class="line"></div><div class="sel">${stanceOf(r.technique)}</div><div class="sel">${techniqueName(r.technique)}</div>`;
    // Wind: name, speed and an arrow relative to the camera.
    const w = r.world.wind;
    const speed = Math.hypot(w.x, w.z);
    const name = WIND_NAMES.find(([v]) => speed < v)![1];
    const ang = Math.atan2(w.x, -w.z) - camYaw;
    this.wind.innerHTML = `${name} <span class="arrow" style="transform:rotate(${ang}rad)">▲</span> ${speed.toFixed(1)} m/s`;
    this.bottom.style.opacity = r.mode === "aim" || this.meter ? "1" : "0.25";
    this.drawDial(r);
    this.drawMeter(r);
  }

  /**
   * The bar above the dial: power fills (white tick = suggested power), then
   * after letting go a needle runs toward the green release zone.
   */
  private drawMeter(r: Round) {
    const g = this.meterCv.getContext("2d")!;
    const W = this.meterCv.width;
    const H = this.meterCv.height;
    g.clearRect(0, 0, W, H);
    const m = this.meter;
    this.meterCv.style.visibility = m ? "visible" : "hidden";
    if (!m) return;
    const x0 = 14;
    const w = W - 28;
    const y = 14;
    const h = 16;
    g.fillStyle = "rgba(10,14,16,0.7)";
    g.fillRect(x0 - 4, y - 4, w + 8, h + 8);
    if (m.phase === "charge") {
      const p = Math.min(1.05, m.charge) / 1.05;
      g.fillStyle = m.charge > 1 ? "#e0702a" : "#fac73d";
      g.fillRect(x0, y, w * p, h);
      const tx = x0 + (w * Math.min(1, r.power)) / 1.05;
      g.fillStyle = "#fff";
      g.fillRect(tx - 1.5, y - 6, 3, h + 12);
      g.font = "bold 12px system-ui";
      g.fillText(`${Math.round(m.charge * 100)}%`, x0 + 4, y + h + 13);
      return;
    }
    // Timing: zone in the middle, needle comes from the left (early) and passes it (late).
    const scale = w / 2 / 0.9; // ±0.9 bar widths visible
    const cx = x0 + w / 2;
    const zh = m.zoneHalf() * scale;
    g.fillStyle = "rgba(47,179,106,0.45)";
    g.fillRect(cx - zh, y, zh * 2, h);
    g.fillStyle = "rgba(47,179,106,0.95)";
    g.fillRect(cx - zh * 0.4, y, zh * 0.8, h);
    const nx = Math.max(x0, Math.min(x0 + w, cx + m.needle() * scale));
    g.fillStyle = "#fff";
    g.fillRect(nx - 2, y - 6, 4, h + 12);
    g.font = "bold 12px system-ui";
    g.fillText(this.meter?.tech === "bh_drive" ? "PLANT" : "RELEASE", cx - 26, y + h + 13);
  }

  private drawDial(r: Round) {
    const g = this.dial.getContext("2d")!;
    const W = this.dial.width;
    const c = W / 2;
    const R = 58;
    g.clearRect(0, 0, W, W);
    g.fillStyle = "rgba(10,14,16,0.55)";
    g.beginPath();
    g.arc(c, c, R + 8, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.lineWidth = 2;
    g.beginPath();
    g.arc(c, c, R, 0, Math.PI * 2);
    g.stroke();
    // Power arc (bottom half fills as you pull), with the suggested power tick.
    const arc = (p: number, col: string, w: number) => {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.beginPath();
      g.arc(c, c, R + 4, Math.PI * 0.5 - p * Math.PI, Math.PI * 0.5 + p * Math.PI);
      g.stroke();
    };
    arc(Math.min(1, this.swing.power), "#fac73d", 6);
    const tp = Math.min(1, r.power);
    for (const s of [-1, 1]) {
      const a = Math.PI * 0.5 + s * tp * Math.PI;
      g.strokeStyle = "#fff";
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * (R - 2), c + Math.sin(a) * (R - 2));
      g.lineTo(c + Math.cos(a) * (R + 10), c + Math.sin(a) * (R + 10));
      g.stroke();
    }
    // Hyzer line + the dot.
    g.strokeStyle = "rgba(255,255,255,0.5)";
    g.lineWidth = 1.5;
    const hz = (-r.hyzerDeg * Math.PI) / 180;
    g.beginPath();
    g.moveTo(c - Math.cos(hz) * 22, c - Math.sin(hz) * 22);
    g.lineTo(c + Math.cos(hz) * 22, c + Math.sin(hz) * 22);
    g.stroke();
    g.fillStyle = this.swing.active ? "#fff" : "rgba(255,255,255,0.6)";
    g.beginPath();
    g.arc(c + this.swing.x * R, c + this.swing.y * R, 7, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#fff";
    g.font = "bold 13px system-ui";
    g.textAlign = "center";
    g.fillText(`${Math.round((this.swing.active ? this.swing.power : r.power) * 100)}%`, c, c - 18);
  }

  /**
   * Scorecard after a hole (or the final one), one row per player. Resolves
   * when the player continues, or by itself after `autoSecs` (online games
   * keep moving so nobody holds the group up).
   */
  showScorecard(holes: Hole[], rows: { name: string; color: number; scores: number[] }[], final: boolean, autoSecs = 0, button = ""): Promise<void> {
    const cells = (f: (i: number) => string) => holes.map((_, i) => `<td>${f(i)}</td>`).join("");
    const parTotal = holes.reduce((s, h) => s + h.par, 0);
    const sc = (scores: number[], i: number) => {
      const s = scores[i];
      if (s === undefined) return "";
      const d = s - holes[i].par;
      return `<span class="s ${d < 0 ? "under" : d > 0 ? "over" : ""}">${s}</span>`;
    };
    const total = (s: number[]) => s.reduce((a, b) => a + b, 0);
    const toPar = (s: number[]) => total(s) - s.reduce((a, _, i) => a + holes[i].par, 0);
    let title: string;
    if (final) {
      const best = [...rows].sort((a, b) => total(a.scores) - total(b.scores));
      title = rows.length > 1 && total(best[0].scores) < total(best[1].scores) ? `${escHtml(best[0].name.toUpperCase())} WINS` : "ROUND COMPLETE";
    } else if (rows.length === 1) {
      const last = rows[0].scores.length - 1;
      title = scoreName(rows[0].scores[last], holes[last].par).toUpperCase();
    } else title = `HOLE ${rows[0].scores.length} DONE`;
    const body = rows
      .map((r) => `<tr><th><i class="dot" style="background:${hex(r.color)}"></i>${escHtml(r.name)}</th>${cells((i) => sc(r.scores, i))}<th>${total(r.scores)} <small>${rel(toPar(r.scores))}</small></th></tr>`)
      .join("");
    const label = button || (final ? "Back to menu" : "Next hole ▶");
    this.overlay.innerHTML = `<div class="card"><h2>${title}</h2><table><tr><th>HOLE</th>${cells((i) => String(i + 1))}<th>TOT</th></tr><tr><th>PAR</th>${cells((i) => String(holes[i].par))}<th>${parTotal}</th></tr>${body}</table><button>${label}</button><p>${autoSecs ? `continues in <span class="cd">${autoSecs}</span> s · ` : ""}Enter</p></div>`;
    this.overlay.classList.add("show");
    return new Promise((resolve) => {
      let timer = 0;
      const done = () => {
        clearInterval(timer);
        removeEventListener("keydown", key);
        this.overlay.classList.remove("show");
        resolve();
      };
      const key = (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") done();
      };
      addEventListener("keydown", key);
      this.overlay.querySelector("button")!.addEventListener("click", done, { once: true });
      if (autoSecs) {
        let left = autoSecs;
        timer = window.setInterval(() => {
          left--;
          const cd = this.overlay.querySelector(".cd");
          if (cd) cd.textContent = String(left);
          if (left <= 0) done();
        }, 1000);
      }
    });
  }
}
