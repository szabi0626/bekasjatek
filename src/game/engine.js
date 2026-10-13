import * as THREE from "three";

const STEP = 1 / 120;
const GRAVITY = 9.8;
const READY_DELAY = 1.2;
const SNAPSHOT_MS = 50;
const AIM_MS = 66;
const INTERP_DELAY = 110;
const LAUNCH_Z = 6.05;

export const SOLO_MESSAGE = "Célozz, tölts, és figyeld a forgó leveleket!";

export const FROG_COLORS = [
  { name: "Sárga", main: "#ffcf35", light: "#ffe980", dark: "#df9f18" },
  { name: "Piros", main: "#ff7a5c", light: "#ffbfa8", dark: "#d4472e" },
  { name: "Kék", main: "#4fb4ff", light: "#a9ddff", dark: "#1f7fd0" },
  { name: "Lila", main: "#b77cff", light: "#dcc2ff", dark: "#7f49d6" },
];

const clamp = THREE.MathUtils.clamp;
const round = (x, k = 1000) => Math.round(x * k) / k;

/**
 * Creates the 3D scene, physics and input handling.
 *
 * mode "local":  the simulation runs here, every player sits at this device.
 * mode "host":   the simulation runs here and is streamed to the other players.
 * mode "client": no simulation; the scene follows the host's snapshots and
 *                the local player's shots are sent to the host.
 */
