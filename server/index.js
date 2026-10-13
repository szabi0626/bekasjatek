// Serves the built game (dist/) and relays messages between players in a room.
// The room's host runs the physics; this server only forwards messages.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8080;
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const MAX_PLAYERS = 4;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

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
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
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

/** code -> { code, hostId, started, players: Map<id, { id, name, ws }> } */
const rooms = new Map();

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
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function playerList(room) {
  return [...room.players.values()].map(p => ({ id: p.id, name: p.name }));
}
function sendPlayers(room) {
  const msg = { t: "players", players: playerList(room), hostId: room.hostId };
  for (const p of room.players.values()) send(p.ws, msg);
}

function join(ws, room, name) {
  const player = { id: crypto.randomUUID().slice(0, 8), name: cleanName(name), ws };
  room.players.set(player.id, player);
  ws.player = player;
  ws.room = room;
  send(ws, { t: "joined", code: room.code, you: player.id, hostId: room.hostId, players: playerList(room) });
  sendPlayers(room);
  return player;
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.players.delete(ws.player.id);
  ws.room = null;
  if (ws.player.id === room.hostId) {
    for (const p of room.players.values()) {
      send(p.ws, { t: "hostLeft" });
      p.ws.room = null;
    }
    rooms.delete(room.code);
  } else if (room.players.size === 0) {
    rooms.delete(room.code);
  } else {
    sendPlayers(room);
  }
}

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });

wss.on("connection", ws => {
  ws.alive = true;
  ws.on("pong", () => { ws.alive = true; });
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;
    const room = ws.room;

    switch (msg.t) {
      case "create": {
        if (room) leave(ws);
        const created = { code: newCode(), hostId: null, started: false, players: new Map() };
        rooms.set(created.code, created);
        const player = join(ws, created, msg.name);
        created.hostId = player.id;
        sendPlayers(created);
        break;
      }
      case "join": {
        const target = rooms.get(String(msg.code || "").toUpperCase().trim());
        if (!target) return send(ws, { t: "error", message: "Nincs ilyen szoba." });
        if (target.started) return send(ws, { t: "error", message: "Ebben a szobában már elindult a játék." });
        if (target.players.size >= MAX_PLAYERS) return send(ws, { t: "error", message: "A szoba megtelt (max. 4 játékos)." });
        if (room) leave(ws);
        join(ws, target, msg.name);
        break;
      }
      case "leave":
        leave(ws);
        break;
      // Host -> everyone else in the room.
      case "broadcast": {
        if (!room || ws.player.id !== room.hostId) return;
        if (msg.lock) room.started = true;
        const out = JSON.stringify({ t: "fromHost", data: msg.data });
        for (const p of room.players.values()) {
          if (p.id !== room.hostId && p.ws.readyState === p.ws.OPEN) p.ws.send(out);
        }
        break;
      }
      // Player -> host.
      case "toHost": {
        if (!room || ws.player.id === room.hostId) return;
        const hostPlayer = room.players.get(room.hostId);
        if (hostPlayer) send(hostPlayer.ws, { t: "fromPlayer", from: ws.player.id, data: msg.data });
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

server.listen(PORT, () => {
  console.log(`Békajáték szerver: http://localhost:${PORT}`);
});
