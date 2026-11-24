// Online rooms without a game server: browser-to-browser (WebRTC) data
// channels via PeerJS. Its free public broker only introduces the browsers;
// game messages then go directly between them. The host's browser is the hub:
// players connect to it with a 5-letter room code and it relays messages.
//
// A throw travels as its inputs (for the golfer's animation and the HUD) plus
// the finished flight from the thrower's browser: everyone plays back exactly
// that flight, so tiny floating-point differences between browsers can't make
// players' games drift apart.

import Peer, { type DataConnection } from "peerjs";
import type { FlightJson } from "./round";

export interface NetPlayer {
  id: string;
  name: string;
}

export type Msg =
  | { t: "hello"; name: string }
  | { t: "lobby"; players: NetPlayer[]; you: string }
  | { t: "start"; players: NetPlayer[] }
  | { t: "aim"; id: string; yaw: number; tech: string; disc: number; hyzer: number; line: number }
  | { t: "throw"; id: string; yaw: number; tech: string; disc: number; hyzer: number; line: number; power: number; deg: number; note?: string; flight: FlightJson }
  | { t: "left"; id: string }
  | { t: "closed" };

const PREFIX = "dgtour-";

// How browsers find a way to each other. STUN = learn your public address (free).
// TURN = a relay for networks that block direct connections (needs an account:
// set VITE_TURN_URL / VITE_TURN_USER / VITE_TURN_PASS at build time).
const env = import.meta.env;
const ICE: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
  ...(env.VITE_TURN_URL ? [{ urls: String(env.VITE_TURN_URL).split(","), username: env.VITE_TURN_USER, credential: env.VITE_TURN_PASS }] : []),
];
const newPeer = (id?: string) => (id ? new Peer(id, { config: { iceServers: ICE } }) : new Peer({ config: { iceServers: ICE } }));
/** The host's tab can lose the matchmaking link (sleep, background tab, Wi-Fi blip): get it back so friends can still find the room. */
function keepRegistered(peer: Peer) {
  peer.on("disconnected", () => {
    if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.disconnected && peer.reconnect(), 1000);
  });
}
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O: easy to read out loud

export class Net {
  players: NetPlayer[] = [];
  myId = "";
  started = false;
  private conns = new Map<string, DataConnection>(); // host: player id -> connection
  private hostConn: DataConnection | null = null; // client
  private handlers: ((m: Msg) => void)[] = [];

  private constructor(
    private peer: Peer,
    public isHost: boolean,
    public code: string,
  ) {}

  on(h: (m: Msg) => void) {
    this.handlers.push(h);
  }
  private emit(m: Msg) {
    for (const h of this.handlers) h(m);
  }

  /** Open a room; resolves with its code once the broker has registered it. */
  static async host(name: string): Promise<Net> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = Array.from({ length: 5 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");
      const peer = newPeer(PREFIX + code);
      // A taken code just means: roll another one. Anything else is a real failure.
      const ok = await new Promise<boolean>((res, rej) => {
        peer.on("open", () => res(true));
        peer.on("error", (e) => ((e as { type?: string }).type === "unavailable-id" ? res(false) : rej(new Error(`Couldn't open a room (${(e as Error).message})`))));
      });
      if (!ok) {
        peer.destroy();
        continue;
      }
      const net = new Net(peer, true, code);
      net.myId = "p0";
      net.players = [{ id: "p0", name }];
      peer.on("connection", (c) => net.accept(c));
      keepRegistered(peer);
      return net;
    }
    throw new Error("Couldn't find a free room code; try again");
  }

  /** Join a room by its code. */
  static async join(code: string, name: string): Promise<Net> {
    const peer = newPeer();
    await new Promise<void>((res, rej) => {
      peer.on("open", () => res());
      peer.on("error", (e) => rej(new Error(`Couldn't reach the matchmaking service (${(e as Error).message})`)));
    });
    const net = new Net(peer, false, code.toUpperCase());
    const conn = peer.connect(PREFIX + net.code, { reliable: true });
    net.hostConn = conn;
    await new Promise<void>((res, rej) => {
      // The broker knows the room but no connection opens: a network in between blocks it.
      const timer = setTimeout(
        () => rej(new Error("Found the room, but your networks can't connect directly. Try both on the same Wi-Fi, or one on a phone hotspot.")),
        15000,
      );
      peer.on("error", (e) => {
        clearTimeout(timer);
        rej(new Error((e as { type?: string }).type === "peer-unavailable" ? "No room with that code — check it, and keep the host's game open in front" : String((e as Error).message)));
      });
      conn.on("open", () => {
        clearTimeout(timer);
        res();
      });
    });
    const joined = new Promise<void>((res) => {
      conn.on("data", (d) => {
        const m = d as Msg;
        if (m.t === "lobby") {
          net.players = m.players;
          net.myId = m.you;
          res();
        }
        if (m.t === "start") {
          net.players = m.players;
          net.started = true;
        }
        net.emit(m);
      });
    });
    conn.on("close", () => net.emit({ t: "closed" }));
    conn.send({ t: "hello", name } satisfies Msg);
    await Promise.race([joined, new Promise((_, rej) => setTimeout(() => rej(new Error("The host didn't answer")), 9000))]);
    return net;
  }

  /** Host: a browser connected; it becomes a player once it says hello. */
  private accept(c: DataConnection) {
    let id = "";
    c.on("data", (d) => {
      const m = d as Msg;
      if (m.t === "hello") {
        if (this.started || this.players.length >= 4) {
          c.close();
          return;
        }
        let n = 1;
        while (this.players.some((p) => p.id === `p${n}`)) n++;
        id = `p${n}`;
        this.conns.set(id, c);
        this.players.push({ id, name: String(m.name).slice(0, 16) || `Player ${n + 1}` });
        this.sendLobby();
        return;
      }
      if (!id) return;
      // Relay to everyone else, and handle it here.
      for (const [pid, other] of this.conns) if (pid !== id && other.open) other.send(m);
      this.emit(m);
    });
    c.on("close", () => {
      if (!id) return;
      this.conns.delete(id);
      if (!this.started) {
        this.players = this.players.filter((p) => p.id !== id);
        this.sendLobby();
      } else {
        const msg: Msg = { t: "left", id };
        for (const other of this.conns.values()) if (other.open) other.send(msg);
        this.emit(msg);
      }
    });
  }

  private sendLobby() {
    for (const [pid, c] of this.conns) if (c.open) c.send({ t: "lobby", players: this.players, you: pid } satisfies Msg);
    this.emit({ t: "lobby", players: this.players, you: this.myId });
  }

  /** Host: lock the player list and start everyone's round. */
  start() {
    if (!this.isHost) return;
    this.started = true;
    this.send({ t: "start", players: this.players });
    this.emit({ t: "start", players: this.players });
  }

  /** Host: to everyone. Client: to the host, which passes it on. */
  send(m: Msg) {
    if (this.isHost) {
      for (const c of this.conns.values()) if (c.open) c.send(m);
    } else if (this.hostConn?.open) this.hostConn.send(m);
  }

  close() {
    this.peer.destroy();
  }
}
