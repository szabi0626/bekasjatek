// Game rules and physics, without any drawing. Runs in the browser for local
// play and on the game server for online play (server/index.js).
import * as THREE from "three";
import { buildWorld, HULL, LAUNCH_Z, TREE_CENTRE, TREE_OMEGA } from "./world.js";

export const STEP = 1 / 120;
export const GRAVITY = 9.8;
const READY_DELAY = 1.2;
// Timed real-time rounds: short reload, a countdown before the start, and a cap
// on frogs in play (physics cost, and a 4 KiB snapshot in the claude.ai room).
const RT_RELOAD = 0.45;
const RT_COUNTDOWN = 3;
const MAX_BODIES = 48;
const STAGE = { x: 0, z: -0.4, r: 8.7 };

export const SOLO_MESSAGE = "Célozz, tölts, és figyeld a forgó leveleket!";

const clamp = THREE.MathUtils.clamp;
export const round = (x, k = 1000) => Math.round(x * k) / k;

/** Horizontal aiming range of launcher `li` when there are `lanes` launchers. */
export function laneRange(lanes, li) {
  if (lanes <= 1) return [-4.2, 4.2];
  const w = 8.4 / lanes;
  const a = -4.2 + w * li;
  return [a + 0.35, a + w - 0.35];
}
export function launchOrigin(x, y) {
  return new THREE.Vector3(x, y + 0.8, LAUNCH_Z - 0.08);
}
export function launchVelocity(x, power) {
  return new THREE.Vector3(-x * 0.08, 4.6 + power * 5, -(6.5 + power * 7));
}

/**
 * options: players [{id, name, color}], frogsPerPlayer, realtime, duration (s).
 * Players act through input(playerIndex, {kind: "aim"|"shoot", ...}).
 */
