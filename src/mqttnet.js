// Online play through a free public MQTT broker (GitHub Pages: no game server).
// Every browser holds an ordinary WebSocket to the broker, so this works on any
// network that can open a web page, unlike direct WebRTC connections. The host's
// browser plays the relay server's role (see server/index.js): players publish to
// the room's "up" topic, the host answers on "down", and a retained "host" topic
// (cleared by the host's last will) tells players whether the room is open.
import mqtt from "mqtt";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_PLAYERS = 8;
const ROOT = "bekasjatek-ff/v1";
const JOIN_PATIENCE_MS = 60000;
const JOIN_RETRY_MS = 3000;
// How long players wait for a host whose connection dropped (e.g. a phone that switched apps).
const HOST_GRACE_MS = 20000;
const BROKERS = (import.meta.env.VITE_MQTT_URLS ||
  "wss://broker.emqx.io:8084/mqtt,wss://broker.hivemq.com:8884/mqtt,wss://test.mosquitto.org:8081/mqtt").split(",");

const randomId = () => Math.random().toString(36).slice(2, 10);
function newCode() {
  let code = "";
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}
function cleanName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, 16) || "Játékos";
}
function parse(payload) {
  try { return JSON.parse(payload.toString()); } catch { return null; }
}

export class MqttNet {
  constructor() {
    this.kind = "mqtt";
    this.maxPlayers = MAX_PLAYERS;
    this.handlers = new Map();
    this.closed = false;
    this.ready = Promise.resolve();
    this.cid = randomId();
    this.client = null;
    this.isHost = false;
    this.joined = false;
    // Host only: player id -> { id, name }, and who was in the game when it started.
    this.players = new Map();
    this.started = null;
    this.timers = [];
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

  topic(name) {
    return `${ROOT}/${this.code}/${name}`;
  }

  publish(name, msg, opts = {}) {
    this.client?.publish(this.topic(name), msg == null ? "" : JSON.stringify(msg), { qos: 0, ...opts });
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
      case "broadcast":
        if (!this.isHost) return;
        if (msg.lock) this.started = new Set(this.players.keys());
        this.publish("down", { t: "fromHost", data: msg.data }, { qos: msg.data?.kind === "state" ? 0 : 1 });
        break;
      case "toHost":
        if (this.joined) this.publish("up", { t: "toHost", cid: this.cid, data: msg.data }, { qos: msg.data?.kind === "shoot" ? 1 : 0 });
        break;
    }
  }

  // Tries the brokers in order; everyone uses the same order, so they meet on the first that works.
  connect(will, onConnect) {
    let index = 0;
    const attempt = () => {
      if (this.closed) return;
      const client = mqtt.connect(BROKERS[index], {
        clientId: `ff-${this.cid}-${randomId()}`,
        keepalive: 20,
        reconnectPeriod: 2000,
        connectTimeout: 7000,
        clean: true,
        will,
      });
      this.client = client;
      let connectedOnce = false;
      client.on("connect", () => {
        connectedOnce = true;
        onConnect(client);
      });
      client.on("message", (topic, payload) => this.onMessage(topic, payload));
      const giveUp = setTimeout(() => {
        if (connectedOnce || this.closed) return;
        client.end(true);
        index++;
        if (index < BROKERS.length) attempt();
        else this.emit("error", { message: "Nem sikerült elérni a játékszervert. Ellenőrizd az internetkapcsolatot, és próbáld újra." });
      }, 8000);
      this.timers.push(giveUp);
    };
    attempt();
  }

  // --- Host ---------------------------------------------------------------

  create(name) {
    this.code = newCode();
    this.isHost = true;
    this.players.set(this.cid, { id: this.cid, name: cleanName(name) });
    let announced = false;
    this.connect({ topic: this.topic("host"), payload: "", retain: true, qos: 1 }, client => {
      // (Re)announce the room after every (re)connect.
      client.subscribe(this.topic("up"), { qos: 1 });
      this.publish("host", { at: Date.now() }, { retain: true, qos: 1 });
      if (!announced) {
        announced = true;
        this.emit("joined", { code: this.code, you: this.cid, hostId: this.cid, players: this.list() });
        this.emit("players", { players: this.list(), hostId: this.cid });
      } else this.sendPlayers();
    });
  }

