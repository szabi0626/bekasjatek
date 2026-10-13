// Thin WebSocket client for the room relay server (see server/index.js).

export function serverUrl() {
  const configured = import.meta.env.VITE_SERVER_URL;
  if (configured) return configured;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

export class Net {
  constructor(url = serverUrl()) {
    this.handlers = new Map();
    this.closed = false;
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("A szerver nem érhető el.")), { once: true });
    });
    this.ws.addEventListener("message", ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && typeof msg.t === "string") this.emit(msg.t, msg);
    });
    this.ws.addEventListener("close", () => {
      if (!this.closed) this.emit("close", {});
    });
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, msg) {
    for (const fn of this.handlers.get(type) || []) fn(msg);
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.closed = true;
    this.handlers.clear();
    this.ws.close();
  }
}

// --- claude.ai Artifact transport --------------------------------------------
// When the game runs as a claude.ai Artifact, the platform's `room` capability
// replaces the WebSocket server. Everything travels in presence (which every
// viewer may set): each page publishes its own state, and the others react to
// changes. The message vocabulary seen by the app is the same as Net's.

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_PLAYERS = 4;
const HOST_GRACE_MS = 3000;
const JOIN_TIMEOUT_MS = 6000;

const randomId = () => Math.random().toString(36).slice(2, 10);
function newCode() {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}

export async function roomCapability() {
  if (!window.claude?.use) return null;
  try { return await window.claude.use("room"); } catch { return null; }
}

/**
 * Creates the transport for online play: the claude.ai room when available,
 * peer-to-peer WebRTC for static hosting (VITE_NET=peer, e.g. GitHub Pages),
 * else the WebSocket server in server/index.js.
 */
export async function createNet() {
  const room = await roomCapability();
  if (room) return new RoomNet(room);
  if (import.meta.env.VITE_NET === "peer") {
    const { PeerNet } = await import("./peernet.js");
    return new PeerNet();
  }
  return new Net();
}

export class RoomNet {
  constructor(room) {
    this.lobby = room;
    this.kind = "room";
    this.handlers = new Map();
    this.closed = false;
    this.ready = Promise.resolve();
    this.r = null;
    this.offs = [];
    this.me = { id: randomId() };
    this.joined = false;
    this.hostId = null;
    this.hostMissingSince = 0;
    this.lastPlayers = "";
    this.seen = new Map(); // peer id -> { aim, shot } counters already handled (host)
    this.lastStart = 0;
    this.lastState = 0;
    this.aimCount = 0;
    this.shotCount = 0;
    this.startCount = 0;
    this.stateCount = 0;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, msg) {
    if (this.closed) return;
    for (const fn of this.handlers.get(type) || []) fn(msg);
  }

  setPresence(patch) {
    Object.assign(this.me, patch);
    this.r?.presence(patch).catch(() => {});
  }

  send(msg) {
    if (this.closed) return;
    switch (msg.t) {
      case "create":
        this.open(newCode(), msg.name, true);
        break;
      case "join":
        this.open(String(msg.code || "").toUpperCase(), msg.name, false);
        break;
      case "leave":
        this.close();
        break;
      case "broadcast":
        if (msg.data?.kind === "start") this.setPresence({ start: { ...msg.data, e: ++this.startCount } });
        else if (msg.data?.kind === "state") this.setPresence({ s: { ...msg.data.s, n: ++this.stateCount } });
        break;
      case "toHost":
        if (msg.data?.kind === "aim") this.setPresence({ aim: { ...msg.data, k: ++this.aimCount } });
        else if (msg.data?.kind === "shoot") this.setPresence({ shot: { ...msg.data, k: ++this.shotCount } });
        break;
    }
  }

