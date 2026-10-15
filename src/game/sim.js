// Game rules and physics, without any drawing. Runs in the browser for local
// play and on the game server for online play (server/index.js).
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { buildWorld, layout, mapId, HULL, TREE_CENTRE, TREE_OMEGA } from "./world.js";

export const STEP = 1 / 120;
// Physics: "rubber" (Rapier with frogs of soft rubber, like the real toy's: they
// grip and soak up energy rather than bounce), "rapier" (harder, bouncier frogs),
// or "classic" (the hand-written solver below). Rapier is a Rust engine compiled
// to WebAssembly. The choice is temporary, for comparing.
export const PHYSICS = [
  { id: "rubber", name: "Gumi" },
  { id: "rapier", name: "Rapier" },
  { id: "classic", name: "Régi" },
];
export const physicsId = id => (id === "classic" || id === "rapier" ? id : "rubber");
// Rapier loads its WebAssembly once; createSim needs it done (await this first).
export const physicsReady = RAPIER.init();
// Rapier detects fast contacts continuously (CCD), so 60 steps a second are enough.
const RAPIER_STEP = 1 / 60;
const FROG_FRICTION = 0.9;
const FROG_RESTITUTION = 0.15;
// Rubber frogs: the frog's grip wins over the surface's (Max), its lack of bounce
// too (Min); while touching anything, spin and sliding die away at these rates (1/s).
const RUBBER_FRICTION = 1.6;
const RUBBER_RESTITUTION = 0.02;
const RUBBER_SPIN_DAMPING = 6;
const RUBBER_SLIDE_DAMPING = 2.5;
// Collision groups: frogs of the machine gun in flight skip each other.
const FROG_GROUPS = 0x0001ffff;
const BURST_GROUPS = 0x0002fffd;
export const GRAVITY = 9.8;
const READY_DELAY = 1.2;
// Timed real-time rounds: short reload, a countdown before the start, and a cap
// on frogs in play (physics cost, and a 4 KiB snapshot in the claude.ai room).
export const RT_RELOAD = 0.25;
const MAX_RELOAD = 3;
const RT_COUNTDOWN = 3;
const MAX_BODIES = 48;
// Seconds a frog stays visible after touching the ground.
const GROUND_LINGER = 0.4;
// Speed (relative to the turning tree) at which an arriving frog wakes a sleeping one.
const WAKE_SPEED = 0.8;
// Random tumble a frog leaves the launcher with (rad/s around each axis, ±).
export const LAUNCH_SPIN = [2.5, 3, 2.5];
/** A random tumble within LAUNCH_SPIN (the shooter's screen picks it, so it can predict the shot). */
export const randomTumble = () => LAUNCH_SPIN.map(range => round((Math.random() * 2 - 1) * range));
/**
 * The spin a frog leaves launcher `frame` with. `tumble` [x, y, z] is the random
 * part (kept within LAUNCH_SPIN); without it one is drawn here.
 */
export function launchSpin(frame, spin, tumble) {
  const t = Array.isArray(tumble) && tumble.length === 3
    ? tumble.map((x, k) => clamp(Number(x) || 0, -LAUNCH_SPIN[k], LAUNCH_SPIN[k]))
    : randomTumble();
  return new THREE.Vector3(1.5 + t[0], clamp(spin, -0.35, 0.35) + t[1], t[2]).applyAxisAngle(UP, frame.angle);
}
// A freshly launched frog (this long after launch, at least this fast) knocks the
// frogs it hits: it hands them this share of its velocity, plus a kick upwards.
const KNOCK_TIME = 1.5;
const KNOCK_SPEED = 2.5;
const KNOCK_SHARE = 0.75;
const KNOCK_LIFT = 1.6;
const KNOCK_SPIN = 4;
const spread = range => (Math.random() * 2 - 1) * range;
// Real-time specials. Key 1: a machine gun firing a quick burst of frogs.
export const GUN_COOLDOWN = 30;
const GUN_SHOTS = 15;
const GUN_INTERVAL = 0.07;
// The gun shoots softer than a charged shot, and its frogs neither knock
// others like a fresh shot nor collide with each other while in the air.
// The charge (0–1) a special is fired with maps onto these launch powers.
const GUN_MIN_POWER = 0.2;
const GUN_MAX_POWER = 0.65;
const GRENADE_MIN_POWER = 0.2;
const BURST_GHOST_TIME = 1.2;
// Key 2: a grenade, a big frog that explodes where it lands, throwing the frogs
// around it away (speed falls off with distance up to the blast radius).
export const GRENADE_COOLDOWN = 15;
const GRENADE_SIZE = 2;
const BLAST_RADIUS = 5.5;
const BLAST_SPEED = 22;
const BLAST_LIFT = 10;
const BIG_HULL = HULL.map(h => ({ p: h.p.clone().multiplyScalar(GRENADE_SIZE), r: h.r * GRENADE_SIZE }));

export const SOLO_MESSAGE = "Célozz, tölts, és figyeld a forgó leveleket!";

const clamp = THREE.MathUtils.clamp;
const UP = new THREE.Vector3(0, 1, 0);
export const round = (x, k = 1000) => Math.round(x * k) / k;

/**
 * Where launcher `index` of `count` stands: evenly spaced around the tree,
 * facing it (a single launcher stands in front). Aim is given in the
 * launcher's own plane: x sideways (within ±half), y height.
 */
