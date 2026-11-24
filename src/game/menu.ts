// Start menu: name, solo / pass & play / host online / join online, and
// settings (controls, graphics). Resolves with the players for the match
// (and the online connection, if any). Shown while the course loads.

import type { SeatInfo } from "./match";
import { Net, type NetPlayer } from "./net";

export interface MenuResult {
  players: SeatInfo[];
  net: Net | null;
  mode: "sim" | "arcade";
  quality: string;
}

const store = {
  get: (k: string, d: string) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class Menu {
  private el = document.createElement("div");
  private status = "Loading course…";
  private ready = false;
  private resolve!: (r: MenuResult) => void;
  private mode: "sim" | "arcade" = store.get("dg-mode", "sim") === "arcade" ? "arcade" : "sim";
  private quality = store.get("dg-quality", "auto");
  private net: Net | null = null;
  private done = false;

  constructor(private courseName: string, private holes: number) {
    this.el.className = "menu";
    document.body.appendChild(this.el);
  }

  /** Show the menu; resolves when a game is chosen (and the course has loaded). */
  open(joinCode?: string): Promise<MenuResult> {
    this.el.style.display = "grid";
    if (joinCode) {
      this.join();
      const i = this.el.querySelector<HTMLInputElement>("#mcode");
      if (i) i.value = joinCode.toUpperCase().slice(0, 5);
    } else this.home();
    return new Promise((r) => (this.resolve = r));
  }

  /** The course finished loading: start buttons become usable. */
  setReady() {
    this.ready = true;
    this.status = "";
    this.el.querySelectorAll<HTMLButtonElement>("button[data-needs-load]").forEach((b) => (b.disabled = false));
    const s = this.el.querySelector(".menu-status");
    if (s) s.textContent = "";
  }
  setStatus(text: string) {
    this.status = text;
    const s = this.el.querySelector(".menu-status");
    if (s) s.textContent = text;
  }

  close() {
    this.el.style.display = "none";
  }

  private name(): string {
    return (this.el.querySelector<HTMLInputElement>("#mname")?.value || store.get("dg-name", "") || "Player").slice(0, 16);
  }

  private frame(body: string) {
    this.el.innerHTML = `<div class="menu-card">
      <h1>DISC GOLF <span>TOUR</span></h1>
      <div class="menu-course">${esc(this.courseName)} · ${this.holes} holes</div>
      ${body}
      <div class="menu-status">${esc(this.status)}</div>
    </div>`;
  }

  private on(sel: string, fn: () => void) {
    this.el.querySelector(sel)?.addEventListener("click", fn);
  }

  private home() {
    const dis = this.ready ? "" : "disabled";
    this.frame(`
      <label class="menu-field">Your name <input id="mname" maxlength="16" value="${esc(store.get("dg-name", ""))}" placeholder="Player"></label>
      <div class="menu-buttons">
        <button class="primary" id="solo" data-needs-load ${dis}>Play solo</button>
        <button id="local" data-needs-load ${dis}>Pass &amp; play <small>2–4 on this computer</small></button>
        <button id="host" data-needs-load ${dis}>Host online game <small>get a room code</small></button>
        <button id="join" data-needs-load ${dis}>Join online game <small>enter a code</small></button>
      </div>
      <div class="menu-settings">
        <div>Controls <button class="seg ${this.mode === "sim" ? "on" : ""}" id="msim">Sim · mouse</button><button class="seg ${this.mode === "arcade" ? "on" : ""}" id="marc">Arcade · keys</button></div>
        <div>Graphics ${["auto", "low", "medium", "high"].map((q) => `<button class="seg ${this.quality === q ? "on" : ""}" data-q="${q}">${q}</button>`).join("")}</div>
      </div>`);
    const saveName = () => store.set("dg-name", this.name());
    this.on("#solo", () => {
      saveName();
      this.finish([{ id: "p0", name: this.name(), local: true }]);
    });
    this.on("#local", () => {
      saveName();
      this.local();
    });
    this.on("#host", () => {
      saveName();
      this.host();
    });
    this.on("#join", () => {
      saveName();
      this.join();
    });
    this.on("#msim", () => this.setMode("sim"));
    this.on("#marc", () => this.setMode("arcade"));
    this.el.querySelectorAll<HTMLButtonElement>("[data-q]").forEach((b) =>
      b.addEventListener("click", () => {
        saveName();
        this.quality = b.dataset.q!;
        store.set("dg-quality", this.quality);
        this.home();
      }),
    );
  }

  private setMode(m: "sim" | "arcade") {
    store.set("dg-name", this.name());
    this.mode = m;
    store.set("dg-mode", m);
    this.home();
  }

  private local() {
    const me = this.name();
    this.frame(`
      <p>Take turns on this computer. Farthest from the basket throws next.</p>
      <div class="menu-players">${[me, "", "", ""].map((n, i) => `<input data-p="${i}" maxlength="16" placeholder="Player ${i + 1}${i > 1 ? " (optional)" : ""}" value="${esc(n)}">`).join("")}</div>
      <div class="menu-buttons row"><button id="back">Back</button><button class="primary" id="go">Start</button></div>`);
    this.on("#back", () => this.home());
    this.on("#go", () => {
      const names = [...this.el.querySelectorAll<HTMLInputElement>("[data-p]")].map((i) => i.value.trim());
      const players = names
        .map((n, i) => ({ n, i }))
        .filter(({ n, i }) => n || i < 2)
        .map(({ n, i }) => ({ id: `p${i}`, name: n || `Player ${i + 1}`, local: true }));
      this.finish(players);
    });
  }

  private lobby(title: string, players: NetPlayer[], extra: string) {
    this.frame(`
      <h2>${title}</h2>
      ${extra}
      <ol class="menu-lobby">${players.map((p) => `<li>${esc(p.name)}${p.id === this.net?.myId ? " <small>(you)</small>" : ""}</li>`).join("")}</ol>
      <div class="menu-buttons row"><button id="back">Leave</button>${this.net?.isHost ? `<button class="primary" id="go" ${players.length < 2 ? "disabled" : ""}>Start game</button>` : ""}</div>`);
    this.on("#back", () => {
      this.net?.close();
      this.net = null;
      this.home();
    });
    this.on("#go", () => this.net?.start());
  }

  private async host() {
    this.frame(`<p>Opening a room…</p>`);
    try {
      this.net = await Net.host(this.name());
    } catch (e) {
      this.status = (e as Error).message;
      this.home();
      return;
    }
    const net = this.net;
    const show = () => this.lobby("Your room", net.players, `<div class="menu-code">${net.code}</div><p>Friends open the game, choose <b>Join online game</b> and type this code. 2–4 players.</p>`);
    show();
    net.on((m) => {
        if (this.done) return;
      if (m.t === "lobby") show();
      if (m.t === "start") this.finishOnline(net);
    });
  }

  private join() {
    this.frame(`
      <label class="menu-field">Your name <input id="mname" maxlength="16" value="${esc(store.get("dg-name", ""))}" placeholder="Player"></label>
      <label class="menu-field">Room code <input id="mcode" maxlength="5" style="text-transform:uppercase;letter-spacing:.3em" placeholder="ABCDE"></label>
      <div class="menu-buttons row"><button id="back">Back</button><button class="primary" id="go">Join</button></div>`);
    this.on("#back", () => this.home());
    this.on("#go", async () => {
      const code = (this.el.querySelector<HTMLInputElement>("#mcode")?.value ?? "").trim().toUpperCase();
      if (code.length !== 5) {
        this.setStatus("The code has 5 letters");
        return;
      }
      store.set("dg-name", this.name());
      this.setStatus("Connecting…");
      try {
        this.net = await Net.join(code, this.name());
      } catch (e) {
        this.setStatus((e as Error).message);
        return;
      }
      this.status = "";
      const net = this.net;
      const show = () => this.lobby(`Room ${net.code}`, net.players, `<p>Waiting for the host to start…</p>`);
      show();
      net.on((m) => {
        if (this.done) return;
        if (m.t === "lobby") show();
        if (m.t === "start") this.finishOnline(net);
        if (m.t === "closed") {
          this.net = null;
          this.status = "The host closed the room";
          this.home();
        }
      });
    });
  }

  private finishOnline(net: Net) {
    this.finish(
      net.players.map((p) => ({ id: p.id, name: p.name, local: p.id === net.myId })),
      net,
    );
  }

  private finish(players: SeatInfo[], net: Net | null = null) {
    this.done = true;
    this.close();
    this.resolve({ players, net, mode: this.mode, quality: this.quality });
  }
}