  hostMessage(msg) {
    const cid = typeof msg.cid === "string" ? msg.cid.slice(0, 16) : null;
    if (!cid || cid === this.cid) return;
    if (msg.t === "join") {
      const known = this.players.has(cid);
      const rejoin = this.started?.has(cid);
      if (!known && this.started && !rejoin) return this.reply(cid, "Ebben a szobában már elindult a játék.");
      if (!known && !rejoin && this.players.size >= MAX_PLAYERS) return this.reply(cid, "A szoba megtelt (max. 8 játékos).");
      const player = this.players.get(cid) || { id: cid, name: cleanName(msg.name) };
      this.players.set(cid, player);
      this.publish("down", { t: "joined", to: cid, code: this.code, you: cid, hostId: this.cid, players: this.list() }, { qos: 1 });
      if (!known) this.sendPlayers();
    } else if (msg.t === "leave") {
      if (this.players.delete(cid)) this.sendPlayers();
    } else if (msg.t === "toHost" && this.players.has(cid)) {
      this.emit("fromPlayer", { from: cid, data: msg.data });
    }
  }

  reply(cid, message) {
    this.publish("down", { t: "error", to: cid, message }, { qos: 1 });
  }

  list() {
    return [...this.players.values()].map(p => ({ id: p.id, name: p.name }));
  }

  sendPlayers() {
    const msg = { t: "players", players: this.list(), hostId: this.cid };
    this.publish("down", msg, { qos: 1 });
    this.emit("players", msg);
  }

  // --- Player -------------------------------------------------------------

  join(code, name) {
    this.code = code;
    this.name = name;
    this.hostPresent = false;
    const deadline = Date.now() + JOIN_PATIENCE_MS;
    const knock = () => {
      if (this.joined || this.closed) return;
      this.emit("notice", { message: this.waitingText() });
      if (Date.now() > deadline) {
        this.emit("error", { message: "Nincs ilyen szoba, vagy a házigazda nem érhető el. Ellenőrizd a kódot." });
        return this.close(true);
      }
      if (this.client?.connected) this.publish("up", { t: "join", cid: this.cid, name }, { qos: 1 });
      this.timers.push(setTimeout(knock, JOIN_RETRY_MS));
    };
    this.connect({ topic: this.topic("up"), payload: JSON.stringify({ t: "leave", cid: this.cid }), qos: 1 }, client => {
      client.subscribe([this.topic("down"), this.topic("host")], { qos: 1 }, () => {
        // After a reconnect, rejoin with the same id so the host restores this player.
        this.publish("up", { t: "join", cid: this.cid, name }, { qos: 1 });
      });
    });
    // Async, so the app has subscribed to notices by then.
    this.timers.push(setTimeout(() => this.emit("notice", { message: `Csatlakozás a(z) ${code} szobához…` }), 0));
    this.timers.push(setTimeout(knock, JOIN_RETRY_MS));
  }

  waitingText() {
    return this.hostPresent
      ? `Csatlakozás a(z) ${this.code} szobához…`
      : `Várakozás a házigazdára (${this.code})… Ha átváltott egy másik alkalmazásra, amint visszajön az oldalra, csatlakozol.`;
  }

  playerMessage(topic, payload) {
    if (topic === this.topic("host")) {
      const present = payload.length > 0;
      this.hostPresent = present;
      clearTimeout(this.hostGone);
      if (!present && this.joined) {
        this.hostGone = setTimeout(() => this.emit("hostLeft", {}), HOST_GRACE_MS);
      }
      if (!this.joined) this.emit("notice", { message: this.waitingText() });
      return;
    }
    const msg = parse(payload);
    if (!msg || typeof msg.t !== "string" || (msg.to && msg.to !== this.cid)) return;
    if (msg.t === "joined") {
      if (this.joined) return;
      this.joined = true;
      this.emit("notice", { message: "" });
    }
    if (msg.t === "error" && !this.joined) {
      this.emit("error", { message: msg.message });
      return this.close(true);
    }
    if (msg.t === "hostLeft") return this.emit("hostLeft", {});
    if (this.joined) this.emit(msg.t, msg);
  }

  onMessage(topic, payload) {
    if (this.closed) return;
    if (this.isHost) {
      const msg = parse(payload);
      if (msg && typeof msg.t === "string") this.hostMessage(msg);
    } else this.playerMessage(topic, payload);
  }

  close(keepHandlers = false) {
    this.timers.forEach(clearTimeout);
    clearTimeout(this.hostGone);
    const client = this.client;
    if (client) {
      if (this.isHost) {
        this.publish("down", { t: "hostLeft" }, { qos: 1 });
        this.publish("host", null, { retain: true, qos: 1 });
      } else if (this.joined) {
        this.publish("up", { t: "leave", cid: this.cid }, { qos: 1 });
      }
      client.end(false);
    }
    this.client = null;
    if (!keepHandlers) {
      this.closed = true;
      this.handlers.clear();
    }
  }
}