export function launchFrame(count, index, treeScale = 1) {
  const { radius, scale } = layout(treeScale);
  const angle = count > 1 ? (index / count) * Math.PI * 2 : 0;
  const half = count > 1 ? Math.min(4.2, Math.PI * radius / count - 0.8) : 4.2;
  return { angle, radius, scale, half, sin: Math.sin(angle), cos: Math.cos(angle) };
}
/** A point `out` from the tree's axis in a launcher's frame, in world space. */
export function frameToWorld(frame, x, y, out = frame.radius, target = new THREE.Vector3()) {
  return target.set(
    TREE_CENTRE.x + x * frame.cos + out * frame.sin,
    y,
    TREE_CENTRE.z - x * frame.sin + out * frame.cos,
  );
}
export function launchOrigin(frame, x, y) {
  return frameToWorld(frame, x, y + 0.8, frame.radius - 0.08);
}
export function launchVelocity(frame, x, power) {
  // Bigger trees are taller and stand further away: launch harder.
  const up = (4.6 + power * 5) * Math.sqrt(frame.scale);
  const sideways = -x * 0.08;
  const inward = (6.5 + power * 7) * (1 + (frame.scale - 1) * 0.35);
  return new THREE.Vector3(
    sideways * frame.cos - inward * frame.sin,
    up,
    -sideways * frame.sin - inward * frame.cos,
  );
}

/**
 * options: players [{id, name, color}], frogsPerPlayer, realtime, duration (s),
 * treeScale, maxBodies (frogs in play at once in real-time rounds).
 * Players act through input(playerIndex, {kind: "aim"|"shoot", ...}).
 */
