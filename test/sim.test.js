// Shot timing rules of the simulation (src/game/sim.js), without a server or browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSim } from "../src/game/sim.js";

const one = [{ id: "a", name: "A", color: 0 }];
const two = [...one, { id: "b", name: "B", color: 1 }];
const shot = { kind: "shoot", x: 0, y: 0.8, power: 0.6, spin: 0 };

function run(sim, seconds, every = 0.025, each = () => {}) {
  for (let t = 0; t < seconds - 1e-9; t += every) {
    each();
    sim.advance(every);
  }
}

test("a one-player real-time round stays real-time", () => {
  const sim = createSim({ physics: "classic", players: one, frogsPerPlayer: 5, realtime: true, duration: 30 });
  assert.equal(sim.realtime, true);
});

test("real-time: shooting as fast as possible gives one shot per 0.25 s reload", () => {
  const sim = createSim({ physics: "classic", players: one, frogsPerPlayer: 5, realtime: true, duration: 30, maxBodies: 100 });
  run(sim, 3); // countdown
  run(sim, 3, 0.025, () => sim.input(0, shot));
  const { shots } = sim.state();
  assert.ok(shots[0] >= 11 && shots[0] <= 13, `got ${shots[0]} shots in 3 s`);
});

test("real-time: a shot released during the reload fires when the launcher is ready", () => {
  const sim = createSim({ physics: "classic", players: one, frogsPerPlayer: 5, realtime: true, duration: 30 });
  run(sim, 3.1); // just past the countdown
  sim.input(0, shot);
  assert.equal(sim.state().shots[0], 1);
  run(sim, 0.1);
  sim.input(0, shot); // 0.1 s into the 0.25 s reload
  assert.equal(sim.state().shots[0], 1);
  run(sim, 0.2);
  assert.equal(sim.state().shots[0], 2);
});

test("real-time: a shot released during the countdown is not kept for later", () => {
  const sim = createSim({ physics: "classic", players: one, frogsPerPlayer: 5, realtime: true, duration: 30 });
  run(sim, 1);
  sim.input(0, shot);
  run(sim, 2.5);
  assert.equal(sim.state().shots[0], 0);
});

test("real-time: a new round drops a queued shot", () => {
  const sim = createSim({ physics: "classic", players: one, frogsPerPlayer: 5, realtime: true, duration: 30 });
  run(sim, 3);
  sim.input(0, shot);
  sim.input(0, shot); // queued
  sim.reset();
  run(sim, 3.5);
  assert.equal(sim.state().shots[0], 0);
});

test("real-time: the reload chosen for the room is used", () => {
  const shotsIn3s = reload => {
    const sim = createSim({ physics: "classic", players: one, frogsPerPlayer: 5, realtime: true, duration: 30, maxBodies: 100, reload });
    run(sim, 3.1);
    run(sim, 3, 0.025, () => sim.input(0, shot));
    return sim.state().shots[0];
  };
  const slow = shotsIn3s(1);
  assert.ok(slow >= 3 && slow <= 4, `reload 1 s: ${slow} shots`);
  const fast = shotsIn3s(0.1);
  assert.ok(fast >= 25 && fast <= 31, `reload 0.1 s: ${fast} shots`);
  assert.equal(shotsIn3s(0), 120); // every input fires
});

test("real-time: the reload is kept within 0–3 s, and defaults to 0.25 s", () => {
  const make = reload => createSim({ physics: "classic", players: one, frogsPerPlayer: 5, realtime: true, duration: 30, reload });
  assert.equal(make(undefined).reload, 0.25);
  assert.equal(make(-1).reload, 0);
  assert.equal(make(99).reload, 3);
  assert.equal(make("x").reload, 0);
});

test("launched frogs tumble randomly", () => {
  const sim = createSim({ physics: "classic", players: one, frogsPerPlayer: 5, realtime: true, duration: 30, reload: 0 });
  run(sim, 3.1);
  for (let k = 0; k < 4; k++) sim.input(0, shot);
  const spins = sim.debugBodies().map(b => b.w.toArray().map(x => x.toFixed(3)).join());
  assert.equal(new Set(spins).size, 4, "every shot spins differently");
  assert.ok(sim.debugBodies().some(b => Math.abs(b.w.y) > 0.5 || Math.abs(b.w.z) > 0.5), "spin on more than one axis");
});

// Two frogs in open air, away from the tree: `shot` flies into `hit` at 8 m/s.
function collide(launchedAgo) {
  const sim = createSim({ physics: "classic", players: one, frogsPerPlayer: 5, realtime: true, duration: 30, reload: 0 });
  run(sim, 3.1);
  sim.input(0, shot);
  sim.input(0, shot);
  const [hit, flying] = sim.debugBodies();
  for (const b of [hit, flying]) {
    b.obj.quaternion.identity();
    b.w.set(0, 0, 0);
  }
  hit.obj.position.set(0, 12, 12);
  hit.v.set(0, 0, 0);
  flying.obj.position.set(0, 12, 12.9);
  flying.v.set(0, 0, -8);
  flying.launchedAt -= launchedAgo;
  run(sim, 0.15);
  return hit.v;
}

test("a fresh shot knocks the frog it hits much harder than an old one", () => {
  const fresh = collide(0);
  const stale = collide(5);
  assert.ok(-fresh.z > 5.5, `fresh hit pushed it at ${(-fresh.z).toFixed(2)} m/s`);
  assert.ok(-fresh.z > -stale.z + 1, `fresh ${(-fresh.z).toFixed(2)} vs old ${(-stale.z).toFixed(2)} m/s`);
  assert.ok(fresh.y > stale.y + 1, "the knock lifts it");
});

test("turn-based play keeps its own pace", () => {
  const sim = createSim({ physics: "classic", players: two, frogsPerPlayer: 5, realtime: false });
  sim.input(0, shot);
  assert.equal(sim.state().turn, 1);
  sim.input(1, shot); // too soon after the previous shot
  assert.equal(sim.state().shots[1], 0);
  run(sim, 1.3);
  sim.input(1, shot);
  assert.equal(sim.state().shots[1], 1);
});
