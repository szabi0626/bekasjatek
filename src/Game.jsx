import React, { useEffect, useRef, useState } from "react";
import { createEngine, FROG_COLORS } from "./game/engine.js";

const MODE_LABEL = {
  local: "HELYI JÁTÉK",
  host: "ONLINE · HÁZIGAZDA",
  client: "ONLINE",
};

export default function Game({ config, net, onExit }) {
  const mount = useRef(null);
  const engine = useRef(null);
  const [hud, setHud] = useState(null);
  const [help, setHelp] = useState(true);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    const e = createEngine(mount.current, {
      ...config,
      onHud: h => (h.error ? setNotice(h.error) : setHud(h)),
      onSnapshot: s => net?.send({ t: "broadcast", data: { kind: "state", s } }),
      onAim: a => net?.send({ t: "toHost", data: { kind: "aim", ...a } }),
      onShoot: s => net?.send({ t: "toHost", data: { kind: "shoot", ...s } }),
    });
    engine.current = e;
    const offs = [];
    if (net && e) {
      offs.push(net.on("fromPlayer", m => e.remoteInput(m.from, m.data)));
      offs.push(net.on("fromHost", m => { if (m.data?.kind === "state") e.applySnapshot(m.data.s); }));
      offs.push(net.on("players", m => e.setPresent(m.players.map(p => p.id))));
      offs.push(net.on("hostLeft", () => setNotice("A házigazda kilépett, a játék véget ért.")));
      offs.push(net.on("close", () => setNotice("Megszakadt a kapcsolat a szerverrel.")));
    }
    return () => {
      offs.forEach(off => off());
      e?.dispose();
      engine.current = null;
    };
  }, [config, net]);

  const solo = config.players.length === 1;
  const canReset = config.mode !== "client";
  const total = config.frogsPerPlayer;
  const players = hud?.players ?? [];
  const current = players[hud?.turn ?? 0];
  const me = players.find(p => p.id === config.localPlayerId);
  const ranking = [...players].sort((a, b) => b.score - a.score);
  const best = ranking[0]?.score ?? 0;
  const winners = ranking.filter(p => p.score === best && !p.left);

  let powerLabel = "KILÖVÉS EREJE";
  if (hud?.charging) powerLabel = hud.myTurn ? "KATAPULT TÖLTÉSE" : `${current?.name ?? ""} TÖLT`;
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
          {canReset && <button className="ff-btn" onClick={() => engine.current?.reset()}>↻ Új kör</button>}
          <button className="ff-btn" onClick={onExit}>Kilépés</button>
        </div>
      </header>

      <main className="ff-game">
        <div ref={mount} className="ff-canvas" aria-label="Békakatapult: egérrel célozz, a bal gombot tartsd nyomva, majd engedd el."/>
        <div className="ff-overlay">
          <div className="ff-title">
            <div className="ff-eyebrow">
              ● {solo ? "EGYJÁTÉKOS · SÁRGA CSAPAT" : `${MODE_LABEL[config.mode]} · ${players.length} JÁTÉKOS`}
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
              {players.map((p, i) => (
                <div
                  key={p.id}
                  className={`ff-player${i === hud?.turn && !hud?.finished ? " is-turn" : ""}${p.left ? " is-left" : ""}`}
                  style={{ "--pc": FROG_COLORS[p.color].main, "--pd": FROG_COLORS[p.color].dark }}
                >
                  <span className="ff-player-name"><i/>{p.name}{p.id === config.localPlayerId ? " (te)" : ""}</span>
                  <b>{p.score}</b><small>a fán · {p.left ? "kilépett" : `${p.shotsLeft} béka maradt`}</small>
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
                : "Felváltva lőtök. Lökd le a többiek békáit! Csak a kör végén a fán lévő békák számítanak."}
            </p>
          </aside>
        )}

        <div className="ff-bottom">
          <div className="ff-status" role="status">{hud?.message ?? ""}</div>
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
                ? <button className="ff-replay" onClick={() => engine.current?.reset()}>Újra játszom ↗</button>
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
        <span><strong>{solo ? `${total} béka. 4 levél.` : `${players.length} játékos · ${total} béka fejenként`}</strong> Pattogás · súrlódás · forgás</span>
        <span>{canReset ? "R: új kör · " : ""}Esc: töltés megszakítása</span>
      </footer>
    </>
  );
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