export function createSim(options) {
  const treeScale = layout(options.treeScale).scale;
  const { stageRadius } = layout(treeScale);
  const map = mapId(options.map);
  const physicsKind = physicsId(options.physics);
  const { scene, tree, colliders } = buildWorld({ visual: false, treeScale, map });
  const maxBodies = Number(options.maxBodies) || MAX_BODIES;
  const players = options.players.map(p => ({ ...p, left: false }));
  const frogsPerPlayer = options.frogsPerPlayer;
  const multi = players.length > 1;
  // Real-time: everyone shoots at once from their own launcher, against the clock.
  const realtime = !!options.realtime;
  const duration = clamp(Number(options.duration) || 60, 10, 600);
  // Real-time: seconds a launcher reloads between shots (chosen when the room is set up).
  const reload = options.reload == null ? RT_RELOAD : clamp(Number(options.reload) || 0, 0, MAX_RELOAD);
  // Every player has a launcher around the tree, in turn-based play too.
  const frames = players.map((_, i) => launchFrame(players.length, i, treeScale));
  const hull = HULL;
  const treeOmega = TREE_OMEGA;
  const treeCentre = TREE_CENTRE;

  // Where each launcher aims and how far it is charged (shown to everyone).
  // armed: the special loaded into the launcher (0 none, 1 gun, 2 grenade), shown to everyone.
  const aims = players.map(() => ({ x: 0, y: 0.65, charging: false, power: 0, armed: 0 }));
  const ARMED = { gun: 1, grenade: 2 };

  const g = {
    bodies: [], time: 0, turn: 0, startTurn: 0, shots: players.map(() => 0),
    readyAt: 0, ready: players.map(() => RT_COUNTDOWN), lastShotAt: 0, finished: false, announced: !realtime,
    // Real-time round window (simulation seconds).
    startAt: RT_COUNTDOWN, endAt: RT_COUNTDOWN + duration,
    message: realtime ? "Készülj! Indulás 3 másodperc múlva…"
      : multi ? `${players[0].name} kezd — célozz és tölts!` : SOLO_MESSAGE,
    nextId: 1, accumulator: 0,
    // Specials: when each player's gun and grenade are ready, bursts in progress, recent blasts.
    gunReady: players.map(() => RT_COUNTDOWN), grenadeReady: players.map(() => RT_COUNTDOWN),
    bursts: players.map(() => ({ left: 0, next: 0, power: 0.55 })), blasts: [], nextBlast: 1,
  };

  const name = i => players[i]?.name ?? "?";
  const active = i => players[i] && !players[i].left
    && (realtime ? g.time < g.endAt : g.shots[i] < frogsPerPlayer);
  const allDone = () => !players.some((_, i) => active(i));
  function nextTurn(from) {
    for (let k = 1; k <= players.length; k++) {
      const i = (from + k) % players.length;
      if (active(i)) return i;
    }
    return from;
  }
  function canAct(i) {
    if (g.finished || !active(i)) return false;
    return realtime ? g.time >= g.ready[i] : i === g.turn && g.time >= g.readyAt;
  }
  function scores() {
    const s = players.map(() => 0);
    for (const b of g.bodies) if (b.scored) s[b.owner]++;
    return s;
  }
  function setAim(i, x, y) {
    aims[i].x = clamp(x, -frames[i].half, frames[i].half);
    aims[i].y = clamp(y, 0.38, 2.1);
  }

  // kind: "frog" (a normal shot), "burst" (one of the machine gun's), "grenade".
  function shoot(i, power, spin, kind = "frog", tumble) {
    const aim = aims[i];
    const grenade = kind === "grenade";
    const size = grenade ? GRENADE_SIZE : 1;
    const x = kind === "burst" ? clamp(aim.x + spread(0.4), -frames[i].half, frames[i].half) : aim.x;
    const obj = new THREE.Object3D();
    obj.position.copy(launchOrigin(frames[i], x, aim.y));
    if (grenade) obj.position.y += 0.3;
    // Face the tree, like the frog sitting on the launcher.
    obj.rotation.y = frames[i].angle;
    g.bodies.push({
      id: g.nextId++, owner: i, obj,
      v: launchVelocity(frames[i], x, clamp(power, 0, 1)),
      w: launchSpin(frames[i], spin, tumble),
      grenade, size, hull: grenade ? BIG_HULL : hull, burst: kind === "burst",
      invMass: 1 / (0.6 * size ** 3), invInertia: 1 / (0.045 * size ** 5),
      support: 0, scored: false, lastLeaf: -100,
      lastImpact: -100, launchedAt: g.time, knocked: new Set(),
    });
    if (!grenade) g.shots[i]++;
    g.lastShotAt = g.time;
    if (kind === "frog") {
      aim.charging = false;
      aim.power = 0;
      g.message = multi ? `${name(i)} békája repül…` : "A béka repül — az ütközések döntik el, hol áll meg.";
    } else if (grenade) g.message = multi ? `${name(i)} gránátot lőtt ki!` : "Gránát kilőve!";
    if (realtime) {
      if (kind === "frog") g.ready[i] = g.time + reload;
      if (g.bodies.length > maxBodies) {
        // Drop the oldest frog that is not holding on to the tree (nor a grenade in flight).
        const k = Math.max(0, g.bodies.findIndex(b => !b.scored && !b.grenade));
        g.bodies.splice(k, 1);
      }
    } else {
      g.readyAt = g.time + READY_DELAY;
      g.turn = nextTurn(i);
      g.announced = false;
    }
  }

  /** A player's action. Anything not allowed right now is ignored. */
  function input(i, data) {
    if (!data || !players[i] || g.finished || !active(i) || (!realtime && i !== g.turn)) return;
    const x = Number(data.x);
    const y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    setAim(i, x, y);
    if (data.kind === "aim") {
      const charging = !!data.charging;
      if (charging && !aims[i].charging && !realtime) g.message = "Tartsd nyomva, majd engedd el!";
      aims[i].charging = charging;
      aims[i].power = clamp(Number(data.power) || 0, 0, 1);
      aims[i].armed = ARMED[data.armed] || 0;
    } else if (data.kind === "shoot" && canAct(i)) {
      shoot(i, Number(data.power) || 0, Number(data.spin) || 0, "frog", data.tumble);
    } else if (data.kind === "gun" || data.kind === "grenade") {
      special(i, data.kind, Number(data.power) || 0);
    } else if (data.kind === "shoot" && realtime && g.time < g.ready[i] && g.ready[i] - g.time <= reload) {
      // Released while still reloading (the player may start charging at once):
      // fire it the moment the launcher is ready instead of dropping it.
      queued[i] = { x: aims[i].x, y: aims[i].y, power: Number(data.power) || 0, spin: Number(data.spin) || 0, tumble: data.tumble };
    }
  }
  // Real-time only, once the round has started; each has its own cooldown.
  // power: the charge it was fired with (0–1).
  function special(i, kind, power) {
    power = clamp(power, 0, 1);
    if (!realtime || g.time < g.startAt) return;
    if (kind === "gun" && g.time >= g.gunReady[i]) {
      g.gunReady[i] = g.time + GUN_COOLDOWN;
      Object.assign(g.bursts[i], { left: GUN_SHOTS, next: g.time, power: GUN_MIN_POWER + power * (GUN_MAX_POWER - GUN_MIN_POWER) });
      g.message = multi ? `${name(i)} bekapcsolta a gépágyút!` : "Gépágyú! Békazápor indul…";
    } else if (kind === "grenade" && g.time >= g.grenadeReady[i]) {
      g.grenadeReady[i] = g.time + GRENADE_COOLDOWN;
      shoot(i, GRENADE_MIN_POWER + power * (1 - GRENADE_MIN_POWER), 0, "grenade");
    }
  }
  function fireBursts() {
    g.bursts.forEach((burst, i) => {
      if (!active(i) || g.finished) burst.left = 0;
      while (burst.left > 0 && g.time >= burst.next) {
        burst.left--;
        burst.next += GUN_INTERVAL;
        shoot(i, clamp(burst.power + spread(0.08), 0, 1), spread(0.3), "burst");
      }
    });
  }
  // A grenade going off: every frog within the blast radius is thrown away from it.
  function explode(grenade) {
    const at = grenade.obj.position;
    g.bodies.splice(g.bodies.indexOf(grenade), 1);
    g.blasts.push({ id: g.nextBlast++, t: g.time, x: at.x, y: at.y, z: at.z });
    let thrown = 0;
    for (const b of g.bodies) {
      const d = b.obj.position.distanceTo(at);
      if (d > BLAST_RADIUS) continue;
      const strength = 1 - (d / BLAST_RADIUS) ** 2;
      const away = temp.copy(b.obj.position).sub(at);
      if (away.lengthSq() < 1e-6) away.set(0, 1, 0);
      away.normalize();
      b.sleeping = false;
      b.still = 0;
      b.v.addScaledVector(away, BLAST_SPEED * strength);
      b.v.y += BLAST_LIFT * strength;
      b.w.add(new THREE.Vector3(spread(8), spread(8), spread(8)).multiplyScalar(strength));
      b.dirty = true;
      thrown++;
    }
    if (!g.finished) g.message = thrown ? `BUMM! ${thrown} béka repült szét.` : "BUMM! Senki nem volt a közelben.";
  }
  const queued = players.map(() => null);
  function fireQueued() {
    queued.forEach((q, i) => {
      if (!q || !canAct(i)) return;
      queued[i] = null;
      setAim(i, q.x, q.y);
      shoot(i, q.power, q.spin, "frog", q.tumble);
    });
  }

  function reset() {
    queued.fill(null);
    g.bursts.forEach(b => { b.left = 0; });
    g.gunReady = players.map(() => g.time + RT_COUNTDOWN);
    g.grenadeReady = players.map(() => g.time + RT_COUNTDOWN);
    g.blasts = [];
    g.startTurn = multi && !realtime ? (g.startTurn + 1) % players.length : 0;
    Object.assign(g, {
      bodies: [], shots: players.map(() => 0), finished: false,
      readyAt: g.time, ready: players.map(() => g.time + RT_COUNTDOWN), lastShotAt: g.time, announced: !realtime,
      startAt: g.time + RT_COUNTDOWN, endAt: g.time + RT_COUNTDOWN + duration,
    });
    g.turn = active(g.startTurn) ? g.startTurn : nextTurn(g.startTurn);
    g.message = realtime ? "Új kör! Készülj, indulás 3 másodperc múlva…"
      : multi ? `${name(g.turn)} kezd — célozz és tölts!` : SOLO_MESSAGE;
    aims.forEach(aim => Object.assign(aim, { x: 0, y: 0.65, charging: false, power: 0, armed: 0 }));
  }

  /** Marks players who are no longer connected; their turns are skipped. */
  function setPresent(ids) {
    const present = new Set(ids);
    players.forEach(p => { p.left = !present.has(p.id); });
    if (!realtime && !active(g.turn) && !allDone()) {
      g.turn = nextTurn(g.turn);
      aims.forEach(aim => { aim.charging = false; });
      g.announced = false;
    }
  }

  // Sequential-impulse rigid-body solver with Coulomb friction.
  // Triangle colliders are kinematic: their surface velocity includes rotation.
  const closest = new THREE.Vector3();
  const local = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const deltaQ = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const temp = new THREE.Vector3();
  const temp2 = new THREE.Vector3();
  const temp3 = new THREE.Vector3();
  const contactVelocity = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const impulseVector = new THREE.Vector3();
  const stack = new Int32Array(64);
  const rideQ = new THREE.Quaternion();
  const offset = new THREE.Vector3();

  function surfaceVelocity(c, point) {
    if (!c.moving) return new THREE.Vector3();
    return new THREE.Vector3().crossVectors(treeOmega, point.clone().sub(treeCentre));
  }
  function makeContact(a, b, point, normal, depth, surface, friction, restitution, leafContact = false) {
    const ra = point.clone().sub(a.obj.position);
    const rb = b ? point.clone().sub(b.obj.position) : null;
    const va = a.v.clone().add(new THREE.Vector3().crossVectors(a.w, ra));
    const vb = b ? b.v.clone().add(new THREE.Vector3().crossVectors(b.w, rb)) : surface;
    const vn = va.sub(vb).dot(normal);
    return {
      a, b, point, normal, depth, surface, friction, ra, rb,
      normalImpulse: 0, frictionImpulse: new THREE.Vector3(),
      bounce: vn < -1.1 ? -restitution * vn : 0,
      leafContact,
    };
  }
  function applyImpulse(b, impulse, r, sign) {
    if (b.sleeping) return;
    b.v.addScaledVector(impulse, b.invMass * sign);
    temp.crossVectors(r, impulse);
    b.w.addScaledVector(temp, b.invInertia * sign);
  }
  function effectiveMass(c, direction) {
    temp.crossVectors(c.ra, direction);
    let inverse = c.a.invMass + temp.lengthSq() * c.a.invInertia;
    if (c.b && !c.b.sleeping) {
      temp.crossVectors(c.rb, direction);
      inverse += c.b.invMass + temp.lengthSq() * c.b.invInertia;
    }
    return inverse;
  }
  function relativeVelocity(c) {
    contactVelocity.crossVectors(c.a.w, c.ra).add(c.a.v);
    if (c.b) {
      temp2.crossVectors(c.b.w, c.rb).add(c.b.v);
      contactVelocity.sub(temp2);
    } else contactVelocity.sub(c.surface);
    return contactVelocity;
  }
  function solve(c) {
    const vn = relativeVelocity(c).dot(c.normal);
    const lambda = (c.bounce - vn) / effectiveMass(c, c.normal);
    const previous = c.normalImpulse;
    c.normalImpulse = Math.max(0, previous + lambda);
    impulseVector.copy(c.normal).multiplyScalar(c.normalImpulse - previous);
    applyImpulse(c.a, impulseVector, c.ra, 1);
    if (c.b) applyImpulse(c.b, impulseVector, c.rb, -1);

    relativeVelocity(c);
    tangent.copy(contactVelocity).addScaledVector(c.normal, -contactVelocity.dot(c.normal));
    const speed = tangent.length();
    if (speed > 0.00001) {
      tangent.multiplyScalar(1 / speed);
      const frictionLambda = -speed / effectiveMass(c, tangent);
      temp3.copy(c.frictionImpulse).addScaledVector(tangent, frictionLambda);
      const maxFriction = c.friction * c.normalImpulse;
      if (temp3.lengthSq() > maxFriction * maxFriction) temp3.setLength(maxFriction);
      impulseVector.copy(temp3).sub(c.frictionImpulse);
      c.frictionImpulse.copy(temp3);
      applyImpulse(c.a, impulseVector, c.ra, 1);
      if (c.b) applyImpulse(c.b, impulseVector, c.rb, -1);
    }
  }
  // A fresh shot striking another frog: knocks it hard (once per pair), so frogs
  // on the tree can be shot off. Returns whether it did.
  function knock(shot, hit) {
    if (shot.grenade || hit.grenade || shot.burst || shot.launchedAt === undefined || g.time - shot.launchedAt > KNOCK_TIME || shot.knocked.has(hit.id)) return false;
    if (shot.v.lengthSq() < KNOCK_SPEED * KNOCK_SPEED) return false;
    // Only when their hulls actually touch.
    let touching = false;
    for (const ha of shot.hull) {
      const pa = temp.copy(ha.p).applyQuaternion(shot.obj.quaternion).add(shot.obj.position);
      for (const hb of hit.hull) {
        const pb = temp2.copy(hb.p).applyQuaternion(hit.obj.quaternion).add(hit.obj.position);
        if (pa.distanceToSquared(pb) < (ha.r + hb.r) ** 2) touching = true;
      }
    }
    if (!touching) return false;
    shot.knocked.add(hit.id);
    hit.dirty = shot.dirty = true;
    hit.sleeping = false;
    hit.still = 0;
    hit.v.addScaledVector(shot.v, KNOCK_SHARE);
    hit.v.y += KNOCK_LIFT;
    hit.w.add(new THREE.Vector3(spread(KNOCK_SPIN), spread(KNOCK_SPIN), spread(KNOCK_SPIN)));
    shot.v.multiplyScalar(1 - KNOCK_SHARE * 0.5);
    if (!g.finished) g.message = multi ? `${name(shot.owner)} békája eltalált egy békát!` : "Telitalálat! Meglökted a békát.";
    return true;
  }
  // One physics step: the engine moves the frogs, then the game rules look at them.
  function physics(dt) {
    g.time += dt;
    tree.rotation.y += treeOmega.y * dt;
    if (rapier) rapier.step(dt);
    else classicStep(dt);
    rules(dt);
  }

  function classicStep(dt) {
    scene.updateMatrixWorld(true);
    for (const c of colliders) {
      c.inverse.copy(c.object.matrixWorld).invert();
      c.object.getWorldQuaternion(c.rotation);
      c.worldBound.copy(c.bound).applyMatrix4(c.object.matrixWorld);
    }
    // Frogs asleep on the tree ride along with it, costing no collision work.
    rideQ.setFromAxisAngle(UP, treeOmega.y * dt);
    for (const b of g.bodies) {
      if (!b.sleeping) continue;
      offset.copy(b.obj.position).sub(treeCentre).applyAxisAngle(UP, treeOmega.y * dt);
      b.obj.position.copy(treeCentre).add(offset);
      b.obj.quaternion.premultiply(rideQ).normalize();
      b.v.crossVectors(treeOmega, offset);
      b.w.copy(treeOmega);
      b.lastLeaf = g.time;
    }
    for (const b of g.bodies) {
      if (b.sleeping) continue;
      b.v.y -= GRAVITY * dt;
      b.v.multiplyScalar(Math.exp(-0.035 * dt));
      b.w.multiplyScalar(Math.exp(-0.24 * dt));
      b.obj.position.addScaledVector(b.v, dt);
      const spin = b.w.length();
      if (spin > 0.00001) {
        axis.copy(b.w).multiplyScalar(1 / spin);
        deltaQ.setFromAxisAngle(axis, spin * dt);
        b.obj.quaternion.premultiply(deltaQ).normalize();
      }
    }
    const contacts = [];
    for (const b of g.bodies) {
      if (b.sleeping) continue;
      for (const h of b.hull) {
        centre.copy(h.p).applyQuaternion(b.obj.quaternion).add(b.obj.position);
        // The raised round stage around the tree: a flat disc at y = 0.
        const sx = centre.x - treeCentre.x;
        const sz = centre.z - treeCentre.z;
        if (centre.y - h.r < 0 && centre.y > -0.3 && sx * sx + sz * sz < stageRadius * stageRadius) {
          b.groundedAt ??= g.time;
          const point = new THREE.Vector3(centre.x, 0, centre.z);
          contacts.push(makeContact(b, null, point, new THREE.Vector3(0, 1, 0),
            -(centre.y - h.r), new THREE.Vector3(), 0.8, 0.15));
        }
        // Infinite floor beneath the raised tabletop.
        if (centre.y - h.r < -0.25) {
          b.groundedAt ??= g.time;
          const point = new THREE.Vector3(centre.x, -0.25, centre.z);
          contacts.push(makeContact(b, null, point, new THREE.Vector3(0, 1, 0),
            -0.25 - (centre.y - h.r), new THREE.Vector3(), 0.85, 0.15));
        }
        for (const c of colliders) {
          const radius = c.worldBound.radius + h.r + 0.015;
          if (centre.distanceToSquared(c.worldBound.center) > radius * radius) continue;
          // Physical colliders have unit scale; transforms contain translation and rotation only.
          local.copy(centre).applyMatrix4(c.inverse);
          let bestDistance = Infinity;
          let bestPoint = null;
          let bestTriangle = null;
          // Walk the collider's bounding-sphere tree down to the triangles near this sphere.
          const { triangles, nodes } = c;
          let top = 0;
          stack[top++] = 0;
          while (top > 0) {
            const o = stack[--top] * 6;
            const dx = local.x - nodes[o];
            const dy = local.y - nodes[o + 1];
            const dz = local.z - nodes[o + 2];
            const reach = nodes[o + 3] + h.r;
            if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
            const second = nodes[o + 5];
            if (second > 0) {
              stack[top++] = nodes[o + 4];
              stack[top++] = second;
              continue;
            }
            for (let k = nodes[o + 4], last = -second; k < last; k++) {
              const triangle = triangles[k];
              triangle.closestPointToPoint(local, closest);
              const distance = closest.distanceToSquared(local);
              if (distance < bestDistance && distance < h.r * h.r) {
                bestDistance = distance;
                if (!bestPoint) bestPoint = new THREE.Vector3();
                bestPoint.copy(closest);
                bestTriangle = triangle;
              }
            }
          }
          if (!bestPoint) continue;
          const distance = Math.sqrt(bestDistance);
          const normal = local.clone().sub(bestPoint);
          if (distance > 0.000001) normal.multiplyScalar(1 / distance);
          else bestTriangle.getNormal(normal);
          normal.applyQuaternion(c.rotation).normalize();
          const point = bestPoint.applyMatrix4(c.object.matrixWorld);
          contacts.push(makeContact(b, null, point, normal, h.r - distance,
            surfaceVelocity(c, point), c.friction, c.restitution, c.kind === "leaf"));
        }
      }
    }

    // Compound-hull frog/frog contacts, including angular response.
    for (let i = 0; i < g.bodies.length; i++) {
      const a = g.bodies[i];
      for (let j = i + 1; j < g.bodies.length; j++) {
        const b = g.bodies[j];
        if (a.sleeping && b.sleeping) continue;
        if (a.burst && b.burst && g.time - a.launchedAt < BURST_GHOST_TIME && g.time - b.launchedAt < BURST_GHOST_TIME) continue;
        if (a.obj.position.distanceToSquared(b.obj.position) > 1.1 * ((a.size + b.size) / 2) ** 2) continue;
        // A frog arriving fast wakes a sleeping one, so it can be knocked off; one
        // just sitting next to it meets it as a fixed obstacle.
        if (a.sleeping || b.sleeping) {
          const mover = a.sleeping ? b : a;
          offset.copy(mover.obj.position).sub(treeCentre);
          if (temp.crossVectors(treeOmega, offset).sub(mover.v).lengthSq() > WAKE_SPEED * WAKE_SPEED) {
            a.sleeping = b.sleeping = false;
            a.still = b.still = 0;
          }
        }
        knock(a, b) || knock(b, a);
        // The solver moves the first body of a contact: keep a sleeping frog second.
        const [first, second] = a.sleeping ? [b, a] : [a, b];
        for (const ha of first.hull) {
          const pa = ha.p.clone().applyQuaternion(first.obj.quaternion).add(first.obj.position);
          for (const hb of second.hull) {
            const pb = hb.p.clone().applyQuaternion(second.obj.quaternion).add(second.obj.position);
            const n = pa.clone().sub(pb);
            const distance = n.length();
            const radius = ha.r + hb.r;
            if (distance >= radius) continue;
            if (distance < 0.000001) n.set(0, 1, 0);
            else n.multiplyScalar(1 / distance);
            const point = pa.clone().addScaledVector(n, -ha.r + (radius - distance) * 0.5);
            contacts.push(makeContact(first, second, point, n, radius - distance, new THREE.Vector3(), 0.65, 0.14));
          }
        }
      }
    }
    // Multiple iterations distribute collision impulses across the compound hull.
    for (let iteration = 0; iteration < 9; iteration++) {
      for (const c of contacts) solve(c);
    }

    // Small, split positional corrections remove penetration without adding bounce energy.
    const corrections = new Map();
    for (const c of contacts) {
      const depth = Math.max(0, c.depth - 0.002);
      if (depth > 0) {
        const totalInverseMass = c.a.invMass + (c.b && !c.b.sleeping ? c.b.invMass : 0);
        const amount = Math.min(depth * 0.55, 0.035);
        for (const [b, sign] of [[c.a, 1], [c.b, -1]]) {
          if (!b || b.sleeping) continue;
          let correction = corrections.get(b);
          if (!correction) {
            correction = { delta: new THREE.Vector3(), count: 0 };
            corrections.set(b, correction);
          }
          correction.delta.addScaledVector(c.normal, amount * sign * b.invMass / totalInverseMass);
          correction.count++;
        }
      }
      if (c.leafContact && c.normal.y > 0.5) {
        const rel = c.a.v.clone().sub(c.surface);
        if (rel.length() < 2.2) c.a.lastLeaf = g.time;
      }
      if (c.normalImpulse > 0.2 && g.time - c.a.lastImpact > 0.35 && c.a.v.length() > 2) {
        c.a.lastImpact = g.time;
        if (!g.finished) g.message = c.leafContact ? "Levélérintés! Meg tud kapaszkodni?" : "Ütközés! A béka tovább pattanhat.";
      }
    }
    for (const [b, correction] of corrections) {
      b.obj.position.addScaledVector(correction.delta, 1 / Math.max(1, correction.count));
    }

    // A grenade explodes on its first impact (with anything: tree, frog or ground).
    const hitGrenades = new Set();
    for (const c of contacts) {
      for (const b of [c.a, c.b]) if (b?.grenade && g.time - b.launchedAt > 0.05) hitGrenades.add(b);
    }
    for (const b of hitGrenades) explode(b);
  }

  // Scoring, sleeping, frogs leaving the game, and the round's progress.
  function rules(dt) {
    for (const b of g.bodies) {
      // A frog holding still on the tree (relative to the turning tree) falls asleep
      // (classic physics; Rapier puts bodies to sleep itself).
      if (!rapier && b.scored && !b.sleeping) {
        offset.copy(b.obj.position).sub(treeCentre);
        temp.crossVectors(treeOmega, offset);
        const calm = temp.sub(b.v).lengthSq() < 0.0144 && temp2.copy(b.w).sub(treeOmega).lengthSq() < 0.09;
        b.still = calm ? (b.still || 0) + dt : 0;
        if (b.still > 0.6) b.sleeping = true;
      }
      const supported = g.time - b.lastLeaf < 0.08;
      b.support = supported ? b.support + dt : Math.max(0, b.support - dt * 4);
      const before = b.scored;
      if (b.support > 0.7) b.scored = true;
      if (!supported && b.support <= 0) b.scored = false;
      if (!before && b.scored && !g.finished) {
        g.message = multi
          ? `${name(b.owner)} békája megkapaszkodott a levélen!`
          : "Megmaradt a levélen! Vigyázz, egy másik béka lelökheti.";
      }
      if (before && !b.scored && !g.finished) {
        g.message = multi
          ? `${name(b.owner)} békája lecsúszott — oda a pont.`
          : "Lecsúszott a béka — a pontját is elveszítetted.";
      }
    }

    // A frog that reaches the ground is out of the game and disappears shortly after;
    // so does one that comes to rest below the leaves (e.g. on the tree's pedestal).
    for (let k = g.bodies.length - 1; k >= 0; k--) {
      const b = g.bodies[k];
      if (b.scored) continue;
      // Below the leaves, or on the pedestal or what stands on it (a plinth, mud).
      const low = b.obj.position.y < 1.5 || g.time - (b.onBase ?? -100) < 0.1;
      const resting = low && b.v.lengthSq() < 0.16;
      b.rest = resting ? (b.rest || 0) + dt : 0;
      b.low = low ? (b.low || 0) + dt : 0;
      if (b.groundedAt !== undefined && g.time - b.groundedAt > GROUND_LINGER || b.rest > 1.2 || b.low > 2) {
        g.bodies.splice(k, 1);
      }
    }

    if (realtime) {
      if (!g.announced && g.time >= g.startAt) {
        g.announced = true;
        g.message = "Rajt! Lőj, amennyit csak tudsz!";
      }
      if (g.time >= g.endAt && g.time - dt < g.endAt) g.message = "Lejárt az idő! A békák még mozoghatnak…";
    }

    if (!realtime && !g.announced && g.time >= g.readyAt && !allDone()) {
      g.announced = true;
      if (multi) g.message = `${name(g.turn)} következik — célozz és tölts!`;
    }

    if (allDone() && !g.finished) {
      const elapsed = g.time - (realtime ? Math.max(g.lastShotAt, g.endAt) : g.lastShotAt);
      const moving = g.bodies.some(b => {
        const expected = new THREE.Vector3().crossVectors(treeOmega, b.obj.position.clone().sub(treeCentre));
        return b.scored ? b.v.clone().sub(expected).length() > 0.9 : b.v.length() > 0.8;
      });
      if (elapsed > 7 || (elapsed > 3.5 && !moving)) {
        g.finished = true;
        g.charging = false;
        // Only the frogs holding on to the tree stay on screen for the result.
        g.bodies = g.bodies.filter(b => b.scored);
        g.message = "Kör vége! A pontszámot a fán megmaradt békák adják.";
      }
    }
  }


  /** Advances real time `dt` seconds in fixed physics steps. */
  function advance(dt) {
    if (g.finished) {
      g.accumulator = 0;
      return;
    }
    if (realtime) {
      fireQueued();
      fireBursts();
    }
    g.accumulator += Math.min(dt, 0.25);
    let steps = 0;
    const step = rapier ? RAPIER_STEP : STEP;
    while (g.accumulator >= step && steps < 30) {
      physics(step);
      g.accumulator -= step;
      steps++;
      if (g.finished) break;
    }
  }

  /**
   * Everything a screen needs to draw the game. Rounded (`exact` false) it is
   * compact enough to send 20 times a second, even for 48 frogs in a 4 KiB message.
   * `grid`: positions are rounded to 1/grid m (the game server, with no size limit, sends millimetres).
   */
  function state(exact = false, grid = 100) {
    const r = exact ? x => x : round;
    return {
      // Simulation clock: lets screens interpolate by when things happened, not when they arrived.
      t: round(g.time),
      tree: exact ? tree.rotation.y : round(tree.rotation.y, 10000),
      b: g.bodies.map(b => {
        const p = b.obj.position;
        const q = b.obj.quaternion;
        return [b.id, b.owner, r(p.x, grid), r(p.y, grid), r(p.z, grid),
          r(q.x), r(q.y), r(q.z), r(q.w), b.scored ? 1 : 0, b.grenade ? 1 : 0];
      }),
      // Per launcher: aim x, aim y, charging, power.
      l: aims.map(a => [r(a.x, 100), r(a.y, 100), a.charging ? 1 : 0, r(a.power, 100), a.armed]),
      turn: g.turn,
      shots: g.shots.slice(),
      tl: realtime ? round(Math.max(0, Math.min(duration, g.endAt - g.time)), 10) : 0,
      cd: realtime ? Math.max(0, Math.ceil(g.startAt - g.time)) : 0,
      scores: scores(),
      ready: players.map((_, i) => (canAct(i) ? 1 : 0)),
      finished: g.finished ? 1 : 0,
      msg: g.message,
      left: players.map(p => (p.left ? 1 : 0)),
      // Per player: seconds until the gun and the grenade are ready (0: ready).
      sp: realtime ? players.map((_, i) => [g.gunReady[i], g.grenadeReady[i]].map(t => round(Math.max(0, t - g.time), 10))) : [],
      // Blasts of the last second: [id, x, y, z].
      ex: g.blasts.filter(e => g.time - e.t < 1).map(e => [e.id, r(e.x, 100), r(e.y, 100), r(e.z, 100)]),
    };
  }

  // --- Rapier ---------------------------------------------------------------------
  // Each frog is a dynamic body with one ball collider per hull sphere and
  // continuous collision detection; the tree is a kinematic body turned every
  // step; pedestal, stage and floor are fixed. After each step the bodies'
  // state is copied to the frogs (obj, v, w), which the game rules work on;
  // velocities the rules change (knocks, blasts) go back marked `dirty`.
  function makeRapier(rubber) {
    const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    world.timestep = RAPIER_STEP;
    // Collider handle -> { kind } for the field, { frog } for a frog's sphere.
    const info = new Map();
    scene.updateMatrixWorld(true);
    const toTree = tree.matrixWorld.clone().invert();
    const treeBody = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(treeCentre.x, treeCentre.y, treeCentre.z));
    const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const matrix = new THREE.Matrix4();
    const point = new THREE.Vector3();
    for (const c of colliders) {
      const pos = c.object.geometry.attributes.position;
      const index = c.object.geometry.index;
      matrix.copy(c.object.matrixWorld);
      if (c.moving) matrix.premultiply(toTree);
      const vertices = new Float32Array(pos.count * 3);
      for (let k = 0; k < pos.count; k++) {
        point.fromBufferAttribute(pos, k).applyMatrix4(matrix);
        vertices[k * 3] = point.x;
        vertices[k * 3 + 1] = point.y;
        vertices[k * 3 + 2] = point.z;
      }
      const indices = index ? Uint32Array.from(index.array) : Uint32Array.from({ length: pos.count }, (_, k) => k);
      const desc = RAPIER.ColliderDesc.trimesh(vertices, indices).setFriction(c.friction).setRestitution(c.restitution);
      info.set(world.createCollider(desc, c.moving ? treeBody : fixed).handle, { kind: c.kind });
    }
    const stage = RAPIER.ColliderDesc.cylinder(0.125, stageRadius)
      .setTranslation(treeCentre.x, -0.125, treeCentre.z).setFriction(0.8).setRestitution(0.15);
    info.set(world.createCollider(stage, fixed).handle, { kind: "ground" });
    const floor = RAPIER.ColliderDesc.cuboid(150, 0.5, 150).setTranslation(0, -0.75, 0).setFriction(0.85).setRestitution(0.15);
    info.set(world.createCollider(floor, fixed).handle, { kind: "ground" });

    const live = new Map();
    function add(b) {
      const q = b.obj.quaternion;
      const p = b.obj.position;
      const inertia = 0.045 * b.size ** 5;
      const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinvel(b.v.x, b.v.y, b.v.z).setAngvel({ x: b.w.x, y: b.w.y, z: b.w.z })
        .setLinearDamping(0.035).setAngularDamping(0.24).setCcdEnabled(true)
        .setAdditionalMassProperties(0.6 * b.size ** 3, { x: 0, y: 0, z: 0 },
          { x: inertia, y: inertia, z: inertia }, { x: 0, y: 0, z: 0, w: 1 }));
      b.cols = b.hull.map(h => {
        const desc = RAPIER.ColliderDesc.ball(h.r).setTranslation(h.p.x, h.p.y, h.p.z)
          .setDensity(0).setFriction(rubber ? RUBBER_FRICTION : FROG_FRICTION)
          .setRestitution(rubber ? RUBBER_RESTITUTION : FROG_RESTITUTION)
          .setFrictionCombineRule(rubber ? RAPIER.CoefficientCombineRule.Max : RAPIER.CoefficientCombineRule.Average)
          .setRestitutionCombineRule(rubber ? RAPIER.CoefficientCombineRule.Min : RAPIER.CoefficientCombineRule.Average)
          .setCollisionGroups(b.burst ? BURST_GROUPS : FROG_GROUPS);
        const col = world.createCollider(desc, rb);
        info.set(col.handle, { frog: b });
        return col;
      });
      b.rb = rb;
      live.set(b, rb);
    }
    function remove(b, rb) {
      for (const col of b.cols) info.delete(col.handle);
      world.removeRigidBody(rb);
      live.delete(b);
      b.rb = null;
    }

    const turn = new THREE.Quaternion();
    const surface = new THREE.Vector3();
    function step(dt) {
      // Frogs added or dropped by the rules since the last step.
      const present = new Set(g.bodies);
      for (const [b, rb] of live) if (!present.has(b)) remove(b, rb);
      for (const b of g.bodies) {
        if (!b.rb) add(b);
        else if (b.dirty) {
          b.rb.setLinvel({ x: b.v.x, y: b.v.y, z: b.v.z }, true);
          b.rb.setAngvel({ x: b.w.x, y: b.w.y, z: b.w.z }, true);
        }
        b.dirty = false;
        // A burst's frog meets the others of its kind once it has landed.
        if (b.burst && !b.landedGroups && g.time - b.launchedAt > BURST_GHOST_TIME) {
          b.landedGroups = true;
          for (const col of b.cols) col.setCollisionGroups(FROG_GROUPS);
        }
      }
      turn.setFromAxisAngle(UP, tree.rotation.y);
      treeBody.setNextKinematicRotation({ x: turn.x, y: turn.y, z: turn.z, w: turn.w });
      world.timestep = dt;
      world.step();
      for (const b of g.bodies) {
        const t = b.rb.translation();
        const r = b.rb.rotation();
        const v = b.rb.linvel();
        const w = b.rb.angvel();
        b.obj.position.set(t.x, t.y, t.z);
        b.obj.quaternion.set(r.x, r.y, r.z, r.w);
        b.v.set(v.x, v.y, v.z);
        b.w.set(w.x, w.y, w.z);
        b.sleeping = b.rb.isSleeping();
      }
      // What each moving frog touches: leaves (for scoring), other frogs (knocks),
      // the ground, anything at all (a grenade goes off).
      const blown = [];
      for (const b of [...g.bodies]) {
        if (b.sleeping) continue;
        let touched = false;
        let onLeaf = false;
        let leafHit = false;
        for (const col of b.cols) {
          world.contactPairsWith(col, other => {
            const o = info.get(other.handle);
            if (!o || o.frog === b) return;
            world.contactPair(col, other, (manifold, flipped) => {
              // Touching: a contact point within a hair's breadth (manifolds with
              // the kinematic tree carry no solver contacts after the step).
              let near = false;
              for (let k = 0; k < manifold.numContacts(); k++) if (manifold.contactDist(k) < 0.03) near = true;
              if (!near) return;
              touched = true;
              if (o.frog) knock(b, o.frog) || knock(o.frog, b);
              else if (o.kind === "ground") b.groundedAt ??= g.time;
              else if (o.kind === "base") b.onBase = g.time;
              else if (o.kind === "leaf") {
                leafHit = true;
                // Only from above: the normal points from the first shape to the
                // second, so up from the leaf to this frog is +y when flipped.
                const up = flipped ? manifold.normal().y : -manifold.normal().y;
                if (up > 0.5) onLeaf = true;
              }
            });
          });
        }
        if (onLeaf) {
          surface.copy(b.obj.position).sub(treeCentre);
          surface.crossVectors(treeOmega, surface);
          if (surface.sub(b.v).length() < 2.2) b.lastLeaf = g.time;
        }
        if (touched && g.time - b.lastImpact > 0.35 && b.v.length() > 2) {
          b.lastImpact = g.time;
          if (!g.finished) g.message = leafHit ? "Levélérintés! Meg tud kapaszkodni?" : "Ütközés! A béka tovább pattanhat.";
        }
        if (b.grenade && touched && g.time - b.launchedAt > 0.05) blown.push(b);
        // Rubber soaks up energy while it touches something: spin and sliding
        // (relative to the turning tree) fade fast.
        if (rubber && touched && !b.grenade) {
          surface.copy(b.obj.position).sub(treeCentre);
          surface.crossVectors(treeOmega, surface);
          b.v.sub(surface).multiplyScalar(Math.exp(-RUBBER_SLIDE_DAMPING * dt)).add(surface);
          b.w.multiplyScalar(Math.exp(-RUBBER_SPIN_DAMPING * dt));
          b.dirty = true;
        }
      }
      for (const b of blown) if (g.bodies.includes(b)) explode(b);
    }
    return { step, dispose: () => world.free() };
  }
  const rapier = physicsKind === "classic" ? null : makeRapier(physicsKind === "rubber");

  return { players, realtime, reload, treeScale, map, physics: physicsKind, dispose: () => rapier?.dispose(), debugBodies: () => g.bodies, input, reset, setPresent, advance, state, indexOf: id => players.findIndex(p => p.id === id) };
}