  async open(code, name, isHost) {
    this.code = code;
    this.isHost = isHost;
    try {
      this.r = await this.lobby.join(`ff-${code.toLowerCase()}`);
    } catch {
      this.emit("error", { message: "Nem sikerült csatlakozni a szobához. Próbáld újra." });
      return;
    }
    if (this.closed) return this.r.leave().catch(() => {});
    this.setPresence({ id: this.me.id, n: name, h: isHost ? 1 : 0, t: Date.now() });
    this.offs.push(this.r.onPeers(change => this.update(change.peers), () => this.emit("close", {})));
    if (isHost) {
      this.hostId = this.me.id;
      this.joined = true;
      this.emit("joined", { code, you: this.me.id, hostId: this.me.id, players: [{ id: this.me.id, name: this.me.n }] });
    } else {
      setTimeout(() => {
        if (this.joined || this.closed) return;
        this.emit("error", { message: "Nincs ilyen szoba, vagy a házigazda nincs online." });
        this.leaveRoom();
      }, JOIN_TIMEOUT_MS);
    }
  }

  players(peers) {
    const byId = new Map();
    for (const p of peers) {
      const pr = p.presence;
      if (typeof pr?.id !== "string" || typeof pr.n !== "string") continue;
      byId.set(pr.id, { id: pr.id, name: pr.n.slice(0, 16), t: Number(pr.t) || 0, host: pr.h === 1, presence: pr });
    }
    return [...byId.values()].sort((a, b) => (b.host - a.host) || a.t - b.t);
  }

  update(peers) {
    if (this.closed) return;
    const all = this.players(peers);
    const host = all.find(p => p.host);
    const start = host?.presence.start;

    if (!this.joined) {
      if (!host) return;
      const inStart = start?.players?.some(p => p.id === this.me.id);
      if (start && !inStart) {
        this.emit("error", { message: "Ebben a szobában már elindult a játék." });
        return this.leaveRoom();
      }
      if (all.findIndex(p => p.id === this.me.id) >= MAX_PLAYERS) {
        this.emit("error", { message: "A szoba megtelt (max. 4 játékos)." });
        return this.leaveRoom();
      }
      if (!all.some(p => p.id === this.me.id)) return;
      this.joined = true;
      this.hostId = host.id;
      this.emit("joined", { code: this.code, you: this.me.id, hostId: host.id, players: this.list(all) });
    }

    // Host presence: watch for it disappearing (allowing for brief reconnects).
    if (!this.isHost) {
      if (host && host.id === this.hostId) this.hostMissingSince = 0;
      else if (!this.hostMissingSince) {
        this.hostMissingSince = Date.now();
        setTimeout(() => {
          if (this.hostMissingSince && Date.now() - this.hostMissingSince >= HOST_GRACE_MS) this.emit("hostLeft", {});
        }, HOST_GRACE_MS + 50);
      }
    }

    const players = this.list(all);
    const key = JSON.stringify(players);
    if (key !== this.lastPlayers) {
      this.lastPlayers = key;
      this.emit("players", { players, hostId: this.hostId });
    }

    if (this.isHost) {
      for (const p of all) {
        if (p.id === this.me.id) continue;
        const seen = this.seen.get(p.id) || { aim: 0, shot: 0 };
        const { aim, shot } = p.presence;
        if (aim && aim.k > seen.aim) {
          seen.aim = aim.k;
          this.emit("fromPlayer", { from: p.id, data: { ...aim, kind: "aim" } });
        }
        if (shot && shot.k > seen.shot) {
          seen.shot = shot.k;
          this.emit("fromPlayer", { from: p.id, data: { ...shot, kind: "shoot" } });
        }
        this.seen.set(p.id, seen);
      }
    } else if (host && host.id === this.hostId) {
      if (start && start.e !== this.lastStart) {
        this.lastStart = start.e;
        this.emit("fromHost", { data: start });
      }
      const s = host.presence.s;
      if (s && s.n !== this.lastState) {
        this.lastState = s.n;
        this.emit("fromHost", { data: { kind: "state", s } });
      }
    }
  }

  // Players in the room: everyone in the started game, or the first four arrivals.
  list(all) {
    const start = all.find(p => p.host)?.presence.start;
    const chosen = start?.players
      ? all.filter(p => start.players.some(s => s.id === p.id))
      : all.slice(0, MAX_PLAYERS);
    return chosen.map(p => ({ id: p.id, name: p.name }));
  }

  leaveRoom() {
    this.offs.forEach(off => off());
    this.offs = [];
    this.r?.leave().catch(() => {});
    this.r = null;
  }

  close() {
    this.closed = true;
    this.handlers.clear();
    this.leaveRoom();
  }
}
