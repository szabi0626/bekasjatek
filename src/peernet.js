// Peer-to-peer transport for static hosting (GitHub Pages): no game server.
// The host's browser plays the relay server's role (see server/index.js): it
// registers a peer id derived from the room code, players connect straight to
// it over WebRTC data channels, and it forwards messages. The PeerJS broker
// is only used to set up the connections.
import { Peer } from "peerjs";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_PLAYERS = 4;
const PREFIX = "bekasjatek-ff-";

function newCode() {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}
function cleanName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, 16) || "Játékos";
}
function peerOptions() {
  const env = import.meta.env;
  const options = { debug: 0 };
  // Optional self-hosted PeerJS server; defaults to the free public broker.
  if (env.VITE_PEER_HOST) {
    options.host = env.VITE_PEER_HOST;
    options.port = Number(env.VITE_PEER_PORT) || 443;
    options.path = env.VITE_PEER_PATH || "/";
    options.secure = env.VITE_PEER_SECURE !== "false";
  }
  return options;
}

export class PeerNet {
  constructor() {
    this.kind = "peer";
    this.handlers = new Map();
    this.closed = false;
    this.ready = Promise.resolve();
    this.peer = null;
    this.isHost = false;
    // Host only: player id -> { id, name, conn } (the host itself has no conn).
    this.players = new Map();
    this.started = false;
    this.conn = null;
    this.you = null;
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

  send(msg) {
    if (this.closed) return;
    switch (msg.t) {
      case "create":
        this.create(msg.name);
        break;
      case "join":
        this.join(String(msg.code || "").toUpperCase(), msg.name);
        break;
      case "leave":
        this.close();
        break;
      case "broadcast": {
        if (!this.isHost) return;
        if (msg.lock) this.started = true;
        const out = { t: "fromHost", data: msg.data };
        for (const p of this.players.values()) if (p.conn?.open) p.conn.send(out);
        break;
      }
      case "toHost":
        if (this.conn?.open) this.conn.send({ t: "toHost", data: msg.data });
        break;
    }
  }

  // --- Host ---------------------------------------------------------------

  create(name, attempt = 0) {
    const code = newCode();
    const peer = new Peer(PREFIX + code, peerOptions());
    this.peer = peer;
    peer.on("open", () => {
      if (this.closed) return peer.destroy();
      this.isHost = true;
      this.code = code;
      this.you = "host";
      this.players.set("host", { id: "host", name: cleanName(name), conn: null });
      this.emit("joined", { code, you: "host", hostId: "host", players: this.list() });
      this.sendPlayers();
    });
    peer.on("connection", conn => this.accept(conn));
    peer.on("error", err => {
      if (err.type === "unavailable-id" && attempt < 5) {
        peer.destroy();
        this.create(name, attempt + 1);
      } else if (!this.code) {
        this.emit("error", { message: "Nem sikerült elérni a kapcsolódási szervert. Próbáld újra pár másodperc múlva." });
      }
    });
    peer.on("disconnected", () => {
      // Lost the broker only: existing games keep running; reconnect so new players can join.
      if (!this.closed && !peer.destroyed) peer.reconnect();
    });
  }

  accept(conn) {
    let player = null;
    conn.on("data", msg => {
      if (!msg || typeof msg.t !== "string") return;
      if (msg.t === "join" && !player) {
        if (this.started) return this.refuse(conn, "Ebben a szobában már elindult a játék.");
        if (this.players.size >= MAX_PLAYERS) return this.refuse(conn, "A szoba megtelt (max. 4 játékos).");
        player = { id: conn.peer.slice(-8) + Math.random().toString(36).slice(2, 6), name: cleanName(msg.name), conn };
        this.players.set(player.id, player);
        conn.send({ t: "joined", code: this.code, you: player.id, hostId: "host", players: this.list() });
        this.sendPlayers();
      } else if (msg.t === "toHost" && player) {
        this.emit("fromPlayer", { from: player.id, data: msg.data });
      }
    });
    conn.on("close", () => {
      if (player && this.players.delete(player.id)) this.sendPlayers();
    });
    conn.on("error", () => conn.close());
  }

  refuse(conn, message) {
    conn.send({ t: "error", message });
    setTimeout(() => conn.close(), 300);
  }

  list() {
    return [...this.players.values()].map(p => ({ id: p.id, name: p.name }));
  }

  sendPlayers() {
    const msg = { t: "players", players: this.list(), hostId: "host" };
    for (const p of this.players.values()) if (p.conn?.open) p.conn.send(msg);
    this.emit("players", msg);
  }

  // --- Player -------------------------------------------------------------

  join(code, name) {
    const peer = new Peer(peerOptions());
    this.peer = peer;
    let joined = false;
    const fail = message => {
      if (joined || this.closed) return;
      this.emit("error", { message });
      this.close(true);
    };
    const timer = setTimeout(() => fail("Nem sikerült csatlakozni. Ellenőrizd a kódot, vagy próbáld újra."), 15000);
    peer.on("open", () => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: "json" });
      this.conn = conn;
      conn.on("open", () => conn.send({ t: "join", name }));
      conn.on("data", msg => {
        if (!msg || typeof msg.t !== "string") return;
        if (msg.t === "joined") {
          joined = true;
          clearTimeout(timer);
          this.you = msg.you;
        }
        if (msg.t === "error") {
          clearTimeout(timer);
          return fail(msg.message);
        }
        this.emit(msg.t, msg);
      });
      conn.on("close", () => {
        clearTimeout(timer);
        if (joined) this.emit("hostLeft", {});
        else fail("A kapcsolat megszakadt csatlakozás közben.");
      });
    });
    peer.on("error", err => {
      clearTimeout(timer);
      if (err.type === "peer-unavailable") fail("Nincs ilyen szoba, vagy a házigazda már kilépett.");
      else if (!joined) fail("Nem sikerült kapcsolódni. Lehet, hogy a hálózatod tiltja a közvetlen kapcsolatot.");
    });
  }

  close(keepHandlers = false) {
    this.conn?.close();
    this.peer?.destroy();
    this.peer = null;
    if (!keepHandlers) {
      this.closed = true;
      this.handlers.clear();
    }
  }
}
