import React, { useEffect, useRef, useState } from "react";
import Game, { Brand } from "./Game.jsx";
import { FROG_COLORS } from "./game/engine.js";
import { Net } from "./net.js";

const DEFAULT_NAMES = ["Sárga", "Piros", "Kék", "Lila"];

function storedName() {
  try { return localStorage.getItem("ff-name") || ""; } catch { return ""; }
}
function storeName(name) {
  try { localStorage.setItem("ff-name", name); } catch { /* private mode */ }
}
function roomFromUrl() {
  return new URLSearchParams(location.search).get("room")?.toUpperCase() ?? "";
}

export default function App() {
  const [screen, setScreen] = useState(roomFromUrl() ? "online" : "menu");
  const [game, setGame] = useState(null);
  const [net, setNet] = useState(null);
  const [room, setRoom] = useState(null);
  const [error, setError] = useState("");
  const live = useRef({});
  live.current = { screen, room };

  // Room/lobby events while connected.
  useEffect(() => {
    if (!net) return;
    const offs = [
      net.on("joined", m => {
        setRoom({ code: m.code, you: m.you, hostId: m.hostId, players: m.players });
        setScreen("lobby");
        history.replaceState(null, "", `?room=${m.code}`);
      }),
      net.on("players", m => setRoom(r => r && { ...r, players: m.players, hostId: m.hostId })),
      net.on("error", m => setError(m.message)),
      net.on("fromHost", m => {
        if (m.data?.kind !== "start" || !live.current.room) return;
        setGame({ mode: "client", players: m.data.players, frogsPerPlayer: m.data.frogsPerPlayer, localPlayerId: live.current.room.you });
        setScreen("game");
      }),
      net.on("hostLeft", () => {
        if (live.current.screen !== "lobby") return;
        setError("A házigazda kilépett.");
        setScreen("online");
      }),
      net.on("close", () => {
        if (live.current.screen !== "lobby") return;
        setError("Megszakadt a kapcsolat a szerverrel.");
        setScreen("online");
      }),
    ];
    return () => offs.forEach(off => off());
  }, [net]);

  function disconnect() {
    net?.close();
    setNet(null);
    setRoom(null);
    history.replaceState(null, "", location.pathname);
  }
  function toMenu() {
    disconnect();
    setGame(null);
    setError("");
    setScreen("menu");
  }

  async function connect(action, name, code) {
    setError("");
    storeName(name);
    disconnect();
    const n = new Net();
    try {
      await n.ready;
    } catch (e) {
      setError(`${e.message} Az online játékhoz futnia kell a játékszervernek.`);
      return;
    }
    setNet(n);
    n.send(action === "create" ? { t: "create", name } : { t: "join", name, code });
  }

  function startOnline(frogsPerPlayer) {
    const players = room.players.map((p, i) => ({ id: p.id, name: p.name, color: i }));
    net.send({ t: "broadcast", lock: true, data: { kind: "start", players, frogsPerPlayer } });
    setGame({ mode: "host", players, frogsPerPlayer, localPlayerId: room.you });
    setScreen("game");
  }

  return (
    <div className="ff-app">
      {screen === "game" && game ? (
        <Game config={game} net={net} onExit={toMenu}/>
      ) : (
        <>
          <header className="ff-header">
            <Brand />
            <div className="ff-badge">3D · FIZIKAI ÜTKÖZÉSEK</div>
            <div className="ff-buttons">
              {screen !== "menu" && <button className="ff-btn" onClick={toMenu}>← Menü</button>}
            </div>
          </header>
          <main className="ff-game ff-menu-bg">
            <div className="ff-panel">
              {screen === "menu" && <Menu onSolo={() => {
                setGame({ mode: "local", players: [{ id: "solo", name: "Te", color: 0 }], frogsPerPlayer: 10, localPlayerId: null });
                setScreen("game");
              }} onLocal={() => setScreen("local")} onOnline={() => setScreen("online")}/>}
              {screen === "local" && <LocalSetup onStart={cfg => { setGame(cfg); setScreen("game"); }}/>}
              {screen === "online" && <OnlineSetup error={error} onConnect={connect}/>}
              {screen === "lobby" && room && <Lobby room={room} error={error} onStart={startOnline} onLeave={toMenu}/>}
            </div>
          </main>
        </>
      )}
    </div>
  );
}

function Menu({ onSolo, onLocal, onOnline }) {
  return (
    <>
      <div className="ff-eyebrow">● VÁLASSZ JÁTÉKMÓDOT</div>
      <h1 className="ff-panel-title">Ugorj.<br/>Pattanj. Kapaszkodj.</h1>
      <p className="ff-panel-text">Lőj békákat a forgó fára — és lökd le a többiekét!</p>
      <div className="ff-choices">
        <button className="ff-choice" onClick={onSolo}>
          <b>Egyjátékos</b><span>10 béka, a lehető legtöbbet a fára.</span>
        </button>
        <button className="ff-choice" onClick={onLocal}>
          <b>Helyi többjátékos</b><span>2–4 játékos, egy gépen, felváltva.</span>
        </button>
        <button className="ff-choice" onClick={onOnline}>
          <b>Online játék</b><span>Hozz létre szobát, és küldd el a kódot a barátaidnak.</span>
        </button>
      </div>
    </>
  );
}

