// The game server: serves the built game (dist/) and runs every room's match.
// The physics and rules (src/game/sim.js) run here; browsers send aim/shoot
// input and draw the snapshots they get back 20 times a second.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createSim, physicsId, physicsReady } from "../src/game/sim.js";
import { mapId } from "../src/game/world.js";
import { loadModels } from "../src/game/models.js";

const PORT = Number(process.env.PORT) || 8080;
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const MAX_PLAYERS = 8;
// Frogs in play at once in real-time rounds; kept low for the free plan's 0.1 CPU.
const MAX_BODIES = Number(process.env.MAX_BODIES) || 40;
// 40 ticks a second, a snapshot every second tick (20 a second). Few wake-ups
// matter on a CPU-limited host, which pauses the process when it uses its share.
// On a host with CPU to spare, SNAPSHOT_EVERY=1 sends every tick for lower latency.
const TICK_MS = 25;
const SNAPSHOT_EVERY = Number(process.env.SNAPSHOT_EVERY) || 2;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
// Lobby chat: messages kept per room (sent to whoever joins later), their
// length, and the least time between two messages from one player.
const CHAT_KEEP = 50;
const CHAT_LENGTH = 200;
const CHAT_GAP_MS = 400;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/stats") {
    const usage = process.cpuUsage();
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify({
      rooms: rooms.size, uptimeS: Math.round(process.uptime()),
      cpuSecondsUsed: +((usage.user + usage.system) / 1e6).toFixed(1),
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
      games: stats.detail,
    }, null, 2));
    return;
  }
  if (url.pathname === "/healthz") {
    // Also lets a page on another host (GitHub Pages) wake a sleeping free-tier server.
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    res.end(`ok ${rooms.size} rooms`);
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { pathname = "/"; }
  let file = path.normalize(path.join(DIST, pathname));
  if (file !== DIST && !file.startsWith(DIST + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Nincs build. Futtasd: npm run build");
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(data);
  });
});

/** code -> { code, ownerId, players: Map<id, { id, name, ws }>, sim, timer, perf, chat, nextChat } */
const rooms = new Map();

// Server health, refreshed every second: [avg work per tick ms, worst tick gap ms,
// lag of the slowest room's clock behind real time ms, rooms]. Sent in snapshots
// (as "sv") for the in-game readout, and served at /stats.
const stats = { summary: [0, 0, 0, 0], detail: [] };
setInterval(() => {
  const detail = [];
  for (const room of rooms.values()) {
    if (!room.perf) continue;
    const p = room.perf;
    const avg = p.work.length ? p.work.reduce((a, b) => a + b, 0) / p.work.length : 0;
    const state = room.sim.state(true);
    // A finished round stops the simulation clock on purpose: measure from the next one.
    if (state.finished) {
      p.started = performance.now();
      p.simStart = state.t;
    }
    const realElapsed = (performance.now() - p.started) / 1000;
    const simElapsed = state.t - p.simStart;
    detail.push({
      code: room.code, players: room.players.size, frogs: state.b.length,
      workMs: +avg.toFixed(2), worstGapMs: Math.round(Math.max(0, ...p.gaps)),
      lagMs: Math.round(Math.max(0, realElapsed - simElapsed) * 1000),
    });
  }
  stats.detail = detail;
  stats.summary = [
    +Math.max(0, ...detail.map(d => d.workMs)).toFixed(1),
    Math.max(0, ...detail.map(d => d.worstGapMs)),
    Math.max(0, ...detail.map(d => d.lagMs)),
    rooms.size,
  ];
}, 1000).unref();

function newCode() {
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}
function cleanName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, 16) || "Játékos";
}
function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
}
function toAll(room, msg) {
  const text = JSON.stringify(msg);
  for (const p of room.players.values()) send(p.ws, text);
}
function playerList(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name }));
}
function sendPlayers(room) {
  toAll(room, { t: "players", players: playerList(room), hostId: room.ownerId });
}

// A chat line (from: a player's id, or null for a notice such as someone joining).
function chat(room, from, name, text) {
  const line = { id: room.nextChat++, from, name, text };
  room.chat.push(line);
  if (room.chat.length > CHAT_KEEP) room.chat.shift();
  toAll(room, { t: "chat", line });
}

