// Draws the game and turns the mouse into aim/shoot input. The rules and the
// physics live in sim.js, which runs here for local play and on the game
// server (or the host's browser) for online play.
import * as THREE from "three";
import { buildWorld, FROG_COLORS, LAUNCH_Z } from "./world.js";
import { createSim, laneRange, launchOrigin, launchVelocity, GRAVITY, SOLO_MESSAGE, round } from "./sim.js";

export { FROG_COLORS, SOLO_MESSAGE };

const SNAPSHOT_MS = 50;
const AIM_MS = 66;
const INTERP_DELAY = 110;

const clamp = THREE.MathUtils.clamp;

/**
 * mode "local":  the simulation runs here, every player sits at this device.
 * mode "host":   the simulation runs here and is streamed to the other players
 *                (claude.ai room / MQTT, where there is no game server).
 * mode "client": the scene follows snapshots from the game server or host,
 *                and this player's input is sent there.
 */
export function createEngine(host, opts) {
  const mode = opts.mode;
  const players = opts.players.map(p => ({ ...p }));
  const frogsPerPlayer = opts.frogsPerPlayer;
  const localId = opts.localPlayerId ?? null;
  const multi = players.length > 1;
  const realtime = !!opts.realtime && multi && mode !== "local";
  const duration = clamp(Number(opts.duration) || 60, 10, 600);
  const lanes = realtime ? players.length : 1;
  const noop = () => {};
  const onHud = opts.onHud || noop;
  const onSnapshot = opts.onSnapshot || noop;
  const onInput = opts.onInput || noop;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch {
    onHud({ error: "A játékhoz WebGL-t támogató böngésző szükséges." });
    return null;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
  host.appendChild(renderer.domElement);

  const world = buildWorld({ visual: true });
  const { scene, tree, M, FM, mesh, tube, leaf, frog, geometries, materials } = world;
  scene.background = new THREE.Color("#e9efdf");
  scene.fog = new THREE.Fog("#e9efdf", 26, 65);
  const camera = new THREE.PerspectiveCamera(43, 1, 0.1, 100);
  scene.add(new THREE.HemisphereLight("#fffce9", "#718a63", 2.5));
  const sun = new THREE.DirectionalLight("#fff0cc", 3.3);
  sun.position.set(-7, 13, 9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 45 });
  sun.shadow.normalBias = 0.025;
  scene.add(sun);
  const fill = new THREE.DirectionalLight("#ffffff", 1.1);
  fill.position.set(8, 6, -8);
  scene.add(fill);

  const sim = mode === "client" ? null : createSim({ players, frogsPerPlayer, realtime, duration });

  // One launcher in turn-based play; one per player, each in its own lane, in real-time play.
  const springPoints = [];
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    springPoints.push([Math.cos(t * Math.PI * 10) * 0.16, 0.17 + t * 0.34, Math.sin(t * Math.PI * 10) * 0.16]);
  }
  const dotMat = new THREE.MeshBasicMaterial({ color: "#fff8d7", transparent: true, opacity: 0.75 });
  materials.add(dotMat);
  function laneCentre(li) {
    const [a, b] = laneRange(lanes, li);
    return new THREE.Vector3((a + b) / 2, 0.65, LAUNCH_Z);
  }
  function makeLauncher(li) {
    const group = new THREE.Group();
    group.position.copy(laneCentre(li));
    scene.add(group);
    const foot = mesh(new THREE.CylinderGeometry(0.64, 0.75, 0.18, 32),
      realtime ? FM[players[li].color % FM.length].dark : M.dark, group);
    foot.position.y = 0.05;
    const spring = tube(group, springPoints, 0.035, M.metal);
    const paddle = new THREE.Group();
    paddle.position.y = 0.49;
    paddle.scale.setScalar(0.53);
    group.add(paddle);
    leaf(paddle, 1, 1.22, M.yellow, false);
    // One loaded frog per colour; only the owner's is visible.
    const loaded = FROG_COLORS.map((_, i) => {
      const f = frog(i);
      f.position.set(0, 0.78, -0.08);
      f.visible = false;
      group.add(f);
      return f;
    });
    const dots = Array.from({ length: 23 }, () => {
      const d = mesh(new THREE.SphereGeometry(0.045, 7, 5), dotMat);
      d.castShadow = false;
      d.visible = false;
      return d;
    });
    return { group, spring, paddle, loaded, dots, target: group.position.clone() };
  }
  const launchers = Array.from({ length: lanes }, (_, li) => makeLauncher(li));

  // What is on screen: the simulation's state, or the latest snapshot.
  let v = sim ? sim.state(true) : {
    tree: 0, b: [], l: launchers.map(L => [L.target.x, L.target.y, 0, 0]), turn: 0,
    shots: players.map(() => 0), tl: realtime ? duration : 0, cd: realtime ? 3 : 0,
    scores: players.map(() => 0), ready: players.map(() => 0), finished: 0,
    msg: "Kapcsolódás a játékhoz…", left: players.map(() => 0),
  };
  // This device's own aim and charge.
  const own = {
    target: laneCentre(0), charging: false, chargeStart: 0, power: 0,
    waitingShot: false, waitingSince: 0, lastMine: 0, wasMyTurn: false,
    nextAim: 0, nextPublish: 0, nextSnapshot: 0, disposed: false,
  };

  const meIndex = players.findIndex(p => p.id === localId);
  const isLocal = i => mode === "local" || (players[i] && players[i].id === localId);
  const active = i => players[i] && !v.left[i]
    && (realtime ? v.tl > 0 || v.cd > 0 : (v.shots[i] || 0) < frogsPerPlayer);
  const laneOf = i => (realtime ? i : 0);
  const ownerOf = li => (realtime ? li : v.turn);
  // The player whose launcher this device's mouse drives.
  const controlled = () => (realtime ? meIndex : v.turn);
  const myTurn = () => !v.finished && controlled() >= 0 && active(controlled()) && isLocal(controlled());
  const isReady = () => myTurn() && !!v.ready[controlled()] && !own.waitingShot;
  if (realtime && meIndex >= 0) own.target.copy(laneCentre(meIndex));

  // Charge shown on launcher li: this device's own, or the one reported for it.
  function chargeOf(li) {
    if (myTurn() && li === laneOf(controlled())) return [own.charging, own.charging ? own.power : 0];
    const a = v.l[li];
    return a && a[2] ? [true, a[3]] : [false, 0];
  }

  function publish() {
    if (own.disposed) return;
    const [charging, power] = chargeOf(laneOf(Math.max(0, controlled())));
    onHud({
      players: players.map((p, i) => ({
        ...p, left: !!v.left[i], score: v.scores[i] || 0, shots: v.shots[i] || 0,
        shotsLeft: Math.max(0, frogsPerPlayer - (v.shots[i] || 0)),
      })),
      realtime, turn: realtime ? -1 : v.turn, myTurn: myTurn(), ready: isReady(), finished: !!v.finished,
      message: v.msg, charging, power,
      timeLeft: realtime ? v.tl : null, countdown: realtime ? v.cd : 0,
      waiting: own.waitingShot,
    });
  }

  function send(data) {
    if (sim) sim.input(controlled(), data);
    else onInput(data);
  }
  function sendAim(force = false) {
    const now = performance.now();
    if (!sim && !force && now < own.nextAim) return;
    own.nextAim = now + AIM_MS;
    send({ kind: "aim", x: round(own.target.x), y: round(own.target.y), charging: own.charging, power: round(own.power) });
  }
  function clampOwn(x, y) {
    const [a, b] = laneRange(lanes, laneOf(controlled()));
    own.target.set(clamp(x, a, b), clamp(y, 0.38, 2.1), LAUNCH_Z);
  }
  function release() {
    if (!own.charging) return;
    const power = Math.min(1, (performance.now() - own.chargeStart) / 1400);
    const spin = (Math.random() - 0.5) * 0.7;
    own.charging = false;
    own.power = 0;
    if (!sim) {
      own.waitingShot = true;
      own.waitingSince = performance.now();
    }
    send({ kind: "shoot", x: round(own.target.x), y: round(own.target.y), power: round(power), spin: round(spin) });
    publish();
  }
  function cancel() {
    if (!own.charging) return;
    own.charging = false;
    own.power = 0;
    sendAim(true);
    publish();
  }

  // --- Bodies ---------------------------------------------------------------

  const views = new Map();
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  // Draws the frogs of `cur` (a state's body list), blended from `prev` by k.
  function drawBodies(cur, prev, k) {
    const seen = new Set();
    for (const b of cur) {
      const id = b[0];
      seen.add(id);
      let view = views.get(id);
      if (!view) {
        view = frog(players[b[1]]?.color ?? b[1]);
        scene.add(view);
        views.set(id, view);
      }
      const p = prev?.get(id) || b;
      view.position.set(p[2] + (b[2] - p[2]) * k, p[3] + (b[3] - p[3]) * k, p[4] + (b[4] - p[4]) * k);
      qa.set(p[5], p[6], p[7], p[8]).normalize();
      qb.set(b[5], b[6], b[7], b[8]).normalize();
      view.quaternion.slerpQuaternions(qa, qb, k);
    }
    for (const [id, view] of views) {
      if (!seen.has(id)) {
        view.removeFromParent();
        views.delete(id);
      }
    }
  }

  // Client: interpolation buffer of snapshots.
  const buffer = [];
  function applySnapshot(s) {
    if (mode !== "client" || !s || !Array.isArray(s.b) || !Array.isArray(s.l)) return;
    buffer.push({ at: performance.now(), s, bodies: new Map(s.b.map(a => [a[0], a])) });
    if (buffer.length > 40) buffer.shift();
    v = s;
    const mine = s.shots[meIndex] ?? 0;
    if (mine !== own.lastMine) {
      own.lastMine = mine;
      own.waitingShot = false;
    }
    if (!myTurn()) own.charging = false;
  }
  function interpolate(now) {
    if (!buffer.length) return;
    const rt = now - INTERP_DELAY;
    while (buffer.length > 2 && buffer[1].at <= rt) buffer.shift();
    const a = buffer[0];
    const b = buffer[1] || a;
    const k = b.at > a.at ? clamp((rt - a.at) / (b.at - a.at), 0, 1) : 1;
    tree.rotation.y = a.s.tree + (b.s.tree - a.s.tree) * k;
    drawBodies(b.s.b, a.bodies, k);
  }

  // --- Online roles -----------------------------------------------------------

  // Host: input from a player on another device.
  function remoteInput(playerId, data) {
    if (mode !== "host") return;
    const i = players.findIndex(p => p.id === playerId);
    if (i >= 0) sim.input(i, data);
  }
  function setPresent(ids) {
    sim?.setPresent(ids);
  }
  function reset() {
    sim?.reset();
  }

  // --- Input ----------------------------------------------------------------

  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -LAUNCH_Z);
  const intersection = new THREE.Vector3();
  function aim(e) {
    if (!myTurn()) return;
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(mouse, camera);
    if (ray.ray.intersectPlane(plane, intersection)) {
      clampOwn(intersection.x, intersection.y);
      sendAim();
    }
  }
  function down(e) {
    if (e.button !== 0 || !isReady()) return;
    e.preventDefault();
    aim(e);
    launchers[laneOf(controlled())].group.position.copy(own.target);
    renderer.domElement.setPointerCapture(e.pointerId);
    own.charging = true;
    own.chargeStart = performance.now();
    sendAim(true);
    publish();
  }
  function up(e) {
    if (e.button !== 0) return;
    release();
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }
  function key(e) {
    if (e.key.toLowerCase() === "r" && !e.repeat && sim) reset();
    if (e.key === "Escape") cancel();
  }
  renderer.domElement.addEventListener("pointermove", aim);
  renderer.domElement.addEventListener("pointerdown", down);
  renderer.domElement.addEventListener("pointerup", up);
  renderer.domElement.addEventListener("pointercancel", cancel);
  renderer.domElement.addEventListener("lostpointercapture", cancel);
  window.addEventListener("keydown", key);
  window.addEventListener("blur", cancel);
  const observer = new ResizeObserver(() => {
    const w = host.clientWidth;
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.set(0, 8.4, camera.aspect < 0.9 ? 24 : camera.aspect < 1.3 ? 20 : 17.8);
    camera.lookAt(0, 2, -0.7);
    camera.updateProjectionMatrix();
  });
  observer.observe(host);

  let previous = performance.now();
  let frame;
  function animate(now) {
    frame = requestAnimationFrame(animate);
    const dt = Math.min((now - previous) / 1000, 0.065);
    previous = now;
    if (sim) {
      sim.advance(dt);
      v = sim.state(true);
      tree.rotation.y = v.tree;
      drawBodies(v.b, null, 1);
    } else {
      interpolate(now);
      // A shot the host rejected must not lock the player out forever.
      if (own.waitingShot && now - own.waitingSince > 3000) own.waitingShot = false;
    }

    // When this player's turn starts, pick up the launcher where it stands.
    const mine = myTurn();
    if (mine && !own.wasMyTurn && !realtime && v.l[0]) clampOwn(v.l[0][0], v.l[0][1]);
    own.wasMyTurn = mine;
    if (own.charging) {
      own.power = Math.min(1, (now - own.chargeStart) / 1400);
      sendAim();
    }

    launchers.forEach((L, li) => {
      const owner = ownerOf(li);
      const driven = mine && li === laneOf(controlled());
      if (driven) L.target.copy(own.target);
      else if (v.l[li]) L.target.set(v.l[li][0], v.l[li][1], LAUNCH_Z);
      L.group.position.lerp(L.target, Math.min(1, dt * 22));
      const [charging, power] = chargeOf(li);
      const compression = charging ? power * 0.23 : 0;
      L.spring.scale.y = 1 - compression * 1.5;
      L.paddle.position.y = 0.49 - compression;
      const ready = driven ? isReady() : !!v.ready[owner];
      const showLoaded = !v.finished && active(owner) && ready;
      const colour = players[owner]?.color ?? 0;
      L.loaded.forEach((f, i) => {
        f.visible = showLoaded && i === colour;
        f.position.y = 0.78 - compression;
      });
      const p = L.group.position;
      const origin = launchOrigin(p.x, p.y);
      const velocity = launchVelocity(p.x, power);
      L.dots.forEach((d, i) => {
        d.visible = charging;
        if (charging) {
          const t = (i + 1) * 0.06;
          d.position.copy(origin).addScaledVector(velocity, t);
          d.position.y -= 0.5 * GRAVITY * t * t;
          if (d.position.y < 0.1) d.visible = false;
        }
      });
    });
    if (now > own.nextPublish) {
      publish();
      own.nextPublish = now + 70;
    }
    if (mode === "host" && now > own.nextSnapshot) {
      own.nextSnapshot = now + SNAPSHOT_MS;
      onSnapshot(sim.state());
    }
    renderer.render(scene, camera);
  }
  frame = requestAnimationFrame(animate);
  publish();

  function dispose() {
    own.disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener("keydown", key);
    window.removeEventListener("blur", cancel);
    renderer.domElement.removeEventListener("pointermove", aim);
    renderer.domElement.removeEventListener("pointerdown", down);
    renderer.domElement.removeEventListener("pointerup", up);
    renderer.domElement.removeEventListener("pointercancel", cancel);
    renderer.domElement.removeEventListener("lostpointercapture", cancel);
    geometries.forEach(x => x.dispose());
    materials.forEach(x => x.dispose());
    renderer.dispose();
    renderer.domElement.remove();
  }

  return { reset, remoteInput, applySnapshot, setPresent, dispose };
}
