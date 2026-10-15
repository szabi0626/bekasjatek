import React, { useEffect, useRef, useState } from "react";
import { createEngine, FROG_COLORS } from "./game/engine.js";
import { GUN_COOLDOWN, GRENADE_COOLDOWN } from "./game/sim.js";

const MODE_LABEL = {
  local: "HELYI JÁTÉK",
  host: "ONLINE · HÁZIGAZDA",
  client: "ONLINE",
};

// Icons for the special tiles (drawn inline, so they look the same everywhere).
const GunIcon = () => (
  <svg viewBox="0 0 48 32" width="46" height="31" aria-hidden="true">
    <rect x="3" y="11" width="30" height="9" rx="2" fill="#4a5a3f"/>
    <rect x="31" y="13" width="15" height="4" rx="1.5" fill="#33402c"/>
    <rect x="31" y="9" width="3" height="13" rx="1" fill="#33402c"/>
    <path d="M7 20h8l-3 9H5z" fill="#6b4f2e"/>
    <path d="M17 20h7v7a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2z" fill="#33402c"/>
    <rect x="1" y="12" width="5" height="7" rx="1.5" fill="#6b4f2e"/>
    <circle cx="40" cy="15" r="1.2" fill="#f3cc43"/>
    <path d="M20 6h7M22 3h5" stroke="#f3cc43" stroke-width="2" stroke-linecap="round"/>
  </svg>
);
const GrenadeIcon = () => (
  <svg viewBox="0 0 40 40" width="38" height="38" aria-hidden="true">
    <circle cx="18" cy="24" r="13" fill="#5c7a3a"/>
    <path d="M9 18h18M7 24h22M9 30h18M14 12v24M22 12v24" stroke="#46612b" stroke-width="2"/>
    <rect x="13" y="7" width="10" height="6" rx="1.5" fill="#4a5a3f"/>
    <path d="M23 9c5 0 8 2 9 7" stroke="#4a5a3f" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <circle cx="30" cy="5" r="3" fill="none" stroke="#9aa58a" stroke-width="2"/>
    <path d="M33 2l3-2M35 5h3M34 8l2 2" stroke="#f39a2b" stroke-width="2" stroke-linecap="round"/>
  </svg>
);

// Credits for the models a map uses (the Shrek model's CC BY licence asks for it).
const MODEL_CREDITS = {
  shrek: <>„Shrek” 3D-modell: <a href="https://sketchfab.com/3d-models/shrek-ee9fbba7e7a841dbb817cc6cec678355" target="_blank" rel="noreferrer">HarrisonHag1</a>, <a href="http://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></>,
  castle: <>Kastély: <a href="https://www.kenney.nl/assets/castle-kit" target="_blank" rel="noreferrer">Kenney Castle Kit</a> (CC0)</>,
};

// Real-time specials: keys 1 and 2 (or a click on their tile).
const SPECIALS = [
  { kind: "gun", hotkey: "1", icon: <GunIcon/>, label: "Gépágyú", detail: "15 béka sorozatban", total: GUN_COOLDOWN },
  { kind: "grenade", hotkey: "2", icon: <GrenadeIcon/>, label: "Gránát", detail: "Óriásbéka, robban", total: GRENADE_COOLDOWN },
];

function Special({ hotkey, icon, label, detail, total, left, locked, armed, onFire }) {
  const ready = (armed || !(left > 0)) && !locked;
  const charge = left > 0 ? 1 - Math.min(1, left / total) : 1;
  return (
    <button type="button" className={`ff-special${ready ? " is-ready" : ""}${armed ? " is-armed" : ""}`} onClick={onFire} disabled={!ready}
      aria-label={`${label} (${hotkey}-es gomb): ${ready ? "kész" : `${Math.ceil(left)} másodperc`}`}>
      <div className="ff-special-fill" style={{ height: `${charge * 100}%` }}/>
      <kbd>{hotkey}</kbd>
      <span className="ff-special-icon">{icon}</span>
      <span className="ff-special-text">
        <b>{label}</b>
        <small>{detail}</small>
      </span>
      <span className="ff-special-time">{armed ? "BETÖLTVE" : left > 0 ? `${Math.ceil(left)} s` : locked ? "—" : "KÉSZ"}</span>
    </button>
  );
}