export function createEngine(host, opts) {
  const mode = opts.mode;
  const frogsPerPlayer = opts.frogsPerPlayer;
  const localId = opts.localPlayerId ?? null;
  const players = opts.players.map(p => ({ ...p, left: false }));
  const multi = players.length > 1;
  const noop = () => {};
  const onHud = opts.onHud || noop;
  const onSnapshot = opts.onSnapshot || noop;
  const onAim = opts.onAim || noop;
  const onShoot = opts.onShoot || noop;

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

  const scene = new THREE.Scene();
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

  const geometries = new Set();
  const materials = new Set();
  function material(color, roughness = 0.55) {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.025 });
    materials.add(m);
    return m;
  }
  const M = {
    floor: material("#e1e8d3", 0.95),
    stage: material("#b2c994", 0.85),
    trunk: material("#b77d43", 0.65),
    bark: material("#906035"),
    leaf: material("#69b141", 0.44),
    edge: material("#86cb50"),
    vein: material("#3c852e"),
    yellow: material("#ffcf35", 0.34),
    light: material("#ffe980"),
    dark: material("#df9f18"),
    eye: material("#fffde7", 0.3),
    pupil: material("#183628", 0.22),
    metal: material("#697a69", 0.4),
    stone: material("#ced8be", 0.9),
  };
  const FM = FROG_COLORS.map(c => ({
    main: material(c.main, 0.34),
    light: material(c.light),
    dark: material(c.dark),
  }));
  function mesh(geo, mat, parent = scene) {
    geometries.add(geo);
    const obj = new THREE.Mesh(geo, mat);
    obj.castShadow = true;
    obj.receiveShadow = true;
    parent.add(obj);
    return obj;
  }
  const sphereGeometry = new THREE.SphereGeometry(1, 20, 14);
  geometries.add(sphereGeometry);
  function oval(parent, mat, x, y, z, sx, sy, sz) {
    const obj = mesh(sphereGeometry, mat, parent);
    obj.position.set(x, y, z);
    obj.scale.set(sx, sy, sz);
    return obj;
  }
  function tube(parent, points, radius, mat) {
    return mesh(new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p))),
      24, radius, 7, false
    ), mat, parent);
  }
  const colliders = [];
  function collider(object, kind = "tree", friction = 0.7, restitution = 0.23) {
    const geo = object.geometry;
    const pos = geo.attributes.position;
    const index = geo.index;
    const triangles = [];
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const a = index ? index.getX(i) : i;
      const b = index ? index.getX(i + 1) : i + 1;
      const c = index ? index.getX(i + 2) : i + 2;
      triangles.push(new THREE.Triangle(
        new THREE.Vector3().fromBufferAttribute(pos, a),
        new THREE.Vector3().fromBufferAttribute(pos, b),
        new THREE.Vector3().fromBufferAttribute(pos, c)
      ));
    }
    geo.computeBoundingSphere();
    colliders.push({
      object, kind, friction, restitution, triangles,
      inverse: new THREE.Matrix4(),
      bound: geo.boundingSphere.clone(),
      worldBound: new THREE.Sphere(),
      rotation: new THREE.Quaternion(),
      moving: false,
    });
    return object;
  }
  function branch(parent, a, b, r1, r2) {
    const direction = b.clone().sub(a);
    const obj = mesh(new THREE.CylinderGeometry(r2, r1, direction.length(), 14), M.trunk, parent);
    obj.position.copy(a).add(b).multiplyScalar(0.5);
    obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    collider(obj);
    return obj;
  }

  const ground = mesh(new THREE.PlaneGeometry(180, 180), M.floor);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.25;
  const stage = mesh(new THREE.CylinderGeometry(8.7, 8.9, 0.25, 80), M.stage);
  stage.position.set(0, -0.125, -0.4);
  collider(stage, "ground", 0.8, 0.15);

  for (let i = 0; i < 20; i++) {
    const a = i * 2.399963;
    const radius = 10 + i % 4;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius - 2;
    if (z > 5 && Math.abs(x) < 7) continue;
    oval(scene, M.stone, x, -0.13, z, 0.4 + (i % 3) * 0.15, 0.19, 0.4);
  }

  const baseGroup = new THREE.Group();
  baseGroup.position.z = -4.2;
  scene.add(baseGroup);
  const base = mesh(new THREE.CylinderGeometry(1.5, 1.78, 0.4, 40), M.leaf, baseGroup);
  base.position.y = 0.2;
  collider(base, "base", 0.65, 0.2);
  const topBase = mesh(new THREE.CylinderGeometry(1.35, 1.5, 0.12, 40), M.edge, baseGroup);
  topBase.position.y = 0.46;
  collider(topBase, "base");

  const tree = new THREE.Group();
  baseGroup.add(tree);
  const trunk = mesh(new THREE.CylinderGeometry(0.38, 0.64, 3.9, 20), M.trunk, tree);
  trunk.position.y = 2.25;
  collider(trunk);
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    tube(tree, [
      [Math.sin(a) * 0.55, 0.55, Math.cos(a) * 0.55],
      [Math.sin(a + 0.08) * 0.48, 1.6, Math.cos(a + 0.08) * 0.48],
      [Math.sin(a) * 0.38, 3.95, Math.cos(a) * 0.38],
    ], 0.022, M.bark);
  }
  function leaf(parent, width = 0.99, length = 1.45, mat = M.leaf, physical = true) {
    const shape = new THREE.Shape();
    shape.moveTo(0, -length);
    shape.bezierCurveTo(-width * 0.6, -length * 0.95, -width * 1.05, -length * 0.48, -width, 0);
    shape.bezierCurveTo(-width, length * 0.66, -width * 0.35, length, -0.1, length * 0.95);
    shape.lineTo(0, length * 0.65);
    shape.lineTo(0.1, length * 0.95);
    shape.bezierCurveTo(width * 0.35, length, width, length * 0.66, width, 0);
    shape.bezierCurveTo(width * 1.05, -length * 0.48, width * 0.6, -length * 0.95, 0, -length);
    const body = mesh(new THREE.ExtrudeGeometry(shape, {
      depth: 0.075, bevelEnabled: true, bevelThickness: 0.055,
      bevelSize: 0.055, bevelSegments: 2, curveSegments: 10,
    }), mat, parent);
    body.rotation.x = -Math.PI / 2;
    if (physical) collider(body, "leaf", 0.95, 0.12);
    const points = shape.getPoints(60).map(p => new THREE.Vector3(p.x, 0.105, -p.y));
    const rim = mesh(new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(points, true), 64, 0.035, 6, true
    ), mat === M.yellow ? M.light : M.edge, parent);
    if (physical) collider(rim, "leaf", 0.85, 0.17);
    tube(parent, [[0, 0.115, -length * 0.72], [0, 0.12, 0], [0, 0.12, length * 0.8]], 0.022, mat === M.yellow ? M.dark : M.vein);
    for (const side of [-1, 1]) {
      for (const z of [-0.55, 0.1, 0.65]) {
        tube(parent, [[0, 0.12, z + 0.2], [side * width * 0.45, 0.12, z], [side * width * 0.78, 0.115, z - 0.2]], 0.014, mat === M.yellow ? M.dark : M.vein);
      }
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2;
    const y = 3.12 + (i % 2) * 0.4;
    const end = new THREE.Vector3(Math.sin(a) * 2.18, y - 0.17, Math.cos(a) * 2.18);
    branch(tree, new THREE.Vector3(0, 2.5 + (i % 2) * 0.35, 0), end, 0.18, 0.12);
    const group = new THREE.Group();
    group.position.set(end.x, y, end.z);
    group.rotation.y = a;
    tree.add(group);
    leaf(group);
  }
  const crown = new THREE.Group();
  crown.position.y = 4.23;
  tree.add(crown);
  leaf(crown, 0.61, 0.74, M.edge);
  for (const c of colliders) {
    let p = c.object;
    while (p) {
      if (p === tree) { c.moving = true; break; }
      p = p.parent;
    }
  }

  function frog(color = 0) {
    const C = FM[color % FM.length];
    const root = new THREE.Group();
    // The rigid body's origin is near the frog's centre of mass.
    const g = new THREE.Group();
    g.position.y = -0.17;
    root.add(g);
    oval(g, C.main, 0, 0.17, 0, 0.25, 0.16, 0.29);
    oval(g, C.light, 0, 0.095, -0.13, 0.19, 0.055, 0.17);
    oval(g, C.main, 0, 0.25, -0.2, 0.24, 0.15, 0.18);
    for (const s of [-1, 1]) {
      oval(g, C.main, s * 0.17, 0.37, -0.23, 0.095, 0.105, 0.09);
      oval(g, M.eye, s * 0.17, 0.385, -0.297, 0.069, 0.072, 0.034);
      oval(g, M.pupil, s * 0.17, 0.39, -0.328, 0.033, 0.042, 0.013);
      oval(g, M.eye, s * 0.16, 0.41, -0.338, 0.01, 0.012, 0.004);
      oval(g, C.dark, s * 0.25, 0.12, 0.17, 0.15, 0.1, 0.16);
      oval(g, C.main, s * 0.34, 0.05, 0.04, 0.16, 0.047, 0.11);
      oval(g, C.main, s * 0.24, 0.065, -0.22, 0.085, 0.047, 0.15);
      for (let j = 0; j < 3; j++) {
        oval(g, C.main, s * (0.2 + j * 0.048), 0.04, -0.36 - (j === 1 ? 0.035 : 0), 0.035, 0.026, 0.07);
      }
    }
    return root;
  }

  // Compound sphere collision hull: body, head, feet, and eyes.
  // All spheres share one rigid body's velocity and orientation.
  const hull = [
    { p: new THREE.Vector3(0, 0, 0.02), r: 0.18 },
    { p: new THREE.Vector3(0, 0.07, -0.19), r: 0.17 },
    { p: new THREE.Vector3(-0.3, -0.1, 0.09), r: 0.105 },
    { p: new THREE.Vector3(0.3, -0.1, 0.09), r: 0.105 },
    { p: new THREE.Vector3(-0.23, -0.095, -0.29), r: 0.072 },
    { p: new THREE.Vector3(0.23, -0.095, -0.29), r: 0.072 },
    { p: new THREE.Vector3(-0.17, 0.2, -0.23), r: 0.087 },
    { p: new THREE.Vector3(0.17, 0.2, -0.23), r: 0.087 },
  ];
  const launcher = new THREE.Group();
  launcher.position.set(0, 0.65, LAUNCH_Z);
  scene.add(launcher);
  const foot = mesh(new THREE.CylinderGeometry(0.64, 0.75, 0.18, 32), M.dark, launcher);
  foot.position.y = 0.05;
  const springPoints = [];
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    springPoints.push([Math.cos(t * Math.PI * 10) * 0.16, 0.17 + t * 0.34, Math.sin(t * Math.PI * 10) * 0.16]);
  }
  const spring = tube(launcher, springPoints, 0.035, M.metal);
  const paddle = new THREE.Group();
  paddle.position.y = 0.49;
  paddle.scale.setScalar(0.53);
  launcher.add(paddle);
  leaf(paddle, 1, 1.22, M.yellow, false);
  // One loaded frog per colour; only the current player's is visible.
  const loadedFrogs = FROG_COLORS.map((_, i) => {
    const f = frog(i);
    f.position.set(0, 0.78, -0.08);
    f.visible = false;
    launcher.add(f);
    return f;
  });

  const dotMat = new THREE.MeshBasicMaterial({ color: "#fff8d7", transparent: true, opacity: 0.75 });
  materials.add(dotMat);
  const dots = Array.from({ length: 23 }, () => {
    const d = mesh(new THREE.SphereGeometry(0.045, 7, 5), dotMat);
    d.castShadow = false;
    d.visible = false;
    return d;
  });

  const g = {
    bodies: [], time: 0, turn: 0, startTurn: 0, shots: players.map(() => 0),
    charging: false, chargeStart: 0, power: 0,
    readyAt: 0, lastShotAt: 0, finished: false, disposed: false, announced: true,
    target: new THREE.Vector3(0, 0.65, LAUNCH_Z),
    message: mode === "client" ? "Kapcsolódás a házigazdához…" : multi ? `${players[0].name} kezd — célozz és tölts!` : SOLO_MESSAGE,
    nextPublish: 0, nextSnapshot: 0, nextAim: 0, nextId: 1,
    // Charge of a player on another device (host: from their input, client: from snapshots).
    remote: { charging: false, power: 0 },
    // Client-only state mirrored from the host.
    ready: false, scores: players.map(() => 0), waitingShot: false, waitingSince: 0, lastTotal: 0,
  };
  const treeCentre = new THREE.Vector3(0, 0, -4.2);
  const treeOmega = new THREE.Vector3(0, 0.38, 0);

  const name = i => players[i]?.name ?? "?";
  const isLocal = i => mode === "local" || (players[i] && players[i].id === localId);
  const active = i => players[i] && !players[i].left && g.shots[i] < frogsPerPlayer;
  const allDone = () => !players.some((_, i) => active(i));
  const myTurn = () => !g.finished && active(g.turn) && isLocal(g.turn);
  function nextTurn(from) {
    for (let k = 1; k <= players.length; k++) {
      const i = (from + k) % players.length;
      if (active(i)) return i;
    }
    return from;
  }
  function isReady() {
    if (mode === "client") return g.ready && !g.waitingShot && !g.finished;
    return !g.finished && g.time >= g.readyAt && active(g.turn);
  }
  function scores() {
    if (mode === "client") return g.scores;
    const s = players.map(() => 0);
    for (const b of g.bodies) if (b.scored) s[b.owner]++;
    return s;
  }
  const remoteTurn = () => mode !== "local" && !isLocal(g.turn);
  const chargeShown = () => g.charging || (remoteTurn() && g.remote.charging);
  const powerShown = () => g.charging ? g.power : remoteTurn() && g.remote.charging ? g.remote.power : 0;

  function publish() {
    if (g.disposed) return;
    const s = scores();
    onHud({
      players: players.map((p, i) => ({
        ...p, score: s[i] || 0, shotsLeft: Math.max(0, frogsPerPlayer - (g.shots[i] || 0)),
      })),
      turn: g.turn, myTurn: myTurn(), ready: isReady(), finished: g.finished,
      message: g.message, charging: chargeShown(), power: powerShown(),
      waiting: mode === "client" && g.waitingShot,
    });
  }
  function launchVelocity(power) {
    return new THREE.Vector3(-launcher.position.x * 0.08, 4.6 + power * 5, -(6.5 + power * 7));
  }
  function launchOrigin() {
    return new THREE.Vector3(launcher.position.x, launcher.position.y + 0.8, launcher.position.z - 0.08);
  }
  function clampTarget(x, y) {
    g.target.set(clamp(x, -4.2, 4.2), clamp(y, 0.38, 2.1), LAUNCH_Z);
  }
  function shoot(i, x, y, power, spin) {
    clampTarget(x, y);
    launcher.position.copy(g.target);
    const obj = frog(players[i].color);
    obj.position.copy(launchOrigin());
    scene.add(obj);
    g.bodies.push({
      id: g.nextId++, owner: i, obj,
      v: launchVelocity(clamp(power, 0, 1)),
      w: new THREE.Vector3(1.5, clamp(spin, -0.35, 0.35), 0),
      invMass: 1 / 0.6, invInertia: 1 / 0.045,
      support: 0, scored: false, lastLeaf: -100,
      lastImpact: -100,
    });
    g.shots[i]++;
    g.lastShotAt = g.time;
    g.readyAt = g.time + READY_DELAY;
    g.charging = false;
    g.power = 0;
    g.remote.charging = false;
    g.remote.power = 0;
    g.message = multi ? `${name(i)} békája repül…` : "A béka repül — az ütközések döntik el, hol áll meg.";
    g.turn = nextTurn(i);
    g.announced = false;
    publish();
  }
  function sendAim(force = false) {
    if (mode !== "client") return;
    const now = performance.now();
    if (!force && now < g.nextAim) return;
    g.nextAim = now + AIM_MS;
    onAim({ x: round(g.target.x), y: round(g.target.y), charging: g.charging, power: round(g.power) });
  }
  function release() {
    if (!g.charging) return;
    const power = Math.min(1, (performance.now() - g.chargeStart) / 1400);
    const spin = (Math.random() - 0.5) * 0.7;
    g.charging = false;
    g.power = 0;
    if (mode === "client") {
      g.waitingShot = true;
      g.waitingSince = performance.now();
      onShoot({ x: round(g.target.x), y: round(g.target.y), power: round(power), spin: round(spin) });
      publish();
    } else shoot(g.turn, g.target.x, g.target.y, power, spin);
  }
  function cancel() {
    if (!g.charging) return;
    g.charging = false;
    g.power = 0;
    sendAim(true);
    publish();
  }
  function reset() {
    if (mode === "client") return;
    for (const b of g.bodies) b.obj.removeFromParent();
    g.startTurn = multi ? (g.startTurn + 1) % players.length : 0;
    Object.assign(g, {
      bodies: [], shots: players.map(() => 0), charging: false, power: 0, finished: false,
      readyAt: g.time, lastShotAt: g.time, announced: true,
    });
    g.remote.charging = false;
    g.turn = active(g.startTurn) ? g.startTurn : nextTurn(g.startTurn);
    g.message = multi ? `${name(g.turn)} kezd — célozz és tölts!` : SOLO_MESSAGE;
    g.target.set(0, 0.65, LAUNCH_Z);
    publish();
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
          for (const triangle of c.triangles) {
            triangle.closestPointToPoint(local, closest);
            const distance = closest.distanceToSquared(local);
            if (distance < bestDistance && distance < h.r * h.r) {
              bestDistance = distance;
              if (!bestPoint) bestPoint = new THREE.Vector3();
              bestPoint.copy(closest);
              bestTriangle = triangle;
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

    if (!g.announced && g.time >= g.readyAt && !allDone()) {
      g.announced = true;
      if (multi) g.message = `${name(g.turn)} következik — célozz és tölts!`;
    }

    if (allDone() && !g.finished) {
      const elapsed = g.time - g.lastShotAt;
      const moving = g.bodies.some(b => {
        const expected = new THREE.Vector3().crossVectors(treeOmega, b.obj.position.clone().sub(treeCentre));
        return b.scored ? b.v.clone().sub(expected).length() > 0.9 : b.v.length() > 0.8;
      });
      if (elapsed > 7 || (elapsed > 3.5 && !moving)) {
        g.finished = true;
        g.charging = false;
        g.message = "Kör vége! A pontszámot a fán megmaradt békák adják.";
        publish();
      }
    }
  }

  // --- Networking -----------------------------------------------------------

  function snapshot() {
    return {
      tree: round(tree.rotation.y, 10000),
      b: g.bodies.map(b => {
        const p = b.obj.position;
        const q = b.obj.quaternion;
        // Compact enough for 40 frogs to fit a 4 KiB presence message.
        return [b.id, b.owner, round(p.x, 100), round(p.y, 100), round(p.z, 100),
          round(q.x), round(q.y), round(q.z), round(q.w), b.scored ? 1 : 0];
      }),
      l: [round(g.target.x), round(g.target.y)],
      c: chargeShown() ? 1 : 0,
      p: round(powerShown()),
      turn: g.turn,
      shots: g.shots,
      scores: scores(),
      ready: isReady() ? 1 : 0,
      finished: g.finished ? 1 : 0,
      msg: g.message,
      left: players.map(p => p.left ? 1 : 0),
    };
  }

  // Host: input from a player on another device.
  function remoteInput(playerId, data) {
    if (mode !== "host" || !data) return;
    const i = players.findIndex(p => p.id === playerId);
    if (i < 0 || i !== g.turn || g.finished) return;
    const x = Number(data.x);
    const y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (data.kind === "aim") {
      clampTarget(x, y);
      g.remote.charging = !!data.charging;
      g.remote.power = clamp(Number(data.power) || 0, 0, 1);
    } else if (data.kind === "shoot" && isReady()) {
      shoot(i, x, y, Number(data.power) || 0, Number(data.spin) || 0);
    }
  }

  // Client: interpolation buffer of host snapshots.
  const buffer = [];
  const views = new Map();
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  function applySnapshot(s) {
    if (mode !== "client" || !s || !Array.isArray(s.b)) return;
    buffer.push({ at: performance.now(), s, bodies: new Map(s.b.map(a => [a[0], a])) });
    if (buffer.length > 40) buffer.shift();
    const total = s.shots.reduce((a, b) => a + b, 0);
    if (total !== g.lastTotal) {
      g.lastTotal = total;
      g.waitingShot = false;
    }
    g.turn = s.turn;
    g.shots = s.shots;
    g.scores = s.scores;
    g.ready = !!s.ready;
    g.finished = !!s.finished;
    g.message = s.msg;
    g.remote.charging = !!s.c;
    g.remote.power = s.p;
    s.left.forEach((l, i) => { if (players[i]) players[i].left = !!l; });
    if (!myTurn()) {
      g.charging = false;
      clampTarget(s.l[0], s.l[1]);
    }
  }
  function interpolate(now) {
    if (!buffer.length) return;
    const rt = now - INTERP_DELAY;
    while (buffer.length > 2 && buffer[1].at <= rt) buffer.shift();
    const a = buffer[0];
    const b = buffer[1] || a;
    const k = b.at > a.at ? clamp((rt - a.at) / (b.at - a.at), 0, 1) : 1;
    tree.rotation.y = a.s.tree + (b.s.tree - a.s.tree) * k;
    for (const [id, cur] of b.bodies) {
      let view = views.get(id);
      if (!view) {
        view = frog(players[cur[1]]?.color ?? cur[1]);
        scene.add(view);
        views.set(id, view);
      }
      const prev = a.bodies.get(id) || cur;
      view.position.set(
        prev[2] + (cur[2] - prev[2]) * k,
        prev[3] + (cur[3] - prev[3]) * k,
        prev[4] + (cur[4] - prev[4]) * k,
      );
      qa.set(prev[5], prev[6], prev[7], prev[8]).normalize();
      qb.set(cur[5], cur[6], cur[7], cur[8]).normalize();
      view.quaternion.slerpQuaternions(qa, qb, k);
    }
    for (const [id, view] of views) {
      if (!b.bodies.has(id)) {
        view.removeFromParent();
        views.delete(id);
      }
    }
  }

  // Marks players who are no longer connected; their turns are skipped.
  function setPresent(ids) {
    const present = new Set(ids);
    players.forEach(p => { p.left = !present.has(p.id); });
    if (mode !== "client" && !active(g.turn) && !allDone()) {
      g.turn = nextTurn(g.turn);
      g.remote.charging = false;
      g.announced = false;
    }
    publish();
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
      clampTarget(intersection.x, intersection.y);
      sendAim();
    }
  }
  function down(e) {
    if (e.button !== 0 || !myTurn() || !isReady()) return;
    e.preventDefault();
    aim(e);
    launcher.position.copy(g.target);
    renderer.domElement.setPointerCapture(e.pointerId);
    g.charging = true;
    g.chargeStart = performance.now();
    g.message = "Tartsd nyomva, majd engedd el!";
    sendAim(true);
    publish();
  }
  function up(e) {
    if (e.button !== 0) return;
    release();
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }
  function key(e) {
    if (e.key.toLowerCase() === "r" && !e.repeat && mode !== "client") reset();
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

  let accumulator = 0;
  let previous = performance.now();
  let frame;
  function animate(now) {
    frame = requestAnimationFrame(animate);
    const dt = Math.min((now - previous) / 1000, 0.065);
    previous = now;
    if (mode === "client") {
      interpolate(now);
      // A shot the host rejected must not lock the player out forever.
      if (g.waitingShot && now - g.waitingSince > 3000) g.waitingShot = false;
    } else if (!g.finished) {
      accumulator += dt;
      let steps = 0;
      while (accumulator >= STEP && steps < 8) {
        physics(STEP);
        accumulator -= STEP;
        steps++;
      }
    } else accumulator = 0;

    launcher.position.lerp(g.target, Math.min(1, dt * 22));
    if (g.charging) {
      g.power = Math.min(1, (now - g.chargeStart) / 1400);
      sendAim();
    }
    const power = powerShown();
    const charging = chargeShown();
    const compression = charging ? power * 0.23 : 0;
    spring.scale.y = 1 - compression * 1.5;
    paddle.position.y = 0.49 - compression;
    const showLoaded = !g.finished && active(g.turn) && isReady();
    const colour = players[g.turn]?.color ?? 0;
    loadedFrogs.forEach((f, i) => {
      f.visible = showLoaded && i === colour;
      f.position.y = 0.78 - compression;
    });
    const origin = launchOrigin();
    const velocity = launchVelocity(power);
    dots.forEach((d, i) => {
      d.visible = charging;
      if (charging) {
        const t = (i + 1) * 0.06;
        d.position.copy(origin).addScaledVector(velocity, t);
        d.position.y -= 0.5 * GRAVITY * t * t;
        if (d.position.y < 0.1) d.visible = false;
      }
    });
    if (now > g.nextPublish) {
      publish();
      g.nextPublish = now + 70;
    }
    if (mode === "host" && now > g.nextSnapshot) {
      g.nextSnapshot = now + SNAPSHOT_MS;
      onSnapshot(snapshot());
    }
    renderer.render(scene, camera);
  }
  frame = requestAnimationFrame(animate);
  publish();

  function dispose() {
    g.disposed = true;
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