function join(ws, room, name) {
  const player = { id: crypto.randomUUID().slice(0, 8), name: cleanName(name), ws };
  room.players.set(player.id, player);
  ws.player = player;
  ws.room = room;
  send(ws, { t: "joined", code: room.code, you: player.id, hostId: room.ownerId, players: playerList(room), chat: room.chat });
  sendPlayers(room);
  if (room.players.size > 1) chat(room, null, player.name, `${player.name} belépett.`);
  return player;
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.players.delete(ws.player.id);
  ws.room = null;
  if (room.players.size === 0) {
    clearInterval(room.timer);
    room.sim?.dispose();
    rooms.delete(room.code);
    return;
  }
  // The match goes on without them; the next player takes over the owner's buttons.
  if (ws.player.id === room.ownerId) room.ownerId = room.players.keys().next().value;
  room.sim?.setPresent([...room.players.keys()]);
  sendPlayers(room);
  chat(room, null, ws.player.name, `${ws.player.name} kilépett.`);
}

function start(room, settings) {
  const players = playerList(room).map((p, i) => ({ ...p, color: i }));
  const frogsPerPlayer = Math.min(10, Math.max(1, Math.round(Number(settings.frogsPerPlayer) || 5)));
  const realtime = !!settings.realtime;
  const duration = Math.min(300, Math.max(10, Math.round(Number(settings.duration) || 60)));
  const treeScale = Math.min(2, Math.max(1, Number(settings.treeScale) || 1));
  const reload = settings.reload == null ? undefined : Math.min(3, Math.max(0, Number(settings.reload) || 0));
  const map = mapId(settings.map);
  const physics = physicsId(settings.physics);
  room.sim = createSim({ players, frogsPerPlayer, realtime, duration, treeScale, reload, map, physics, maxBodies: MAX_BODIES });
  toAll(room, { t: "fromHost", data: { kind: "start", players, frogsPerPlayer, realtime, duration, treeScale, reload, map, physics } });
  let last = performance.now();
  let ticks = 0;
  room.perf = { work: [], gaps: [], lag: 0, started: last, simStart: room.sim.state().t };
  room.timer = setInterval(() => {
    const now = performance.now();
    room.perf.gaps.push(now - last);
    room.sim.advance((now - last) / 1000);
    last = now;
    if (++ticks % SNAPSHOT_EVERY === 0) {
      const s = room.sim.state(false, 1000);
      s.sv = stats.summary;
      toAll(room, { t: "fromHost", data: { kind: "state", s } });
    }
    room.perf.work.push(performance.now() - now);
    if (room.perf.work.length > 80) room.perf.work.shift();
    if (room.perf.gaps.length > 80) room.perf.gaps.shift();
  }, TICK_MS);
}

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });

wss.on("connection", ws => {
  ws.alive = true;
  ws.on("pong", () => { ws.alive = true; });
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;
    const room = ws.room;
    const isOwner = room && ws.player.id === room.ownerId;

    switch (msg.t) {
      case "create": {
        if (room) leave(ws);
        const created = { code: newCode(), ownerId: null, players: new Map(), sim: null, timer: null, chat: [], nextChat: 1 };
        rooms.set(created.code, created);
        created.ownerId = join(ws, created, msg.name).id;
        sendPlayers(created);
        break;
      }
      case "join": {
        const target = rooms.get(String(msg.code || "").toUpperCase().trim());
        if (!target) return send(ws, { t: "error", message: "Nincs ilyen szoba. Ellenőrizd a kódot." });
        if (target.sim) return send(ws, { t: "error", message: "Ebben a szobában már elindult a játék." });
        if (target.players.size >= MAX_PLAYERS) return send(ws, { t: "error", message: "A szoba megtelt (max. 8 játékos)." });
        if (room) leave(ws);
        join(ws, target, msg.name);
        break;
      }
      case "leave":
        leave(ws);
        break;
      case "chat": {
        if (!room) return;
        const text = String(msg.text || "").replace(/\s+/g, " ").trim().slice(0, CHAT_LENGTH);
        const now = Date.now();
        if (!text || now - (ws.lastChat || 0) < CHAT_GAP_MS) return;
        ws.lastChat = now;
        chat(room, ws.player.id, ws.player.name, text);
        break;
      }
      case "ping":
        // Round-trip measurement for the in-game readout: echo the client's clock.
        send(ws, { t: "pong", c: Number(msg.c) || 0 });
        break;
      case "start":
        if (isOwner && !room.sim) start(room, msg);
        break;
      case "reset":
        if (isOwner) room.sim?.reset();
        break;
      case "toHost": {
        if (!room?.sim) return;
        const i = room.sim.indexOf(ws.player.id);
        if (i >= 0) room.sim.input(i, msg.data);
        break;
      }
    }
  });
  ws.on("close", () => leave(ws));
});

// Drops dead connections and keeps proxies from closing idle sockets.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

await physicsReady;
// The models colliders are made from (the same files the browser loads).
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
await loadModels(file => fs.promises.readFile(path.join(PUBLIC, file)));
server.listen(PORT, () => {
  console.log(`Békajáték szerver: http://localhost:${PORT}`);
});
