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
