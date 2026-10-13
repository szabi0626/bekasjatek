# Békajáték – flippin' frogs 🐸

3D-s ügyességi játék: lőj békákat a forgó fára, és próbáld meg, hogy minél több fent is maradjon. A társaid békáit pedig lökd le! Három játékmódja van:

- **Egyjátékos**: 10 béka; az a jó, ha minél több marad a fán.
- **Helyi többjátékos**: 2–4 játékos egy gépen, felváltva lőtök.
- **Online játék**: szobát hozol létre, és elküldöd a 4 betűs kódot (vagy a meghívó linket) a barátaidnak. Kétféle mód van: **valós idejű** (mindenki egyszerre lő a saját színű katapultjából, amennyit csak tud, amíg le nem jár az idő; 30–120 mp) vagy **felváltva** (fix számú béka fejenként).

## Futtatás a saját gépeden

Kell hozzá [Node.js](https://nodejs.org) 20 vagy újabb.

```bash
npm install
npm run build
npm start          # http://localhost:8080 – a játék és az online szerver együtt
```

Fejlesztés közben, automatikus újratöltéssel:

```bash
npm run dev:server   # játékszerver a 8080-as porton
npm run dev          # játék a http://localhost:5173 címen
```

## Kitétel az internetre

### A) Render.com: játékszerverrel (ez fut most: https://bekasjatek.onrender.com)

Itt a meccseket a szerver futtatja, így senkinek a gépe nem „házigazda”. Ha valaki kilép, a többiek tovább játszanak. Az ingyenes csomag elég.

1. Regisztrálj a [render.com](https://render.com) oldalon a GitHub-fiókoddal.
2. **New → Blueprint**, majd válaszd ki a `bekasjatek` repót. A `render.yaml` minden beállítást tartalmaz, csak jóvá kell hagyni.
3. Pár perc múlva kapsz egy címet, például `https://bekasjatek.onrender.com`. Ezt a linket küldheted a barátaidnak, ott a játék és a szerver is fut.

Az ingyenes szerver 15 perc tétlenség után elalszik. Az első megnyitás ilyenkor fél–egy percig tart, a játék ezt ki is írja.

A GitHub Pages-es oldal is ezt a szervert használja (`wss://bekasjatek.onrender.com/ws`). Ha máshol fut a szerver, a repó **Settings → Secrets and variables → Actions → Variables** menüjében egy `SERVER_URL` változóval átállítható.

### B) GitHub Pages: szerver nélkül

A `main` ágra pusholt változások automatikusan kikerülnek a https://szabi0626.github.io/bekasjatek/ címre, és ott is a Render-es játékszerver fut. Ha a build `VITE_SERVER_URL` nélkül, `VITE_NET=mqtt` beállítással készül, az online mód egy ingyenes, nyilvános MQTT üzenetközvetítőn megy (EMQX, HiveMQ vagy Mosquitto, amelyik elérhető). Ilyenkor a szobát létrehozó játékos böngészője számolja a meccset.

### C) claude.ai

https://claude.ai/artifact/QSRF8aic3kmvhtquU7L1d4 – itt a claude.ai saját valós idejű csatornája köti össze a játékosokat. A barátaidat a **Share** menüben hívhatod meg, és nekik is claude.ai-fiók kell. Frissítés: `npm run build && node scripts/build-artifact.mjs`, majd az `artifact/flippin-frogs.html` újbóli közzététele.

## Hogyan működik az online mód?

```
 játékosok böngészői  ── célzás, lövés ──►  játékszerver (server/index.js)
   (csak rajzolnak)   ◄── állapot 20×/mp ──  (fizika és szabályok: src/game/sim.js)
```

- A fizika és a szabályok (`src/game/sim.js`) böngésző nélkül is futnak. Online a szerver számol, helyi játéknál a böngésző.
- A böngészők a célzást és a lövést küldik. A szerver ellenőrzi, hogy az adott játékos lőhet-e: valós idejű módban lejárt-e a saját újratöltése, felváltva módban ő következik-e.
- A szerver másodpercenként 20-szor elküldi az állást, a böngészők ezek között simán mozgatják a békákat.
- Ha valaki kilép, a meccs megy tovább. A szoba gombjait (indítás, új kör) a következő játékos örökli.
- Szerver nélküli módokban (MQTT, claude.ai) ugyanez a szimuláció a szobát létrehozó játékos böngészőjében fut.

## Projektszerkezet

| Fájl | Mire való |
|---|---|
| `src/game/sim.js` | Játékszabályok és fizika (ütközések, súrlódás, forgó fa); szerveren és böngészőben is fut |
| `src/game/world.js` | A pálya: színpad, fa, levelek, békák (a szerver csak az ütközőfelületeket építi meg) |
| `src/game/engine.js` | Kirajzolás és irányítás a böngészőben |
| `src/Game.jsx` | Játék közbeni felület: pontok, erőmérő, kör vége |
| `src/App.jsx` | Menü, helyi beállítások, online szoba és váró |
| `src/net.js`, `src/mqttnet.js` | Hálózat: játékszerver (WebSocket), MQTT, illetve claude.ai-on a `room` csatorna |
| `server/index.js` | Játékszerver: kiszolgálja az oldalt, kezeli a szobákat, és futtatja a meccseket |
| `render.yaml`, `.github/workflows/pages.yml`, `scripts/build-artifact.mjs` | Telepítési beállítások, egyfájlos build a claude.ai-hoz |

## Ötletek a továbbfejlesztéshez

- Hangok (lövés, csobbanás, ütközés) és rezgés mobilon
- Különleges békák: nehéz béka, ragacsos béka, robbanó béka
- Pályák: gyorsabb vagy kétirányban forgó fa, szél, mozgó levelek
- Toplista (pl. a legtöbb béka egyjátékos módban)
- Újracsatlakozás, ha megszakad a kapcsolat; nézők a szobában
- Csevegés vagy gyors emojik a szobában
