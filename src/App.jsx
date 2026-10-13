import React, { useEffect, useRef, useState } from "react";
import Game, { Brand } from "./Game.jsx";
import { FROG_COLORS } from "./game/engine.js";
import { TREE_SIZES } from "./game/world.js";
import { createNet } from "./net.js";

const DEFAULT_NAMES = FROG_COLORS.map(c => c.name);
const DEFAULT_TREE = 1.3;

function storedTree() {
  try { return Number(localStorage.getItem("ff-tree")) || DEFAULT_TREE; } catch { return DEFAULT_TREE; }
}
function storeTree(scale) {
  try { localStorage.setItem("ff-tree", String(scale)); } catch { /* private mode */ }
}

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
  const [notice, setNotice] = useState("");
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
      net.on("error", m => { setNotice(""); setError(m.message); }),
      net.on("notice", m => setNotice(m.message)),
      net.on("fromHost", m => {
        if (m.data?.kind !== "start" || !live.current.room) return;
        setGame({
          mode: "client", players: m.data.players, frogsPerPlayer: m.data.frogsPerPlayer,
          realtime: !!m.data.realtime, duration: m.data.duration, treeScale: m.data.treeScale,
          localPlayerId: live.current.room.you, ownerId: live.current.room.hostId,
        });
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
    setNotice("");
    storeName(name);
    disconnect();
    let n;
    // A sleeping free-tier server can take up to a minute to wake.
    const slow = setTimeout(() => setNotice("A játékszerver ébred, ez fél–egy percig is tarthat…"), 2500);
    try {
      n = await createNet();
      await n.ready;
    } catch (e) {
      clearTimeout(slow);
      setNotice("");
      setError(`${e.message} Próbáld újra egy kicsit később.`);
      return;
    }
    clearTimeout(slow);
    setNotice("");
    setNet(n);
    n.send(action === "create" ? { t: "create", name } : { t: "join", name, code });
  }

  function startOnline(frogsPerPlayer, realtime, duration, treeScale) {
    // The game server starts the match and tells everyone, this player included.
    if (net.authoritative) return net.send({ t: "start", frogsPerPlayer, realtime, duration, treeScale });
    const players = room.players.map((p, i) => ({ id: p.id, name: p.name, color: i }));
    net.send({ t: "broadcast", lock: true, data: { kind: "start", players, frogsPerPlayer, realtime, duration, treeScale } });
    setGame({ mode: "host", players, frogsPerPlayer, realtime, duration, treeScale, localPlayerId: room.you });
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
              {screen === "menu" && <Menu onSolo={treeScale => {
                setGame({ mode: "local", players: [{ id: "solo", name: "Te", color: 0 }], frogsPerPlayer: 10, treeScale, localPlayerId: null });
                setScreen("game");
              }} onLocal={() => setScreen("local")} onOnline={() => setScreen("online")}/>}
              {screen === "local" && <LocalSetup onStart={cfg => { setGame(cfg); setScreen("game"); }}/>}
              {screen === "online" && <OnlineSetup error={error} notice={notice} onConnect={connect}/>}
              {screen === "lobby" && room && <Lobby room={room} error={error} authoritative={!!net?.authoritative} maxPlayers={net?.maxPlayers ?? 8} onStart={startOnline} onLeave={toMenu}/>}
            </div>
          </main>
        </>
      )}
    </div>
  );
}