export function createSim(options) {
  const { scene, tree, colliders } = buildWorld({ visual: false });
  const players = options.players.map(p => ({ ...p, left: false }));
  const frogsPerPlayer = options.frogsPerPlayer;
  const multi = players.length > 1;
  // Real-time: everyone shoots at once from their own launcher, against the clock.
  const realtime = !!options.realtime && multi;
  const duration = clamp(Number(options.duration) || 60, 10, 600);
  const lanes = realtime ? players.length : 1;
  const hull = HULL;
  const treeOmega = TREE_OMEGA;
  const treeCentre = TREE_CENTRE;

  // Where each launcher aims and how far it is charged (shown to everyone).
  const aims = Array.from({ length: lanes }, (_, li) => {
    const [a, b] = laneRange(lanes, li);
    return { x: (a + b) / 2, y: 0.65, charging: false, power: 0 };
  });

  const g = {
    bodies: [], time: 0, turn: 0, startTurn: 0, shots: players.map(() => 0),
    readyAt: 0, ready: players.map(() => RT_COUNTDOWN), lastShotAt: 0, finished: false, announced: !realtime,
    // Real-time round window (simulation seconds).
    startAt: RT_COUNTDOWN, endAt: RT_COUNTDOWN + duration,
    message: realtime ? "Készülj! Indulás 3 másodperc múlva…"
      : multi ? `${players[0].name} kezd — célozz és tölts!` : SOLO_MESSAGE,
    nextId: 1, accumulator: 0,
  };

  const name = i => players[i]?.name ?? "?";
  const active = i => players[i] && !players[i].left
    && (realtime ? g.time < g.endAt : g.shots[i] < frogsPerPlayer);
  const allDone = () => !players.some((_, i) => active(i));
  const laneOf = i => (realtime ? i : 0);
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
  function setAim(li, x, y) {
    const [a, b] = laneRange(lanes, li);
    aims[li].x = clamp(x, a, b);
    aims[li].y = clamp(y, 0.38, 2.1);
  }

  function shoot(i, power, spin) {
    const aim = aims[laneOf(i)];
    const obj = new THREE.Object3D();
    obj.position.copy(launchOrigin(aim.x, aim.y));
    g.bodies.push({
      id: g.nextId++, owner: i, obj,
      v: launchVelocity(aim.x, clamp(power, 0, 1)),
      w: new THREE.Vector3(1.5, clamp(spin, -0.35, 0.35), 0),
      invMass: 1 / 0.6, invInertia: 1 / 0.045,
      support: 0, scored: false, lastLeaf: -100,
      lastImpact: -100,
    });
    g.shots[i]++;
    g.lastShotAt = g.time;
    aim.charging = false;
    aim.power = 0;
    g.message = multi ? `${name(i)} békája repül…` : "A béka repül — az ütközések döntik el, hol áll meg.";
    if (realtime) {
      g.ready[i] = g.time + RT_RELOAD;
      if (g.bodies.length > MAX_BODIES) {
        // Drop the oldest frog that is not holding on to the tree.
        const k = Math.max(0, g.bodies.findIndex(b => !b.scored));
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
    const li = laneOf(i);
    setAim(li, x, y);
    if (data.kind === "aim") {
      const charging = !!data.charging;
      if (charging && !aims[li].charging && !realtime) g.message = "Tartsd nyomva, majd engedd el!";
      aims[li].charging = charging;
      aims[li].power = clamp(Number(data.power) || 0, 0, 1);
    } else if (data.kind === "shoot" && canAct(i)) {
      shoot(i, Number(data.power) || 0, Number(data.spin) || 0);
    }
  }

  function reset() {
    g.startTurn = multi && !realtime ? (g.startTurn + 1) % players.length : 0;
    Object.assign(g, {
      bodies: [], shots: players.map(() => 0), finished: false,
      readyAt: g.time, ready: players.map(() => g.time + RT_COUNTDOWN), lastShotAt: g.time, announced: !realtime,
      startAt: g.time + RT_COUNTDOWN, endAt: g.time + RT_COUNTDOWN + duration,
    });
    g.turn = active(g.startTurn) ? g.startTurn : nextTurn(g.startTurn);
    g.message = realtime ? "Új kör! Készülj, indulás 3 másodperc múlva…"
      : multi ? `${name(g.turn)} kezd — célozz és tölts!` : SOLO_MESSAGE;
    aims.forEach((aim, li) => {
      const [a, b] = laneRange(lanes, li);
      Object.assign(aim, { x: (a + b) / 2, y: 0.65, charging: false, power: 0 });
    });
  }

  /** Marks players who are no longer connected; their turns are skipped. */
  function setPresent(ids) {
    const present = new Set(ids);
    players.forEach(p => { p.left = !present.has(p.id); });
    if (!realtime && !active(g.turn) && !allDone()) {
      g.turn = nextTurn(g.turn);
      aims[0].charging = false;
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
    b.v.addScaledVector(impulse, b.invMass * sign);
    temp.crossVectors(r, impulse);
    b.w.addScaledVector(temp, b.invInertia * sign);
  }
  function effectiveMass(c, direction) {
    temp.crossVectors(c.ra, direction);
    let inverse = c.a.invMass + temp.lengthSq() * c.a.invInertia;
    if (c.b) {
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
  function physics(dt) {
    g.time += dt;
    tree.rotation.y += treeOmega.y * dt;
    scene.updateMatrixWorld(true);
    for (const c of colliders) {
      c.inverse.copy(c.object.matrixWorld).invert();
      c.object.getWorldQuaternion(c.rotation);
      c.worldBound.copy(c.bound).applyMatrix4(c.object.matrixWorld);
    }
    for (const b of g.bodies) {
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
      for (const h of hull) {
        centre.copy(h.p).applyQuaternion(b.obj.quaternion).add(b.obj.position);
        // The raised round stage: a flat disc at y = 0.
        const sx = centre.x - STAGE.x;
        const sz = centre.z - STAGE.z;
        if (centre.y - h.r < 0 && centre.y > -0.3 && sx * sx + sz * sz < STAGE.r * STAGE.r) {
          const point = new THREE.Vector3(centre.x, 0, centre.z);
          contacts.push(makeContact(b, null, point, new THREE.Vector3(0, 1, 0),
            -(centre.y - h.r), new THREE.Vector3(), 0.8, 0.15));
        }
        // Infinite floor beneath the raised tabletop.
        if (centre.y - h.r < -0.25) {
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
        if (a.obj.position.distanceToSquared(b.obj.position) > 1.1) continue;
        for (const ha of hull) {
          const pa = ha.p.clone().applyQuaternion(a.obj.quaternion).add(a.obj.position);
          for (const hb of hull) {
            const pb = hb.p.clone().applyQuaternion(b.obj.quaternion).add(b.obj.position);
            const n = pa.clone().sub(pb);
            const distance = n.length();
            const radius = ha.r + hb.r;
            if (distance >= radius) continue;
            if (distance < 0.000001) n.set(0, 1, 0);
            else n.multiplyScalar(1 / distance);
            const point = pa.clone().addScaledVector(n, -ha.r + (radius - distance) * 0.5);
            contacts.push(makeContact(a, b, point, n, radius - distance, new THREE.Vector3(), 0.65, 0.14));
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
        const totalInverseMass = c.a.invMass + (c.b ? c.b.invMass : 0);
        const amount = Math.min(depth * 0.55, 0.035);
        for (const [b, sign] of [[c.a, 1], [c.b, -1]]) {
          if (!b) continue;
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

    for (const b of g.bodies) {
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

    if (realtime) {
      // Frogs resting off the tree are out of the game: clear them away.
      for (let k = g.bodies.length - 1; k >= 0; k--) {
        const b = g.bodies[k];
        const resting = !b.scored && b.v.lengthSq() < 0.16 && b.obj.position.y < 1.5;
        b.rest = resting ? (b.rest || 0) + dt : 0;
        if (b.rest > 1.2) {
          b.obj.removeFromParent();
          g.bodies.splice(k, 1);
        }
      }
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
    g.accumulator += Math.min(dt, 0.25);
    let steps = 0;
    while (g.accumulator >= STEP && steps < 30) {
      physics(STEP);
      g.accumulator -= STEP;
      steps++;
      if (g.finished) break;
    }
  }

  /**
   * Everything a screen needs to draw the game. Rounded (`exact` false) it is
   * compact enough to send 20 times a second, even for 48 frogs in a 4 KiB message.
   */
  function state(exact = false) {
    const r = exact ? x => x : round;
    return {
      tree: exact ? tree.rotation.y : round(tree.rotation.y, 10000),
      b: g.bodies.map(b => {
        const p = b.obj.position;
        const q = b.obj.quaternion;
        return [b.id, b.owner, r(p.x, 100), r(p.y, 100), r(p.z, 100),
          r(q.x), r(q.y), r(q.z), r(q.w), b.scored ? 1 : 0];
      }),
      // Per launcher: aim x, aim y, charging, power.
      l: aims.map(a => [r(a.x, 100), r(a.y, 100), a.charging ? 1 : 0, r(a.power, 100)]),
      turn: g.turn,
      shots: g.shots.slice(),
      tl: realtime ? round(Math.max(0, Math.min(duration, g.endAt - g.time)), 10) : 0,
      cd: realtime ? Math.max(0, Math.ceil(g.startAt - g.time)) : 0,
      scores: scores(),
      ready: players.map((_, i) => (canAct(i) ? 1 : 0)),
      finished: g.finished ? 1 : 0,
      msg: g.message,
      left: players.map(p => (p.left ? 1 : 0)),
    };
  }

  return { players, realtime, lanes, input, reset, setPresent, advance, state, indexOf: id => players.findIndex(p => p.id === id) };
}