export default function Game({ config, net, onExit }) {
  const mount = useRef(null);
  const engine = useRef(null);
  const [hud, setHud] = useState(null);
  const [help, setHelp] = useState(true);
  const [showDiag, setShowDiag] = useState(!!config.diag);

  // D toggles the connection/performance readout.
  useEffect(() => {
    const onKey = e => {
      if (e.key.toLowerCase() === "d" && !e.repeat && !e.ctrlKey && !e.metaKey) setShowDiag(x => !x);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Round trip to the game server, measured once a second while the readout is shown.
  const [ping, setPing] = useState(null);
  useEffect(() => {
    if (!showDiag || !net?.authoritative) return;
    const recent = [];
    const off = net.on("pong", m => {
      const rtt = performance.now() - m.c;
      if (!(rtt >= 0 && rtt < 60000)) return;
      recent.push(rtt);
      if (recent.length > 20) recent.shift();
      setPing({
        last: Math.round(rtt),
        avg: Math.round(recent.reduce((a, b) => a + b, 0) / recent.length),
        max: Math.round(Math.max(...recent)),
      });
    });
    const send = () => net.send({ t: "ping", c: performance.now() });
    send();
    const timer = setInterval(send, 1000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [showDiag, net]);
  const [notice, setNotice] = useState(null);
  // On the game server the room's owner (whoever created it, or the next player
  // after they leave) may start a new round.
  const [ownerId, setOwnerId] = useState(config.ownerId ?? null);

  useEffect(() => {
    const e = createEngine(mount.current, {
      ...config,
      onHud: h => (h.error ? setNotice(h.error) : setHud(h)),
      onSnapshot: s => net?.send({ t: "broadcast", data: { kind: "state", s } }),
      onInput: data => net?.send({ t: "toHost", data }),
    });
    engine.current = e;
    const offs = [];
    if (net && e) {
      offs.push(net.on("fromPlayer", m => e.remoteInput(m.from, m.data)));
      offs.push(net.on("fromHost", m => { if (m.data?.kind === "state") e.applySnapshot(m.data.s); }));
      offs.push(net.on("players", m => {
        e.setPresent(m.players.map(p => p.id));
        setOwnerId(m.hostId);
      }));
      offs.push(net.on("hostLeft", () => setNotice("A házigazda kilépett, a játék véget ért.")));
      offs.push(net.on("close", () => setNotice("Megszakadt a kapcsolat a szerverrel.")));
    }
    return () => {
      offs.forEach(off => off());
      e?.dispose();
      engine.current = null;
    };
  }, [config, net]);

  // A one-player diagnostic game on the server keeps the online (timed) layout.
  const solo = config.players.length === 1 && !config.diag;
  const serverGame = !!net?.authoritative;
  const canReset = config.mode !== "client" || (serverGame && ownerId === config.localPlayerId);
  const restart = () => (serverGame ? net.send({ t: "reset" }) : engine.current?.reset());
  const total = config.frogsPerPlayer;
  const players = hud?.players ?? [];
  const current = players[hud?.turn ?? 0];
  const me = players.find(p => p.id === config.localPlayerId);
  const ranking = [...players].sort((a, b) => b.score - a.score);
  const best = ranking[0]?.score ?? 0;
  const winners = ranking.filter(p => p.score === best && !p.left);

  const realtime = !!hud?.realtime;
  let powerLabel = "KILÖVÉS EREJE";
  if (realtime) {
    if (hud.countdown > 0) powerLabel = "KÉSZÜLJ…";
    else if (hud.armed) powerLabel = hud.armed === "grenade" ? "GRÁNÁT · TÖLTSD, ENGEDD EL" : "GÉPÁGYÚ · TÖLTSD, ENGEDD EL";
    else if (hud.charging) powerLabel = "KATAPULT TÖLTÉSE";
    else if (!hud.myTurn) powerLabel = "LEJÁRT AZ IDŐ";
    else if (!hud.ready) powerLabel = "ÚJRATÖLTÉS";
  } else if (hud?.charging) powerLabel = hud.myTurn ? "KATAPULT TÖLTÉSE" : `${current?.name ?? ""} TÖLT`;
  else if (hud && players.every(p => p.shotsLeft === 0 || p.left)) powerLabel = "BÉKÁK ELHELYEZKEDÉSE";
  else if (hud?.waiting || (hud && !hud.ready)) powerLabel = "ÚJRATÖLTÉS";
  else if (hud && !hud.myTurn) powerLabel = `${current?.name ?? ""} KÖVETKEZIK`;

  return (
    <>
      <header className="ff-header">
        <Brand />
        <div className="ff-badge">3D · FIZIKAI ÜTKÖZÉSEK</div>
        <div className="ff-buttons">
          <button className="ff-btn" onClick={() => setHelp(x => !x)} aria-pressed={help}>Útmutató</button>
          {canReset && <button className="ff-btn" onClick={restart}>↻ Új kör</button>}
          <button className="ff-btn" onClick={onExit}>Kilépés</button>
        </div>
      </header>

      <main className="ff-game">
        <div ref={mount} className="ff-canvas" aria-label="Békakatapult: egérrel célozz, a bal gombot tartsd nyomva, majd engedd el."/>
        <div className="ff-overlay">
          <div className="ff-title">
            <div className="ff-eyebrow">
              ● {solo ? "EGYJÁTÉKOS · SÁRGA CSAPAT" : `${MODE_LABEL[config.mode]}${config.realtime ? " · VALÓS IDEJŰ" : ""} · ${players.length} JÁTÉKOS`}
              {me && <> · TE: <span style={{ color: FROG_COLORS[me.color].dark }}>{me.name}</span></>}
            </div>
            <h1>Ugorj.<br/>Pattanj. Kapaszkodj.</h1>
            <p>Valódi ütközés. Forgó levelek.<br/>Csak a fán megmaradt békák számítanak.</p>
          </div>
          {solo ? (
            <div className="ff-stats">
              <div className="ff-stat"><span>A FÁN</span><b>{players[0]?.score ?? 0}</b><small>béka</small></div>
              <div className="ff-stat"><span>HÁTRALÉVŐ</span><b>{players[0]?.shotsLeft ?? total}</b><small>/{total}</small></div>
            </div>
          ) : (
            <div className="ff-players">
              {realtime && (
                <div className={`ff-timer${hud.timeLeft <= 10 && hud.timeLeft > 0 ? " is-low" : ""}`} aria-label="Hátralévő idő">
                  <span>IDŐ</span><b>{formatTime(hud.timeLeft)}</b>
                </div>
              )}
              {players.map((p, i) => (
                <div
                  key={p.id}
                  className={`ff-player${i === hud?.turn && !hud?.finished ? " is-turn" : ""}${p.left ? " is-left" : ""}`}
                  style={{ "--pc": FROG_COLORS[p.color].main, "--pd": FROG_COLORS[p.color].dark }}
                >
                  <span className="ff-player-name"><i/>{p.name}{p.id === config.localPlayerId ? " (te)" : ""}</span>
                  <b>{p.score}</b><small>a fán · {p.left ? "kilépett" : realtime ? `${p.shots} lövés` : `${p.shotsLeft} béka maradt`}</small>
                </div>
              ))}
            </div>
          )}
        </div>

        {help && !hud?.finished && (
          <aside className="ff-help">
            <h3>ÍGY JÁTSSZ</h3>
            <p><strong>↔ Mozgasd az egeret</strong>Vízszintesen és fel-le célozhatsz.</p>
            <p><strong>◉ Tartsd nyomva</strong>A bal gomb növeli a kilövés erejét.</p>
            <p><strong>↗ Engedd el</strong>A béka repül, ütközik és pattanhat.</p>
            <p className="ff-tip">
              {solo
                ? "A békák egymást is lelökhetik. A pontozáshoz legalább 0,7 másodpercig maradjanak a levélen."
                : realtime
                  ? "Mindenki egyszerre lő a saját katapultjából, amennyit csak tud, amíg le nem jár az idő. A végén a fán lévő békák számítanak."
                  : "Felváltva lőtök. Lökd le a többiek békáit! Csak a kör végén a fán lévő békák számítanak."}
            </p>
          </aside>
        )}

        {realtime && hud.countdown > 0 && !hud.finished && (
          <div className="ff-countdown" aria-live="assertive">{hud.countdown}</div>
        )}

        {showDiag && hud?.diagnostics && <Diagnostics d={hud.diagnostics} ping={ping}/>}

        <div className="ff-bottom">
          <div className="ff-status" role="status">{hud?.message ?? ""}</div>
          {hud?.specials && (
            <div className="ff-specials">
              {SPECIALS.map((s, k) => (
                <Special key={s.kind} {...s} left={hud.specials[k]} locked={hud.countdown > 0 || !hud.myTurn} armed={hud.armed === s.kind}
                  onFire={() => engine.current?.special(s.kind)}/>
              ))}
            </div>
          )}
          <div className="ff-power">
            <div className="ff-power-label">
              <span>{powerLabel}</span>
              <b>{hud?.charging ? `${Math.round(hud.power * 100)}%` : "—"}</b>
            </div>
            <div className="ff-track"><div className="ff-fill" style={{ width: `${hud?.charging ? hud.power * 100 : 0}%` }}/></div>
            <div className="ff-power-note">A pontozott ív az első ütközésig becsült röppálya.</div>
          </div>
        </div>

        {hud?.finished && (
          <div className="ff-end">
            <div className="ff-end-card">
              {solo ? (
                <>
                  <div style={{ fontSize: 36 }}>{best >= 7 ? "🏆" : "🌿"}</div>
                  <div className="ff-eyebrow" style={{ marginTop: 12 }}>KÖR VÉGE</div>
                  <h2>{best >= 7 ? "Békamester!" : best >= 4 ? "Szép ugrások!" : "Még egy próbát?"}</h2>
                  <p>Ennyi béka maradt meg<br/>a forgó fa levelein:</p>
                  <div className="ff-score">{best}<small> / {total}</small></div>
                  <p>A perem megfoghat, a lendület lesodorhat.<br/>Az időzítésen is múlik!</p>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 36 }}>🏆</div>
                  <div className="ff-eyebrow" style={{ marginTop: 12 }}>KÖR VÉGE</div>
                  <h2>{winners.length === 1 ? `${winners[0].name} nyert!` : "Döntetlen!"}</h2>
                  <ol className="ff-ranking">
                    {ranking.map(p => (
                      <li key={p.id} style={{ "--pc": FROG_COLORS[p.color].main }}>
                        <i/><span>{p.name}{p.left ? " (kilépett)" : ""}</span><b>{p.score}</b>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              {canReset
                ? <button className="ff-replay" onClick={restart}>Újra játszom ↗</button>
                : <p>Várakozás, amíg a házigazda új kört indít…</p>}
            </div>
          </div>
        )}

        {notice && (
          <div className="ff-end">
            <div className="ff-end-card">
              <h2>Hoppá!</h2>
              <p>{notice}</p>
              <button className="ff-replay" onClick={onExit}>Vissza a menübe</button>
            </div>
          </div>
        )}
      </main>

      <footer className="ff-footer">
        <span><strong>{solo ? `${total} béka.` : config.realtime ? `${players.length} játékos · ${config.duration ?? 60} mp, korlátlan béka` : `${players.length} játékos · ${total} béka fejenként`}</strong> Pattogás · súrlódás · forgás</span>
        <span>{canReset && !serverGame ? "R: új kör · " : ""}Esc: töltés megszakítása · D: diagnosztika · C: ütközők · F9 (menüben): diagnosztikai játék</span>
        {MODEL_CREDITS[config.map] && <span className="ff-credit">{MODEL_CREDITS[config.map]}</span>}
      </footer>
    </>
  );
}

function Diagnostics({ d, ping }) {
  const sv = d.server;
  const rows = [
    ["Képkocka/mp", d.fps],
    ["Mód", d.mode === "client" ? "online (szerver számol)" : d.mode === "host" ? "online (te számolsz)" : "helyi"],
    ["Békák a pályán", d.frogs],
  ];
  if (d.mode === "client") {
    rows.push(
      ["Ping", ping ? `${ping.last} ms` : "mérés…"],
      ["Ping átlag / max", ping ? `${ping.avg} / ${ping.max} ms` : "–"],
      // Your shot reaches the server (half a round trip), comes back in a snapshot
      // (the other half), then waits in the buffer before it is drawn.
      ["Becsült késés (lövés → látod)", ping ? `~${ping.avg + d.delayMs} ms` : "–"],
    );
    rows.push(
      ["Frissítés/mp", d.snapshotsPerSecond ?? "–"],
      ["Leghosszabb szünet", d.worstGapMs != null ? `${d.worstGapMs} ms` : "–"],
      ["Tartalék (késleltetés)", `${d.delayMs} ms`],
      ["Kifogyott képkockák", d.underruns],
    );
    if (sv) {
      rows.push(
        ["Szerver: munka/ütem", `${sv[0]} ms`],
        ["Szerver: leghosszabb ütemszünet", `${sv[1]} ms`],
        ["Szerver: lemaradás", `${sv[2]} ms`],
        ["Szerver: szobák", sv[3]],
      );
    }
  }
  return (
    <div className="ff-diag" role="status" aria-label="Diagnosztika">
      <b>DIAGNOSZTIKA</b> <small>(D: elrejtés)</small>
      {rows.map(([k, val]) => <div key={k}><span>{k}</span><span>{val}</span></div>)}
    </div>
  );
}

function formatTime(seconds = 0) {
  const t = Math.ceil(Math.max(0, seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function Brand() {
  return (
    <div className="ff-brand">
      <div className="ff-logo">
        <svg width="29" height="29" viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path d="M7 16C5 9 12 7 14 13H18C20 7 27 9 25 16C29 23 24 27 16 27S3 23 7 16Z" fill="currentColor"/>
          <circle cx="10" cy="13" r="2" fill="#355d3d"/>
          <circle cx="22" cy="13" r="2" fill="#355d3d"/>
          <path d="M11 21Q16 25 21 21" stroke="#355d3d" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>
      <div className="ff-name">flippin’ frogs<small>A LITTLE PLAYTIME</small></div>
    </div>
  );
}
