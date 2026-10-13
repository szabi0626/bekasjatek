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
npm run dev:server   # online szerver a 8080-as porton
npm run dev          # játék a http://localhost:5173 címen
```

## Kitétel az internetre

### Már most játszható: claude.ai

A játék kint van claude.ai Artifactként: https://claude.ai/artifact/QSRF8aic3kmvhtquU7L1d4

Itt az online mód szerver nélkül működik: a claude.ai `room` csatornáján keresztül kommunikálnak a játékosok. A barátaidat az oldal **Share** menüjében hívhatod meg. Ehhez nekik is claude.ai-fiók kell.

Frissítés: `npm run build && node scripts/build-artifact.mjs`, majd a kész `artifact/flippin-frogs.html` fájlt kell újra közzétenni.

### A) Render.com: minden egyben, ingyenes (javasolt)

Itt a játék és az online szerver ugyanazon a címen fut.

1. Regisztrálj a [render.com](https://render.com) oldalon a GitHub-fiókoddal.
2. Válaszd ezt: **New → Blueprint**, majd add meg ezt a repót. A `render.yaml` minden beállítást tartalmaz.
3. Pár perc múlva kapsz egy címet, például `https://bekasjatek.onrender.com`. Ezt a linket küldheted a barátaidnak.

Az ingyenes csomag szervere 15 perc tétlenség után elalszik. Az első megnyitás ilyenkor kb. 30–60 másodpercig tart.

### B) GitHub Pages: ingyenes, szerver nélkül, bárkinek

A `main` ágra pusholt változásokat a `.github/workflows/pages.yml` workflow automatikusan kiteszi a `https://szabi0626.github.io/bekasjatek/` címre. Ehhez egyszer be kell állítani:

1. **Settings → General → Danger Zone → Change visibility → Public**. Ingyenes fióknál a Pages csak publikus repóval működik.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Actions → GitHub Pages → Run workflow**, vagy pusholj valamit a `main` ágra.

Itt az online mód egy ingyenes, nyilvános MQTT üzenetközvetítőn megy keresztül. Sorban az EMQX, a HiveMQ és a Mosquitto szerverét próbálja, amelyik épp elérhető. Ugyanolyan sima webes kapcsolat, mint egy weboldal megnyitása, ezért bármilyen hálózaton működik, és regisztráció sem kell hozzá. Ha a házigazda telefonon átvált egy másik alkalmazásra, a csatlakozók legfeljebb egy percig várnak rá, és amint visszajön, bejutnak.

## Hogyan működik az online mód?

```
 Házigazda böngészője  ──►  szerver (server/index.js)  ──►  többi játékos böngészője
  (itt fut a fizika)         csak továbbítja az üzeneteket    (célzás, lövés → házigazda;
                                                               állapot ← 20× másodpercenként)
```

- Három szállítási mód van ugyanazzal az üzenetformátummal: saját WebSocket-szerver (Render), nyilvános MQTT-közvetítő (GitHub Pages), és claude.ai-on a `room` csatorna.
- A szoba létrehozója a **házigazda**. Az ő böngészője számolja a fizikát, és másodpercenként 20-szor elküldi a békák helyzetét a többieknek. A többiek böngészője ezek között simán interpolál.
- A játékosok célzása és lövése a házigazdához megy. A házigazda ellenőrzi, hogy az adott játékos lőhet-e: valós idejű módban a saját újratöltése lejárt-e, felváltva módban ő következik-e.
- Ha valaki kilép, a köreit a játék kihagyja. Ha a házigazda lép ki, a játék véget ér.

## Projektszerkezet

| Fájl | Mire való |
|---|---|
| `src/game/engine.js` | 3D jelenet, fizika (ütközések, súrlódás, forgó fa), irányítás, hálózati szinkron |
| `src/Game.jsx` | Játék közbeni felület: pontok, erőmérő, kör vége |
| `src/App.jsx` | Menü, helyi beállítások, online szoba és váró |
| `src/net.js`, `src/mqttnet.js` | Hálózat: WebSocket-kliens, MQTT (GitHub Pages), illetve claude.ai-on a `room` csatorna |
| `server/index.js` | Node szerver: kiszolgálja a játékot és továbbítja a szobák üzeneteit |
| `render.yaml`, `.github/workflows/pages.yml`, `scripts/build-artifact.mjs` | Telepítési beállítások, egyfájlos build a claude.ai-hoz |

## Ötletek a továbbfejlesztéshez

- Hangok (lövés, csobbanás, ütközés) és rezgés mobilon
- Különleges békák: nehéz béka, ragacsos béka, robbanó béka
- Pályák: gyorsabb vagy kétirányban forgó fa, szél, mozgó levelek
- Toplista (pl. a legtöbb béka egyjátékos módban)
- Újracsatlakozás, ha megszakad a kapcsolat; nézők a szobában
- Csevegés vagy gyors emojik a szobában