function FrogCount({ value, onChange }) {
  return (
    <label className="ff-field">
      <span>Béka játékosonként</span>
      <select value={value} onChange={e => onChange(Number(e.target.value))}>
        {[3, 4, 5, 6, 8, 10].map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
}

function LocalSetup({ onStart }) {
  const [count, setCount] = useState(2);
  const [names, setNames] = useState(DEFAULT_NAMES);
  const [frogs, setFrogs] = useState(5);
  function start() {
    const players = names.slice(0, count).map((n, i) => ({
      id: `p${i}`, name: n.trim().slice(0, 16) || DEFAULT_NAMES[i], color: i,
    }));
    onStart({ mode: "local", players, frogsPerPlayer: frogs, localPlayerId: null });
  }
  return (
    <>
      <div className="ff-eyebrow">● HELYI TÖBBJÁTÉKOS</div>
      <h2 className="ff-panel-title">Ki játszik?</h2>
      <div className="ff-segment" role="group" aria-label="Játékosok száma">
        {[2, 3, 4].map(n => (
          <button key={n} className={n === count ? "is-on" : ""} onClick={() => setCount(n)}>{n} játékos</button>
        ))}
      </div>
      {names.slice(0, count).map((n, i) => (
        <label key={i} className="ff-field ff-colored" style={{ "--pc": FROG_COLORS[i].main }}>
          <span><i/>{FROG_COLORS[i].name} béka</span>
          <input value={n} maxLength={16} onChange={e => setNames(a => a.map((x, j) => j === i ? e.target.value : x))}/>
        </label>
      ))}
      <FrogCount value={frogs} onChange={setFrogs}/>
      <button className="ff-replay" onClick={start}>Indulhat a játék ↗</button>
    </>
  );
}

function OnlineSetup({ error, onConnect }) {
  const [name, setName] = useState(storedName());
  const [code, setCode] = useState(roomFromUrl());
  const [busy, setBusy] = useState(false);
  const cleanName = name.trim().slice(0, 16);
  async function go(action) {
    setBusy(true);
    await onConnect(action, cleanName, code.trim().toUpperCase());
    setBusy(false);
  }
  return (
    <>
      <div className="ff-eyebrow">● ONLINE JÁTÉK</div>
      <h2 className="ff-panel-title">Játssz a barátaiddal</h2>
      <label className="ff-field">
        <span>A neved</span>
        <input value={name} maxLength={16} placeholder="pl. Béka Bence" onChange={e => setName(e.target.value)}/>
      </label>
      <button className="ff-replay" disabled={!cleanName || busy} onClick={() => go("create")}>Új szoba létrehozása</button>
      <div className="ff-or">vagy csatlakozz egy szobához</div>
      <div className="ff-join">
        <input
          value={code} maxLength={4} placeholder="KÓD" aria-label="Szobakód"
          onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))}
        />
        <button className="ff-replay" disabled={!cleanName || code.length !== 4 || busy} onClick={() => go("join")}>Csatlakozás</button>
      </div>
      {error && <p className="ff-error">{error}</p>}
    </>
  );
}

function Lobby({ room, error, onStart, onLeave }) {
  const [frogs, setFrogs] = useState(5);
  const [copied, setCopied] = useState(false);
  const isHost = room.you === room.hostId;
  const link = `${location.origin}${location.pathname}?room=${room.code}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  }
  return (
    <>
      <div className="ff-eyebrow">● SZOBA</div>
      <div className="ff-code">{room.code}</div>
      <button className="ff-btn" onClick={copy}>{copied ? "Link kimásolva ✓" : "Meghívó link másolása"}</button>
      <ul className="ff-lobby">
        {room.players.map((p, i) => (
          <li key={p.id} style={{ "--pc": FROG_COLORS[i].main }}>
            <i/>{p.name}
            {p.id === room.hostId && <em>házigazda</em>}
            {p.id === room.you && <em>te</em>}
          </li>
        ))}
        {room.players.length < 4 && <li className="is-empty">Várakozás játékosokra… ({room.players.length}/4)</li>}
      </ul>
      {isHost ? (
        <>
          <FrogCount value={frogs} onChange={setFrogs}/>
          <button className="ff-replay" disabled={room.players.length < 2} onClick={() => onStart(frogs)}>
            {room.players.length < 2 ? "Legalább 2 játékos kell" : "Játék indítása ↗"}
          </button>
        </>
      ) : (
        <p className="ff-panel-text">A házigazda indítja a játékot.</p>
      )}
      {error && <p className="ff-error">{error}</p>}
      <button className="ff-link" onClick={onLeave}>Kilépés a szobából</button>
    </>
  );
}
