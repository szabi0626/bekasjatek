// Draws the game and turns the mouse into aim/shoot input. The rules and the
// physics live in sim.js, which runs here for local play and on the game
// server (or the host's browser) for online play.
import * as THREE from "three";
import { buildWorld, layout, FROG_COLORS, TREE_CENTRE, TREE_OMEGA } from "./world.js";
import { createSim, launchFrame, frameToWorld, launchOrigin, launchVelocity, launchSpin, randomTumble, GRAVITY, SOLO_MESSAGE, round } from "./sim.js";

export { FROG_COLORS, SOLO_MESSAGE };

const SNAPSHOT_MS = 50;
const AIM_MS = 66;
// Snapshots are shown this far (s) behind the newest, so there is always one to
// blend towards; it adapts to how unevenly they arrive, within these bounds.
const MIN_DELAY = 0.05;
// Some links (e.g. Cloudflare quick tunnels) stall for ~300 ms every few seconds.
// Smooth motion comes first: the buffer covers the stalls seen in the last
// LATE_WINDOW snapshots (up to MAX_DELAY), so there is nearly always real data
// to show. The player's own shots are predicted, so they do not feel the delay.
const MAX_DELAY = 0.6;
const LATE_WINDOW = 400;
const MAX_EXTRAPOLATE = 0.4;
const FLYING_SPEED = 2;
const FADE_TIME = 0.3;
const GRENADE_SIZE = 2;
const ARMED_NAMES = [null, "gun", "grenade"];
// A correction (after a network stall, or when the server's copy of a predicted
// shot takes over) is not shown as a jump: the gap closes at this rate (1/s).
const SMOOTHING = 9;
const MAX_SMOOTHED = 3;
// A predicted shot handed over to the server's copy, which is shown further in
// the past, is not pulled back: that frog is played ahead in time (from the
// buffered snapshots) by as much as the prediction was, and the lead runs out
// at this rate, so it flies only a little (15%) slower until it catches up.
const LEAD_DECAY = 0.15;
// The playback clock eases towards where it should be at this rate (1/s), so a
// change of buffer delay slows or speeds frogs briefly instead of making them jump;
// it runs at most this much slower or faster than real time, which the eye
// hardly notices (more made frogs visibly slow down and speed up in the air).
const CLOCK_EASE = 2.5;
const MAX_SLOWER = 0.15;
const MAX_FASTER = 0.1;
// A predicted shot not taken over by the server's frog within this time disappears.
const GHOST_LIFE = 1.2;
const BLAST_TIME = 0.7;

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
  const realtime = !!opts.realtime && mode !== "local";
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

  // views: how many launchers (cameras) there are, for placing landmarks each can see.
  const world = buildWorld({ visual: true, treeScale, map: opts.map, views: players.length });
  const { scene, tree, M, FM, mesh, tube, leaf, frog, geometries, materials } = world;
  // Where the screen guesses a frog's motion (a predicted shot, or carrying on
  // through a network stall) it must not fly into the tree: the guess stops at
  // the first surface on its way, a frog's half-size short of it.
  const solids = world.colliders.map(c => c.object);
  const FROG_REACH = 0.2;
  const hitRay = new THREE.Raycaster();
  const rayDir = new THREE.Vector3();
  function moveUntilBlocked(pos, to) {
    rayDir.copy(to).sub(pos);
    const length = rayDir.length();
    if (length < 1e-6) return false;
    rayDir.divideScalar(length);
    hitRay.set(pos, rayDir);
    hitRay.far = length + FROG_REACH;
    const hit = hitRay.intersectObjects(solids, false)[0];
    if (!hit) {
      pos.copy(to);
      return false;
    }
    pos.addScaledVector(rayDir, Math.max(0, hit.distance - FROG_REACH));
    return true;
  }
  scene.background = new THREE.Color(world.env.sky);
  scene.fog = new THREE.Fog(world.env.sky, 26 + (treeScale - 1) * 12, 65 + (treeScale - 1) * 25);
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

  const sim = mode === "client" ? null : createSim({ players, frogsPerPlayer, realtime, duration, treeScale, reload: opts.reload, map: opts.map, physics: opts.physics });

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
    // A loaded special: a glowing ring around the paddle.
    const glowMat = new THREE.MeshBasicMaterial({ color: "#ff9a2e", transparent: true, opacity: 0.85, depthWrite: false });
    materials.add(glowMat);
    const glow = mesh(new THREE.TorusGeometry(0.62, 0.05, 8, 40), glowMat, group);
    glow.rotation.x = Math.PI / 2;
    glow.position.y = 0.55;
    glow.castShadow = false;
    glow.visible = false;
    // aim: x sideways and y height in the launcher's own plane.
    return { frame, group, spring, paddle, loaded, dots, glow, aim: { x: 0, y: 0.65 }, target: group.position.clone() };
  }
  const launchers = players.map((_, li) => makeLauncher(li));

  // What is on screen: the simulation's state, or the latest snapshot.
  let v = sim ? sim.state(true) : {
    t: 0, tree: 0, b: [], l: launchers.map(() => [0, 0.65, 0, 0]), turn: 0,
    shots: players.map(() => 0), tl: realtime ? duration : 0, cd: realtime ? 3 : 0,
    scores: players.map(() => 0), ready: players.map(() => 0), finished: 0,
    msg: "Kapcsolódás a játékhoz…", left: players.map(() => 0), sp: [], ex: [],
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
      armed: own.armed,
      // Seconds until this player's gun (key 1) and grenade (key 2) are ready, in real-time rounds.
      specials: realtime && meIndex >= 0 && v.sp?.[meIndex] ? v.sp[meIndex] : null,
      diagnostics: diagnostics(),
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
    send({ kind: "aim", x: round(own.x), y: round(own.y), charging: own.charging, power: round(own.power), armed: own.armed });
  }
  function clampOwn(x, y) {
    const half = frames[Math.max(0, controlled())].half;
    own.x = clamp(x, -half, half);
    own.y = clamp(y, 0.38, 2.1);
  }
  function release() {
    if (!own.charging) return;
    const power = Math.min(1, (performance.now() - own.chargeStart) / 1400);
    const spin = round((Math.random() - 0.5) * 0.7);
    // The random tumble is picked here, so the predicted frog spins exactly like the server's.
    const tumble = randomTumble();
    own.charging = false;
    own.power = 0;
    if (own.armed) {
      const kind = own.armed;
      own.armed = null;
      send({ kind, x: round(own.x), y: round(own.y), power: round(power) });
      sendAim(true);
      publish();
      return;
    }
    if (!sim) {
      // Predict the shot only when the launcher is surely ready (a shot released
      // during the reload is fired later by the server).
      if (realtime ? v.ready[controlled()] && !own.waitingShot : isReady()) predictShot(power, spin, tumble);
      own.waitingShot = true;
      own.waitingSince = performance.now();
    }
    send({ kind: "shoot", x: round(own.x), y: round(own.y), power: round(power), spin, tumble });
    publish();
  }
  // Keys 1 and 2 load the machine gun or the grenade into the launcher (pressing
  // the same key again unloads it); the next charge-and-release fires it, with
  // the charge as its strength.
  const SPECIAL_KEYS = { gun: 0, grenade: 1 };
  function special(kind) {
    if (!realtime || !myTurn() || v.cd > 0) return;
    if (own.armed !== kind && v.sp?.[meIndex]?.[SPECIAL_KEYS[kind]] > 0) return;
    own.armed = own.armed === kind ? null : kind;
    sendAim(true);
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
        if (b[10]) {
          view.scale.setScalar(GRENADE_SIZE);
          view.userData.grenade = true;
        } else if (b[1] === meIndex && ghosts.length) adoptGhost(view);
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
        // A grenade is gone in its blast.
        if (view.userData.grenade) view.removeFromParent();
        else fading.push({ view, life: FADE_TIME });
      }
    }
  }
  // Corrections are eased out: each frog carries an offset from where the
  // simulation puts it to where it was drawn, which shrinks every frame.
  const gap = new THREE.Vector3();
  const identity = new THREE.Quaternion();
  const turnGap = new THREE.Quaternion();
  function smooth(dt) {
    const keep = Math.exp(-SMOOTHING * dt);
    for (const view of views.values()) {
      const u = view.userData;
      if (resync && u.shown) {
        gap.copy(u.shown).sub(view.position);
        if (gap.lengthSq() < MAX_SMOOTHED * MAX_SMOOTHED) (u.off ||= new THREE.Vector3()).copy(gap);
        // Rotation still to make up: shown = offQ * current.
        u.offQ = turnGap.copy(view.quaternion).invert().premultiply(u.shownQ).clone();
      }
      if (u.off) {
        view.position.add(u.off);
        u.off.multiplyScalar(keep);
        if (u.off.lengthSq() < 1e-6) u.off = null;
      }
      if (u.offQ) {
        u.offQ.slerp(identity, 1 - keep);
        view.quaternion.premultiply(u.offQ);
        if (1 - Math.abs(u.offQ.w) < 1e-6) u.offQ = null;
      }
      (u.shown ||= new THREE.Vector3()).copy(view.position);
      (u.shownQ ||= new THREE.Quaternion()).copy(view.quaternion);
    }
    resync = false;
  }

  // Client-side prediction of this player's own shots: the frog leaves the
  // launcher at once and flies the arc the server will compute, until the
  // server's frog arrives and takes over from where the predicted one is.
  const ghosts = [];
  const ghostTurn = new THREE.Quaternion();
  const ghostNext = new THREE.Vector3();
  const ghostAxis = new THREE.Vector3();
  function predictShot(power, spin, tumble) {
    const li = controlled();
    const L = launchers[li];
    if (!L) return;
    const view = frog(players[li]?.color ?? li);
    view.position.copy(launchOrigin(L.frame, own.x, own.y));
    view.rotation.y = L.frame.angle;
    scene.add(view);
    ghosts.push({ view, age: 0, velocity: launchVelocity(L.frame, own.x, round(power)), spin: launchSpin(L.frame, spin, tumble) });
  }
  function flyGhosts(dt) {
    for (let k = ghosts.length - 1; k >= 0; k--) {
      const g = ghosts[k];
      g.age += dt;
      if (g.age > GHOST_LIFE) {
        ghosts.splice(k, 1);
        fading.push({ view: g.view, life: FADE_TIME });
        continue;
      }
      // Same motion as the simulation's: gravity, air drag, and the spin in world axes.
      g.velocity.y -= GRAVITY * dt;
      g.velocity.multiplyScalar(Math.exp(-0.035 * dt));
      g.spin.multiplyScalar(Math.exp(-0.24 * dt));
      if (g.stopped) continue;
      // Until the server's frog takes over, a predicted one that reaches the tree waits there.
      if (moveUntilBlocked(g.view.position, ghostNext.copy(g.view.position).addScaledVector(g.velocity, dt))) {
        g.stopped = true;
        continue;
      }
      const rate = g.spin.length();
      if (rate > 1e-5) g.view.quaternion.premultiply(ghostTurn.setFromAxisAngle(ghostAxis.copy(g.spin).divideScalar(rate), rate * dt));
    }
  }
  // A new frog of this player's from the server: the oldest predicted one hands over to it.
  function adoptGhost(view) {
    const g = ghosts.shift();
    if (!g) return;
    g.view.removeFromParent();
    view.userData.lead = g.age;
    view.userData.adoptP = g.view.position.clone();
    view.userData.adoptQ = g.view.quaternion.clone();
  }
  // Where body `id` is at simulation time t, from the buffer (extrapolated past the newest).
  const sampleQ = new THREE.Quaternion();
  const sampleTo = new THREE.Vector3();
  function sample(id, t, outP, outQ) {
    for (let i = buffer.length - 1; i >= 0; i--) {
      const a = buffer[i];
      if (a.t > t && i > 0) continue;
      const pa = a.bodies.get(id);
      if (!pa) return false;
      const next = buffer[i + 1];
      const pb = next?.bodies.get(id);
      if (pb && next.t > a.t) {
        const k = clamp((t - a.t) / (next.t - a.t), 0, 1);
        outP.set(pa[2] + (pb[2] - pa[2]) * k, pa[3] + (pb[3] - pa[3]) * k, pa[4] + (pb[4] - pa[4]) * k);
        outQ.set(pa[5], pa[6], pa[7], pa[8]).normalize().slerp(sampleQ.set(pb[5], pb[6], pb[7], pb[8]).normalize(), k);
        return true;
      }
      outP.set(pa[2], pa[3], pa[4]);
      outQ.set(pa[5], pa[6], pa[7], pa[8]).normalize();
      const before = buffer[i - 1];
      const pc = before?.bodies.get(id);
      const ahead = Math.min(Math.max(0, t - a.t), MAX_EXTRAPOLATE);
      if (pc && ahead > 0 && a.t > before.t) {
        const span = a.t - before.t;
        const vx = (pa[2] - pc[2]) / span, vy = (pa[3] - pc[3]) / span, vz = (pa[4] - pc[4]) / span;
        const flying = vx * vx + vy * vy + vz * vz > FLYING_SPEED * FLYING_SPEED;
        sampleTo.set(outP.x + vx * ahead, outP.y + vy * ahead - (flying ? 0.5 * GRAVITY * ahead * ahead : 0), outP.z + vz * ahead);
        if (!moveUntilBlocked(outP, sampleTo)) keepTurning(outQ, pc, pa, ahead / span);
      }
      return true;
    }
    return false;
  }
  // Extrapolated rotation: q (body `to`'s) turned on by `times` times the turn
  // from snapshot body `from` to `to`, so a frog keeps spinning through a stall.
  const turnFrom = new THREE.Quaternion();
  const turnStep = new THREE.Quaternion();
  const turnAxis = new THREE.Vector3();
  function keepTurning(q, from, to, times) {
    turnFrom.set(from[5], from[6], from[7], from[8]).normalize().invert();
    turnStep.set(to[5], to[6], to[7], to[8]).normalize().multiply(turnFrom);
    if (turnStep.w < 0) turnStep.set(-turnStep.x, -turnStep.y, -turnStep.z, -turnStep.w);
    const angle = 2 * Math.acos(clamp(turnStep.w, -1, 1));
    const s = Math.sqrt(Math.max(0, 1 - turnStep.w * turnStep.w));
    if (angle < 1e-5 || s < 1e-6) return;
    turnAxis.set(turnStep.x / s, turnStep.y / s, turnStep.z / s);
    q.premultiply(turnStep.setFromAxisAngle(turnAxis, angle * times));
  }

  // Own frogs taken over from a prediction: drawn `lead` seconds ahead.
  const leadP = new THREE.Vector3();
  const leadQ = new THREE.Quaternion();
  function leadOwnFrogs(rt, dt) {
    for (const [id, view] of views) {
      const u = view.userData;
      if (!u.lead) continue;
      if (sample(id, rt + u.lead, leadP, leadQ)) {
        view.position.copy(leadP);
        view.quaternion.copy(leadQ);
      }
      // The first frame: whatever is left between the prediction and this is eased out.
      if (u.adoptP) {
        const off = u.adoptP.sub(view.position);
        u.off = off.lengthSq() < MAX_SMOOTHED * MAX_SMOOTHED ? off : null;
        u.offQ = u.adoptQ.multiply(leadQ.copy(view.quaternion).invert());
        u.adoptP = u.adoptQ = null;
      }
      u.lead = Math.max(0, u.lead - LEAD_DECAY * dt);
    }
  }

  // Grenade blasts: a fireball and a shock ring that grow and fade.
  const blastGeometry = new THREE.SphereGeometry(1, 24, 16);
  const ringGeometry = new THREE.TorusGeometry(1, 0.08, 8, 40);
  geometries.add(blastGeometry);
  geometries.add(ringGeometry);
  const blasts = [];
  const seenBlasts = new Set();
  function showBlasts(list) {
    for (const [id, x, y, z] of list || []) {
      if (seenBlasts.has(id)) continue;
      seenBlasts.add(id);
      const fire = new THREE.Mesh(blastGeometry, new THREE.MeshBasicMaterial({ color: "#ffb02e", transparent: true, depthWrite: false }));
      const ring = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color: "#fff3c4", transparent: true, depthWrite: false }));
      ring.rotation.x = Math.PI / 2;
      for (const m of [fire, ring]) {
        m.position.set(x, y, z);
        scene.add(m);
      }
      blasts.push({ fire, ring, age: 0 });
      shake = Math.max(shake, 0.45);
    }
  }
  function animateBlasts(dt) {
    for (let k = blasts.length - 1; k >= 0; k--) {
      const b = blasts[k];
      b.age += dt;
      const t = b.age / BLAST_TIME;
      if (t >= 1) {
        for (const m of [b.fire, b.ring]) {
          m.removeFromParent();
          m.material.dispose();
        }
        blasts.splice(k, 1);
        continue;
      }
      b.fire.scale.setScalar(0.6 + 4.6 * Math.sqrt(t));
      b.fire.material.opacity = 0.9 * (1 - t);
      b.fire.material.color.setHSL(0.1 - 0.08 * t, 1, 0.6 - 0.25 * t);
      b.ring.scale.setScalar(0.5 + 7 * t);
      b.ring.material.opacity = 0.8 * (1 - t);
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
  let delay = 0.12;
  let paused = false;
  // Playback time (simulation seconds) of what is on screen.
  let playT = null;
  // Set when drawing resumes from real snapshots after extrapolating through a stall.
  let resync = false;
  let extrapolating = false;
  // Diagnostics (D key): arrival gaps, lateness, and how often the buffer ran dry.
  const diag = { gaps: [], late: [], underruns: 0, lastArrival: 0, frames: [], server: null };
  function applySnapshot(s) {
    if (mode !== "client" || !s || !Array.isArray(s.b) || !Array.isArray(s.l)) return;
    const local = performance.now() / 1000;
    const t = Number(s.t) || 0;
    const last = buffer[buffer.length - 1];
    // A restarted clock: start over.
    if (last && t < last.t) {
      buffer.length = 0;
      clockOffset = null;
    }
    // The simulation clock stands still between rounds. Show the latest state,
    // but do not take the wait for network delay: that made every snapshot of
    // the next round look as late as the pause was long, and play stuttered.
    if (last && t === last.t) {
      paused = true;
      last.s = s;
      last.bodies = new Map(s.b.map(a => [a[0], a]));
      diag.lastArrival = local;
      accept(s);
      return;
    }
    if (paused) {
      paused = false;
      clockOffset = null;
      playT = null;
      diag.late.length = 0;
      diag.lastArrival = 0;
    }
    const offset = local - t;
    // Track the fastest delivery, drifting slowly (40 ms a second, whatever the
    // snapshot rate) so a lasting slowdown is followed.
    const since = diag.lastArrival ? Math.min(local - diag.lastArrival, 0.5) : 0;
    clockOffset = clockOffset === null ? offset : Math.min(offset, clockOffset + since * 0.04);
    // How late this one is compared with the fastest: the delay covers nearly all
    // of that, stalls included (the playback clock eases to a new delay).
    const lateness = offset - clockOffset;
    diag.late.push(lateness);
    if (diag.late.length > LATE_WINDOW) diag.late.shift();
    const sorted = [...diag.late].sort((x, y) => x - y);
    const worst = sorted[Math.floor((sorted.length - 1) * 0.99)];
    const wanted = clamp(worst + 0.04, MIN_DELAY, MAX_DELAY);
    // Grow at once, shrink slowly.
    delay = wanted > delay ? wanted : delay + (wanted - delay) * 0.005;
    if (diag.lastArrival) {
      diag.gaps.push(local - diag.lastArrival);
      if (diag.gaps.length > 60) diag.gaps.shift();
    }
    diag.lastArrival = local;
    if (s.sv) diag.server = s.sv;
    buffer.push({ t, s, bodies: new Map(s.b.map(a => [a[0], a])) });
    if (buffer.length > 60) buffer.shift();
    accept(s);
  }
  function accept(s) {
    showBlasts(s.ex);
    v = s;
    const mine = s.shots[meIndex] ?? 0;
    if (mine !== own.lastMine) {
      own.lastMine = mine;
      own.waitingShot = false;
    }
    if (!myTurn()) own.charging = false;
  }
  // C: the colliders drawn as red wireframes over the field, to check they match what is shown.
  let colliderViews = null;
  function toggleColliders() {
    if (!colliderViews) {
      const wire = new THREE.MeshBasicMaterial({ color: "#ff2a2a", wireframe: true, transparent: true, opacity: 0.6, depthTest: false });
      materials.add(wire);
      colliderViews = world.colliders.map(c => {
        const view = new THREE.Mesh(c.object.geometry, wire);
        view.position.copy(c.object.position);
        view.quaternion.copy(c.object.quaternion);
        view.renderOrder = 10;
        c.object.parent.add(view);
        return view;
      });
      return;
    }
    const show = !colliderViews[0]?.visible;
    for (const view of colliderViews) view.visible = show;
  }
  const rideQ = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  const guess = new THREE.Vector3();
  function interpolate(now, dt) {
    if (!buffer.length) return;
    const target = now / 1000 - clockOffset - delay;
    if (playT === null || Math.abs(target - playT) > 1) playT = target;
    else playT += dt * (1 + clamp((target - playT) * CLOCK_EASE, -MAX_SLOWER, MAX_FASTER));
    const rt = playT;
    while (buffer.length > 2 && buffer[1].t <= rt) buffer.shift();
    const newest = buffer[buffer.length - 1];
    if (rt > newest.t) {
      // Ran out of snapshots: keep the tree turning (its motion is known) and the
      // frogs sitting on it turning with it, instead of freezing.
      if (!newest.s.finished) diag.underruns++;
      extrapolating = !newest.s.finished;
      const ahead = newest.s.finished ? 0 : Math.min(rt - newest.t, 0.5);
      const turn = TREE_OMEGA.y * ahead;
      tree.rotation.y = newest.s.tree + turn;
      drawBodies(newest.s.b, null, 1);
      // Frogs in flight carry on along their arc, at the speed of the last two
      // snapshots, so a network stall does not freeze them mid-air.
      const before = buffer[buffer.length - 2];
      const span = before ? newest.t - before.t : 0;
      if (ahead && span > 0) {
        tree.updateMatrixWorld(true);
        const fly = Math.min(ahead, MAX_EXTRAPOLATE);
        for (const b of newest.s.b) {
          const p = before.bodies.get(b[0]);
          const view = views.get(b[0]);
          if (b[9] || !p || !view) continue;
          const vx = (b[2] - p[2]) / span, vy = (b[3] - p[3]) / span, vz = (b[4] - p[4]) / span;
          const flying = vx * vx + vy * vy + vz * vz > FLYING_SPEED * FLYING_SPEED;
          guess.set(view.position.x + vx * fly, view.position.y + vy * fly - (flying ? 0.5 * GRAVITY * fly * fly : 0), view.position.z + vz * fly);
          if (!moveUntilBlocked(view.position, guess)) keepTurning(view.quaternion, p, b, fly / span);
        }
      }
      if (turn) {
        rideQ.setFromAxisAngle(UP, turn);
        for (const b of newest.s.b) {
          if (!b[9]) continue;
          const view = views.get(b[0]);
          if (!view) continue;
          view.position.sub(TREE_CENTRE).applyAxisAngle(UP, turn).add(TREE_CENTRE);
          view.quaternion.premultiply(rideQ);
        }
      }
      leadOwnFrogs(rt, dt);
      return;
    }
    if (extrapolating) {
      extrapolating = false;
      resync = true;
    }
    const a = buffer[0];
    const b = buffer[1] || a;
    const k = b.t > a.t ? clamp((rt - a.t) / (b.t - a.t), 0, 1) : 1;
    // The tree turns at a constant rate: place it by time, not by blending angles.
    tree.rotation.y = a.s.finished ? b.s.tree : a.s.tree + (b.s.tree - a.s.tree) * k;
    drawBodies(b.s.b, a.bodies, k);
    leadOwnFrogs(rt, dt);
  }
  function diagnostics() {
    const avg = list => (list.length ? list.reduce((x, y) => x + y, 0) / list.length : 0);
    const fps = diag.frames.length > 1 ? (diag.frames.length - 1) / ((diag.frames[diag.frames.length - 1] - diag.frames[0]) / 1000) : 0;
    return {
      fps: Math.round(fps),
      mode,
      snapshotsPerSecond: diag.gaps.length ? Math.round(1 / avg(diag.gaps)) : null,
      worstGapMs: diag.gaps.length ? Math.round(Math.max(...diag.gaps) * 1000) : null,
      delayMs: Math.round(delay * 1000),
      underruns: diag.underruns,
      frogs: v.b.length,
      server: diag.server,
    };
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
    // In real-time rounds charging may start during the reload: the simulation
    // fires a shot released early as soon as the launcher is ready.
    const canCharge = realtime ? myTurn() && !(v.cd > 0) : isReady();
    if (e.button !== 0 || !canCharge) return;
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
    if (e.key.toLowerCase() === "c" && !e.repeat) toggleColliders();
    if (e.key === "1" && !e.repeat) special("gun");
    if (e.key === "2" && !e.repeat) special("grenade");
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
  // A blast shakes the camera, fading out.
  let shake = 0;
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
    if (shake > 0) {
      camera.position.x += (Math.random() - 0.5) * shake;
      camera.position.y += (Math.random() - 0.5) * shake;
      shake = Math.max(0, shake - dt * 1.1);
    }
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
    diag.frames.push(now);
    if (diag.frames.length > 60) diag.frames.shift();
    const dt = Math.min((now - previous) / 1000, 0.065);
    previous = now;
    if (sim) {
      sim.advance(dt);
      v = sim.state(true);
      tree.rotation.y = v.tree;
      drawBodies(v.b, null, 1);
      showBlasts(v.ex);
    } else {
      interpolate(now, dt);
      // A shot the host rejected must not lock the player out forever.
      if (own.waitingShot && now - own.waitingSince > 3000) own.waitingShot = false;
    }

    // When this device starts driving a launcher, pick up its aim where it stands.
    fade(dt);
    animateBlasts(dt);
    if (!sim) {
      smooth(dt);
      flyGhosts(dt);
    }
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
      // A loaded special (this player's own, or as reported for the others).
      const armed = driven ? own.armed : ARMED_NAMES[v.l[li]?.[4]] ?? null;
      const showLoaded = !v.finished && active(owner) && (ready || !!armed);
      const colour = players[owner]?.color ?? 0;
      const big = armed === "grenade" ? GRENADE_SIZE * 0.8 : 1;
      L.loaded.forEach((f, i) => {
        f.visible = showLoaded && i === colour;
        f.scale.setScalar(big);
        f.position.y = 0.78 - compression + (big - 1) * 0.2;
      });
      L.glow.visible = !!armed && !v.finished;
      if (armed) {
        L.glow.material.color.set(armed === "grenade" ? "#ff3b2e" : "#ff9a2e");
        L.glow.scale.setScalar(1 + 0.12 * Math.sin(now / 120));
        L.glow.position.y = 0.55 - compression;
      }
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
    sim?.dispose();
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

  return { reset, remoteInput, applySnapshot, setPresent, special, dispose };
}
