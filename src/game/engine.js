// Draws the game and turns the mouse into aim/shoot input. The rules and the
// physics live in sim.js, which runs here for local play and on the game
// server (or the host's browser) for online play.
import * as THREE from "three";
import { buildWorld, layout, FROG_COLORS, TREE_CENTRE } from "./world.js";
import { createSim, launchFrame, frameToWorld, launchOrigin, launchVelocity, GRAVITY, SOLO_MESSAGE, round } from "./sim.js";

export { FROG_COLORS, SOLO_MESSAGE };

const SNAPSHOT_MS = 50;
const AIM_MS = 66;
// Snapshots are shown this far (s) behind the newest, so there is always one to blend towards.
const INTERP_DELAY = 0.12;
const FADE_TIME = 0.3;

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
  const treeScale = layout(opts.treeScale).scale;
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

  const world = buildWorld({ visual: true, treeScale });
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

  const sim = mode === "client" ? null : createSim({ players, frogsPerPlayer, realtime, duration, treeScale });

  // One launcher per player, evenly around the tree, each facing it.
  const springPoints = [];
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    springPoints.push([Math.cos(t * Math.PI * 10) * 0.16, 0.17 + t * 0.34, Math.sin(t * Math.PI * 10) * 0.16]);
  }
  const dotMat = new THREE.MeshBasicMaterial({ color: "#fff8d7", transparent: true, opacity: 0.75 });
  materials.add(dotMat);
  const frames = players.map((_, i) => launchFrame(players.length, i, treeScale));
  function makeLauncher(li) {
    const frame = frames[li];
    const group = new THREE.Group();
    group.position.copy(frameToWorld(frame, 0, 0.65));
    group.rotation.y = frame.angle;
    scene.add(group);
    const foot = mesh(new THREE.CylinderGeometry(0.64, 0.75, 0.18, 32),
      multi ? FM[players[li].color % FM.length].dark : M.dark, group);
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
    // aim: x sideways and y height in the launcher's own plane.
    return { frame, group, spring, paddle, loaded, dots, aim: { x: 0, y: 0.65 }, target: group.position.clone() };
  }
  const launchers = players.map((_, li) => makeLauncher(li));

  // What is on screen: the simulation's state, or the latest snapshot.
  let v = sim ? sim.state(true) : {
    t: 0, tree: 0, b: [], l: launchers.map(() => [0, 0.65, 0, 0]), turn: 0,
    shots: players.map(() => 0), tl: realtime ? duration : 0, cd: realtime ? 3 : 0,
    scores: players.map(() => 0), ready: players.map(() => 0), finished: 0,
    msg: "Kapcsolódás a játékhoz…", left: players.map(() => 0),
  };
  // This device's own aim and charge.
  // own.x/own.y: this player's aim, in their launcher's plane.
  const own = {
    x: 0, y: 0.65, charging: false, chargeStart: 0, power: 0,
    waitingShot: false, waitingSince: 0, lastMine: 0, wasMyTurn: false, lastControlled: -1,
    nextAim: 0, nextPublish: 0, nextSnapshot: 0, disposed: false,
  };

  const meIndex = players.findIndex(p => p.id === localId);
  const isLocal = i => mode === "local" || (players[i] && players[i].id === localId);
  const active = i => players[i] && !v.left[i]
    && (realtime ? v.tl > 0 || v.cd > 0 : (v.shots[i] || 0) < frogsPerPlayer);
  // The player whose launcher this device's mouse drives.
  const controlled = () => (realtime ? meIndex : v.turn);
  const myTurn = () => !v.finished && controlled() >= 0 && active(controlled()) && isLocal(controlled());
  const isReady = () => myTurn() && !!v.ready[controlled()] && !own.waitingShot;

  // Charge shown on launcher li: this device's own, or the one reported for it.
  function chargeOf(li) {
    if (myTurn() && li === controlled()) return [own.charging, own.charging ? own.power : 0];
    const a = v.l[li];
    return a && a[2] ? [true, a[3]] : [false, 0];
  }

  function publish() {
    if (own.disposed) return;
    const [charging, power] = chargeOf(Math.max(0, controlled()));
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
    send({ kind: "aim", x: round(own.x), y: round(own.y), charging: own.charging, power: round(own.power) });
  }
  function clampOwn(x, y) {
    const half = frames[Math.max(0, controlled())].half;
    own.x = clamp(x, -half, half);
    own.y = clamp(y, 0.38, 2.1);
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
    send({ kind: "shoot", x: round(own.x), y: round(own.y), power: round(power), spin: round(spin) });
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
        views.delete(id);
        fading.push({ view, life: FADE_TIME });
      }
    }
  }
  // Frogs that left the game shrink away instead of vanishing.
  const fading = [];
  function fade(dt) {
    for (let k = fading.length - 1; k >= 0; k--) {
      const f = fading[k];
      f.life -= dt;
      if (f.life <= 0) {
        f.view.removeFromParent();
        fading.splice(k, 1);
      } else f.view.scale.setScalar(f.life / FADE_TIME);
    }
  }

  // Client: interpolation buffer of snapshots, placed on the simulation's own clock
  // (s.t), so uneven arrival from a busy server or network does not make frogs jitter.
  const buffer = [];
  let clockOffset = null; // local seconds minus simulation seconds, for the least delayed snapshot
  function applySnapshot(s) {
    if (mode !== "client" || !s || !Array.isArray(s.b) || !Array.isArray(s.l)) return;
    const local = performance.now() / 1000;
    const t = Number(s.t) || 0;
    const last = buffer[buffer.length - 1];
    // A new round or a restarted clock: start over.
    if (last && t < last.t) {
      buffer.length = 0;
      clockOffset = null;
    }
    const offset = local - t;
    // Track the fastest delivery, drifting slowly so a lasting slowdown is followed.
    clockOffset = clockOffset === null ? offset : Math.min(offset, clockOffset + 0.002);
    buffer.push({ t, s, bodies: new Map(s.b.map(a => [a[0], a])) });
    if (buffer.length > 60) buffer.shift();
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
    const rt = now / 1000 - clockOffset - INTERP_DELAY;
    while (buffer.length > 2 && buffer[1].t <= rt) buffer.shift();
    const a = buffer[0];
    const b = buffer[1] || a;
    const k = b.t > a.t ? clamp((rt - a.t) / (b.t - a.t), 0, 1) : 1;
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
  const plane = new THREE.Plane();
  const intersection = new THREE.Vector3();
  const normal = new THREE.Vector3();
  function aim(e) {
    if (!myTurn()) return;
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(mouse, camera);
    // The player's launcher plane: facing the tree, at the launcher's distance.
    const frame = frames[controlled()];
    normal.set(frame.sin, 0, frame.cos);
    plane.setFromNormalAndCoplanarPoint(normal, frameToWorld(frame, 0, 0));
    if (ray.ray.intersectPlane(plane, intersection)) {
      const dx = intersection.x - TREE_CENTRE.x;
      const dz = intersection.z - TREE_CENTRE.z;
      clampOwn(dx * frame.cos - dz * frame.sin, intersection.y);
      sendAim();
    }
  }
  function down(e) {
    if (e.button !== 0 || !isReady()) return;
    e.preventDefault();
    aim(e);
    const L = launchers[controlled()];
    L.group.position.copy(frameToWorld(L.frame, own.x, own.y));
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
  // The camera stands behind the player's own launcher (in local play, the
  // current player's) and swings around the tree when that changes.
  const { radius } = layout(treeScale);
  let cameraAngle = null;
  function placeCamera(dt) {
    const who = Math.max(0, controlled() >= 0 ? controlled() : meIndex);
    const target = frames[who]?.angle ?? 0;
    if (cameraAngle === null) cameraAngle = target;
    let diff = target - cameraAngle;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    cameraAngle += diff * Math.min(1, dt * 3);
    const back = radius + 11.75 + (camera.aspect < 0.9 ? 6.2 : camera.aspect < 1.3 ? 2.2 : 0) + (treeScale - 1) * 4;
    const height = 8.4 + (treeScale - 1) * 5;
    const view = { angle: cameraAngle, sin: Math.sin(cameraAngle), cos: Math.cos(cameraAngle) };
    frameToWorld(view, 0, height, back, camera.position);
    camera.lookAt(frameToWorld(view, 0, 2 + (treeScale - 1) * 2.5, radius - 6.75));
  }
  const observer = new ResizeObserver(() => {
    const w = host.clientWidth;
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    placeCamera(1);
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

    // When this device starts driving a launcher, pick up its aim where it stands.
    fade(dt);
    const mine = myTurn();
    const ctl = controlled();
    if (mine && (!own.wasMyTurn || ctl !== own.lastControlled) && v.l[ctl]) clampOwn(v.l[ctl][0], v.l[ctl][1]);
    own.wasMyTurn = mine;
    own.lastControlled = ctl;
    placeCamera(dt);
    if (own.charging) {
      own.power = Math.min(1, (now - own.chargeStart) / 1400);
      sendAim();
    }

    launchers.forEach((L, li) => {
      const owner = li;
      const driven = mine && li === ctl;
      if (driven) frameToWorld(L.frame, own.x, own.y, L.frame.radius, L.target);
      else if (v.l[li]) frameToWorld(L.frame, v.l[li][0], v.l[li][1], L.frame.radius, L.target);
      L.group.position.lerp(L.target, Math.min(1, dt * 22));
      // Sideways offset of the launcher as drawn, for the aiming guide.
      const dx = L.group.position.x - TREE_CENTRE.x;
      const dz = L.group.position.z - TREE_CENTRE.z;
      const side = dx * L.frame.cos - dz * L.frame.sin;
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
      const origin = launchOrigin(L.frame, side, L.group.position.y);
      const velocity = launchVelocity(L.frame, side, power);
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