function TreeSize({ value, onChange }) {
  return (
    <div className="ff-field">
      <span>A fa mérete</span>
      <div className="ff-segment" role="group" aria-label="A fa mérete">
        {TREE_SIZES.map(t => (
          <button key={t.scale} className={t.scale === value ? "is-on" : ""} onClick={() => { storeTree(t.scale); onChange(t.scale); }}>
            {t.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function Menu({ onSolo, onLocal, onOnline }) {
  const [tree, setTree] = useState(storedTree);
  return (
    <>
      <div className="ff-eyebrow">● VÁLASSZ JÁTÉKMÓDOT</div>
      <h1 className="ff-panel-title">Ugorj.<br/>Pattanj. Kapaszkodj.</h1>
      <p className="ff-panel-text">Lőj békákat a forgó fára — és lökd le a többiekét!</p>
      <div className="ff-choices">
        <button className="ff-choice" onClick={() => onSolo(tree)}>
          <b>Egyjátékos</b><span>10 béka, a lehető legtöbbet a fára.</span>
        </button>
        <button className="ff-choice" onClick={onLocal}>
          <b>Helyi többjátékos</b><span>2–8 játékos, egy gépen, felváltva, a fa körül.</span>
        </button>
        <button className="ff-choice" onClick={onOnline}>
          <b>Online játék</b><span>2–8 játékos a fa körül. Hozz létre szobát, és küldd el a kódot.</span>
        </button>
      </div>
      <TreeSize value={tree} onChange={setTree}/>
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
  const [tree, setTree] = useState(storedTree);
  function start() {
    const players = names.slice(0, count).map((n, i) => ({
      id: `p${i}`, name: n.trim().slice(0, 16) || DEFAULT_NAMES[i], color: i,
    }));
    onStart({ mode: "local", players, frogsPerPlayer: frogs, treeScale: tree, localPlayerId: null });
  }
  return (
    <>
      <div className="ff-eyebrow">● HELYI TÖBBJÁTÉKOS</div>
      <h2 className="ff-panel-title">Ki játszik?</h2>
      <label className="ff-field">
        <span>Játékosok száma</span>
        <select id="ff-count" value={count} onChange={e => setCount(Number(e.target.value))}>
          {[2, 3, 4, 5, 6, 7, 8].map(n => <option key={n} value={n}>{n} játékos</option>)}
        </select>
      </label>
      {names.slice(0, count).map((n, i) => (
        <label key={i} className="ff-field ff-colored" style={{ "--pc": FROG_COLORS[i].main }}>
          <span><i/>{FROG_COLORS[i].name} béka</span>
          <input value={n} maxLength={16} onChange={e => setNames(a => a.map((x, j) => j === i ? e.target.value : x))}/>
        </label>
      ))}
      <FrogCount value={frogs} onChange={setFrogs}/>
      <TreeSize value={tree} onChange={setTree}/>
      <button className="ff-replay" onClick={start}>Indulhat a játék ↗</button>
    </>
  );
}

function OnlineSetup({ error, notice, onConnect }) {
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
      {notice && !error && <p className="ff-notice" role="status">{notice}</p>}
      {error && <p className="ff-error">{error}</p>}
    </>
  );
}

function Lobby({ room, error, authoritative, maxPlayers, onStart, onLeave }) {
  const [frogs, setFrogs] = useState(5);
  const [realtime, setRealtime] = useState(true);
  const [duration, setDuration] = useState(60);
  const [tree, setTree] = useState(storedTree);
  const [copied, setCopied] = useState(false);
  const isHost = room.you === room.hostId;
  // Inside claude.ai the query string does not reach the page, so share the code instead.
  const inArtifact = !!window.claude;
  const link = inArtifact ? room.code : `${location.origin}${location.pathname}?room=${room.code}`;
  const canShare = !inArtifact && typeof navigator.share === "function";
  async function share() {
    try {
      await navigator.share({ title: "Flippin' frogs", text: `Gyere békázni! Szobakód: ${room.code}`, url: link });
    } catch { /* dismissed */ }
  }
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
      <div className="ff-share">
        <button className="ff-btn" onClick={copy}>{copied ? "Kimásolva ✓" : inArtifact ? "Kód másolása" : "Meghívó link másolása"}</button>
        {canShare && <button className="ff-btn" onClick={share}>Meghívó küldése…</button>}
      </div>
      {isHost && !inArtifact && !authoritative && (
        <p className="ff-notice">
          Tartsd nyitva ezt az oldalt, amíg mindenki be nem lép. Ha telefonon átváltasz egy másik
          alkalmazásra, addig senki nem tud csatlakozni. Visszatérés után a többiek automatikusan bejutnak.
        </p>
      )}
      <ul className="ff-lobby">
        {room.players.map((p, i) => (
          <li key={p.id} style={{ "--pc": FROG_COLORS[i].main }}>
            <i/>{p.name}
            {p.id === room.hostId && <em>házigazda</em>}
            {p.id === room.you && <em>te</em>}
          </li>
        ))}
        {room.players.length < maxPlayers && <li className="is-empty">Várakozás játékosokra… ({room.players.length}/{maxPlayers})</li>}
      </ul>
      {isHost ? (
        <>
          <div className="ff-segment" role="group" aria-label="Játékmód">
            <button className={realtime ? "is-on" : ""} onClick={() => setRealtime(true)}>Valós idejű</button>
            <button className={!realtime ? "is-on" : ""} onClick={() => setRealtime(false)}>Felváltva</button>
          </div>
          <p className="ff-panel-text">
            {realtime
              ? "Mindenki egyszerre lő a saját katapultjából, amennyit csak tud, amíg le nem jár az idő."
              : "Egymás után lőtök, egy katapultból."}
          </p>
          {realtime ? (
            <label className="ff-field">
              <span>Játékidő</span>
              <select id="ff-duration" value={duration} onChange={e => setDuration(Number(e.target.value))}>
                {[30, 60, 90, 120].map(n => <option key={n} value={n}>{n} másodperc</option>)}
              </select>
            </label>
          ) : (
            <FrogCount value={frogs} onChange={setFrogs}/>
          )}
          <TreeSize value={tree} onChange={setTree}/>
          <button className="ff-replay" disabled={room.players.length < 2} onClick={() => onStart(frogs, realtime, duration, tree)}>
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
