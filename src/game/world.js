// The playing field: stage, rotating tree, leaves and frogs. Shared by the
// browser (which draws it) and the game server (which only needs colliders),
// so nothing here may touch the DOM or WebGL.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { model, CASTLE_TEXTURE } from "./models.js";

export const TREE_CENTRE = new THREE.Vector3(0, 0, -4.2);
export const TREE_OMEGA = new THREE.Vector3(0, 0.38, 0);
export const MAX_PLAYERS = 8;

// Tree sizes players can pick; the launchers' circle and the stage grow with the tree.
export const TREE_SIZES = [
  { scale: 1, name: "Kicsi" },
  { scale: 1.3, name: "Közepes" },
  { scale: 1.6, name: "Nagy" },
  { scale: 2, name: "Óriás" },
];
export function layout(treeScale = 1) {
  const s = Math.min(2.5, Math.max(0.8, Number(treeScale) || 1));
  // Distance of the launchers from the tree's axis (10.25 is the original game's); bigger maps are shot from further away.
  const radius = 10.25 + (s - 1) * 7;
  return { scale: s, radius, stageRadius: radius + 1.6 };
}

export const FROG_COLORS = [
  { name: "Sárga", main: "#ffcf35", light: "#ffe980", dark: "#df9f18" },
  { name: "Piros", main: "#ff7a5c", light: "#ffbfa8", dark: "#d4472e" },
  { name: "Kék", main: "#4fb4ff", light: "#a9ddff", dark: "#1f7fd0" },
  { name: "Lila", main: "#b77cff", light: "#dcc2ff", dark: "#7f49d6" },
  { name: "Narancs", main: "#ff9a2e", light: "#ffcd94", dark: "#d06a0c" },
  { name: "Rózsaszín", main: "#ff7eb9", light: "#ffc3dd", dark: "#d24486" },
  { name: "Türkiz", main: "#2fd3c3", light: "#a3efe6", dark: "#139a8d" },
  { name: "Szürke", main: "#9aa3b5", light: "#d3d8e2", dark: "#626b7d" },
];

// Compound sphere collision hull: body, head, feet, and eyes.
// All spheres share one rigid body's velocity and orientation.
export const HULL = [
  { p: new THREE.Vector3(0, 0, 0.02), r: 0.18 },
  { p: new THREE.Vector3(0, 0.07, -0.19), r: 0.17 },
  { p: new THREE.Vector3(-0.3, -0.1, 0.09), r: 0.105 },
  { p: new THREE.Vector3(0.3, -0.1, 0.09), r: 0.105 },
  { p: new THREE.Vector3(-0.23, -0.095, -0.29), r: 0.072 },
  { p: new THREE.Vector3(0.23, -0.095, -0.29), r: 0.072 },
  { p: new THREE.Vector3(-0.17, 0.2, -0.23), r: 0.087 },
  { p: new THREE.Vector3(0.17, 0.2, -0.23), r: 0.087 },
];

const LEAF_SIZE = 8;
function triangleSphere(t) {
  const c = t.a.clone().add(t.b).add(t.c).multiplyScalar(1 / 3);
  return [c.x, c.y, c.z, Math.sqrt(Math.max(c.distanceToSquared(t.a), c.distanceToSquared(t.b), c.distanceToSquared(t.c)))];
}
// Bounding-sphere tree over the triangles (median splits along the widest axis).
// Returns the new triangle order and the nodes, 6 numbers each:
// x, y, z, radius, then for a leaf (start, -end) of its triangles, else (left, right) node indices.
function buildTree(triangles) {
  const spheres = triangles.map(triangleSphere);
  const order = triangles.map((_, k) => k);
  const nodes = [];
  function node(start, end) {
    const ids = order.slice(start, end);
    const c = [0, 1, 2].map(a => ids.reduce((sum, k) => sum + spheres[k][a], 0) / ids.length);
    const r = Math.max(...ids.map(k => Math.hypot(spheres[k][0] - c[0], spheres[k][1] - c[1], spheres[k][2] - c[2]) + spheres[k][3]));
    const at = nodes.length / 6;
    nodes.push(c[0], c[1], c[2], r, 0, 0);
    if (end - start <= LEAF_SIZE) {
      nodes[at * 6 + 4] = start;
      nodes[at * 6 + 5] = -end;
      return at;
    }
    const spread = [0, 1, 2].map(a => Math.max(...ids.map(k => spheres[k][a])) - Math.min(...ids.map(k => spheres[k][a])));
    const axis = spread.indexOf(Math.max(...spread));
    ids.sort((p, q) => spheres[p][axis] - spheres[q][axis]);
    order.splice(start, ids.length, ...ids);
    const mid = start + Math.ceil((end - start) / 2);
    const left = node(start, mid);
    const right = node(mid, end);
    nodes[at * 6 + 4] = left;
    nodes[at * 6 + 5] = right;
    return at;
  }
  node(0, triangles.length);
  return { order, nodes: Float64Array.from(nodes) };
}

// Maps players can pick. Each puts something different on the turning stand;
// frogs score on its "leaf" surfaces (leaves, wings, Shrek, …).
export const MAPS = [
  { id: "classic", name: "Klasszikus fa" },
  { id: "jungle", name: "Dzsungel" },
  { id: "sphinx", name: "Szárnyas szfinx" },
  { id: "shrek", name: "Shrek" },
  { id: "castle", name: "Kastély" },
];
export const mapId = id => (MAPS.some(m => m.id === id) ? id : "classic");

// Sky (also the fog), ground and stage colours of each map.
const ENVIRONMENTS = {
  classic: { sky: "#e9efdf", floor: "#e1e8d3", stage: "#b2c994", stone: "#ced8be" },
  jungle: { sky: "#cfe0c2", floor: "#5f8a45", stage: "#7aa356", stone: "#6f7d5c" },
  sphinx: { sky: "#f4e6c6", floor: "#e8d29f", stage: "#d8b878", stone: "#c9a76a" },
  shrek: { sky: "#dfe6c8", floor: "#7f8c55", stage: "#93a066", stone: "#6c6a4a" },
  castle: { sky: "#dbe5ee", floor: "#7fa35a", stage: "#a7a397", stone: "#8f8b80" },
};

/**
 * Builds the field into a new scene. With `visual: false` only the parts that
 * collide are created (no materials, decorations, frogs or launchers).
 */
export function buildWorld({ visual = true, treeScale = 1, map = "classic", views = 1 } = {}) {
  const { scale, stageRadius } = layout(treeScale);
  map = mapId(map);
  const env = ENVIRONMENTS[map];
  const scene = new THREE.Scene();
  const geometries = new Set();
  const materials = new Set();
  function material(color, roughness = 0.55, extra = {}) {
    if (!visual) return undefined;
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.025, ...extra });
    materials.add(m);
    return m;
  }
  const M = {
    floor: material(env.floor, 0.95),
    stage: material(env.stage, 0.85),
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
    stone: material(env.stone, 0.9),
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
  // Colliders are measured once the tree has its final size (see below).
  const pending = [];
  function collider(object, kind = "tree", friction = 0.7, restitution = 0.23) {
    pending.push([object, kind, friction, restitution]);
    return object;
  }
  function measure(object, kind, friction, restitution) {
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
    // A bounding-sphere tree, so a contact test can skip far-away geometry cheaply.
    const { order, nodes } = buildTree(triangles);
    triangles.splice(0, triangles.length, ...order.map(k => triangles[k]));
    colliders.push({
      object, kind, friction, restitution, triangles, nodes,
      inverse: new THREE.Matrix4(),
      bound: geo.boundingSphere.clone(),
      worldBound: new THREE.Sphere(),
      rotation: new THREE.Quaternion(),
      moving: false,
    });
    return object;
  }
  function branch(parent, a, b, r1, r2, mat = M.trunk) {
    const direction = b.clone().sub(a);
    const obj = mesh(new THREE.CylinderGeometry(r2, r1, direction.length(), 14), mat, parent);
    obj.position.copy(a).add(b).multiplyScalar(0.5);
    obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    collider(obj);
    return obj;
  }
  // Shapes on the stand. Colliders need unit-scale transforms, so a solid's size
  // goes into its own geometry. opts: rot [x, y, z], kind (collider kind, or none
  // for decoration), friction, restitution, segments [w, h].
  function place(obj, pos, opts) {
    obj.position.set(...pos);
    if (opts.rot) obj.rotation.set(...opts.rot);
    if (opts.kind) collider(obj, opts.kind, opts.friction ?? (opts.kind === "leaf" ? 0.92 : 0.7), opts.restitution ?? 0.15);
    return obj;
  }
  function blob(parent, mat, pos, size, opts = {}) {
    const [w, h] = opts.segments ?? [18, 12];
    const geo = new THREE.SphereGeometry(1, w, h);
    geo.scale(...size);
    return place(mesh(geo, mat, parent), pos, opts);
  }
  function box(parent, mat, pos, size, opts = {}) {
    return place(mesh(new THREE.BoxGeometry(...size), mat, parent), pos, opts);
  }
  function cylinder(parent, mat, pos, top, bottom, height, opts = {}) {
    return place(mesh(new THREE.CylinderGeometry(top, bottom, height, opts.sides ?? 24), mat, parent), pos, opts);
  }
  // Decoration on the stand: one shared unit sphere, sized by the object's scale.
  const unitSphere = new THREE.SphereGeometry(1, 12, 8);
  geometries.add(unitSphere);
  function bead(parent, mat, pos, size, rot) {
    const obj = mesh(unitSphere, mat, parent);
    obj.position.set(...pos);
    obj.scale.set(...size);
    if (rot) obj.rotation.set(...rot);
    obj.castShadow = false;
    return obj;
  }

  if (visual) {
    const ground = mesh(new THREE.PlaneGeometry(180, 180), M.floor);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.25;
  }
  // The stage, a disc around the tree, collides analytically (see sim.js).
  if (visual) {
    const stage = mesh(new THREE.CylinderGeometry(stageRadius, stageRadius + 0.2, 0.25, 96), M.stage);
    stage.position.set(TREE_CENTRE.x, -0.125, TREE_CENTRE.z);
  }

  // The pedestal stands still; `tree` on it turns, with everything players aim at.
  const baseGroup = new THREE.Group();
  baseGroup.position.copy(TREE_CENTRE);
  scene.add(baseGroup);
  const tree = new THREE.Group();
  baseGroup.add(tree);
  function pedestal(radius, topMat, sideMat) {
    const base = mesh(new THREE.CylinderGeometry(radius, radius + 0.28, 0.4, 40), sideMat, baseGroup);
    base.position.y = 0.2;
    collider(base, "base", 0.65, 0.2);
    const top = mesh(new THREE.CylinderGeometry(radius - 0.15, radius, 0.12, 40), topMat, baseGroup);
    top.position.y = 0.46;
    collider(top, "base");
  }

  function leaf(parent, width = 0.99, length = 1.45, mat = M.leaf, physical = true, rimMat = M.edge, veinMat = M.vein) {
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
    const yellow = visual && mat === M.yellow;
    const rim = mesh(new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(points, true), 64, 0.035, 6, true
    ), yellow ? M.light : rimMat, parent);
    if (physical) collider(rim, "leaf", 0.85, 0.17);
    if (!visual) return;
    tube(parent, [[0, 0.115, -length * 0.72], [0, 0.12, 0], [0, 0.12, length * 0.8]], 0.022, yellow ? M.dark : veinMat);
    for (const side of [-1, 1]) {
      for (const z of [-0.55, 0.1, 0.65].map(z => z * length / 1.45)) {
        tube(parent, [[0, 0.12, z + 0.2], [side * width * 0.45, 0.12, z], [side * width * 0.78, 0.115, z - 0.2]], 0.014, yellow ? M.dark : veinMat);
      }
    }
  }
  // A leaf on a branch from the trunk: `a` is the angle around the trunk.
  function leafOnBranch(a, from, out, y, width, length, mats = {}) {
    const end = new THREE.Vector3(Math.sin(a) * out, y - 0.17, Math.cos(a) * out);
    branch(tree, new THREE.Vector3(0, from, 0), end, 0.18, 0.12, mats.branch);
    const group = new THREE.Group();
    group.position.set(end.x, y, end.z);
    group.rotation.y = a;
    tree.add(group);
    leaf(group, width, length, mats.leaf, true, mats.rim, mats.vein);
    return group;
  }

  // --- Maps ---------------------------------------------------------------------

  function classic() {
    pedestal(1.5, M.edge, M.leaf);
    const trunk = mesh(new THREE.CylinderGeometry(0.38, 0.64, 3.9, 20), M.trunk, tree);
    trunk.position.y = 2.25;
    collider(trunk);
    if (visual) {
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3;
        tube(tree, [
          [Math.sin(a) * 0.55, 0.55, Math.cos(a) * 0.55],
          [Math.sin(a + 0.08) * 0.48, 1.6, Math.cos(a + 0.08) * 0.48],
          [Math.sin(a) * 0.38, 3.95, Math.cos(a) * 0.38],
        ], 0.022, M.bark);
      }
    }
    for (let i = 0; i < 4; i++) {
      leafOnBranch(i * Math.PI / 2, 2.5 + (i % 2) * 0.35, 2.18, 3.12 + (i % 2) * 0.4, 0.99, 1.45);
    }
    const crown = new THREE.Group();
    crown.position.y = 4.23;
    tree.add(crown);
    leaf(crown, 0.61, 0.74, M.edge);
    if (visual) {
      for (let i = 0; i < 28; i++) {
        const a = i * 2.399963;
        const radius = stageRadius + 1.4 + (i % 4) * 1.1;
        oval(scene, M.stone, TREE_CENTRE.x + Math.cos(a) * radius, -0.13, TREE_CENTRE.z + Math.sin(a) * radius,
          0.4 + (i % 3) * 0.15, 0.19, 0.4);
      }
    }
  }

  // A tall rainforest tree with three tiers of leaves, vines and moss.
  function jungle() {
    const J = {
      moss: material("#4f8a34", 0.9),
      mossLight: material("#77b04a", 0.85),
      bark: material("#6e4a2c", 0.8),
      barkDark: material("#4c321d", 0.85),
      leaf: material("#3f9a3a", 0.5),
      leafDark: material("#2f7d33", 0.5),
      rim: material("#62c04a"),
      vein: material("#245f26"),
      vine: material("#3d6e2a", 0.8),
      flower: material("#ff5a7a", 0.4),
      flower2: material("#ffb53b", 0.4),
      fern: material("#4c9a3c", 0.6, { side: THREE.DoubleSide }),
      palm: material("#8a6a44", 0.85),
    };
    pedestal(2, J.mossLight, J.moss);
    const trunk = mesh(new THREE.CylinderGeometry(0.42, 0.85, 5.7, 22), J.bark, tree);
    trunk.position.y = 3.05;
    collider(trunk);
    // Buttress roots.
    for (let i = 0; i < 5; i++) {
      const a = i * Math.PI * 2 / 5 + 0.3;
      branch(tree, new THREE.Vector3(Math.sin(a) * 0.5, 1.5, Math.cos(a) * 0.5),
        new THREE.Vector3(Math.sin(a) * 1.55, 0.6, Math.cos(a) * 1.55), 0.24, 0.1, J.barkDark);
    }
    // Three tiers of leaves, each turned so the one above does not cover it.
    const tiers = [
      { count: 5, y: 2.3, out: 2.8, width: 1.1, length: 1.55, offset: 0, mat: J.leafDark },
      { count: 4, y: 3.75, out: 2.15, width: 0.95, length: 1.35, offset: Math.PI / 4, mat: J.leaf },
      { count: 3, y: 5.15, out: 1.5, width: 0.82, length: 1.1, offset: Math.PI / 6, mat: J.leaf },
    ];
    const tips = [];
    for (const t of tiers) {
      for (let i = 0; i < t.count; i++) {
        const a = t.offset + i * Math.PI * 2 / t.count;
        leafOnBranch(a, t.y - 0.45, t.out, t.y, t.width, t.length, { branch: J.bark, leaf: t.mat, rim: J.rim, vein: J.vein });
        tips.push([a, t.out * 0.55, t.y - 0.25]);
      }
    }
    const crown = new THREE.Group();
    crown.position.y = 6.05;
    tree.add(crown);
    leaf(crown, 0.7, 0.85, J.rim, true, J.rim, J.vein);
    if (!visual) return;
    // Bark ridges, moss, vines hanging from the branches, flowers.
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      tube(tree, [
        [Math.sin(a) * 0.82, 0.4, Math.cos(a) * 0.82],
        [Math.sin(a + 0.1) * 0.62, 2.4, Math.cos(a + 0.1) * 0.62],
        [Math.sin(a) * 0.44, 5.8, Math.cos(a) * 0.44],
      ], 0.03, J.barkDark);
    }
    for (let i = 0; i < 9; i++) {
      const a = i * 2.4;
      const y = 0.9 + i * 0.55;
      const r = 0.8 - y * 0.065;
      bead(tree, i % 2 ? J.moss : J.mossLight, [Math.sin(a) * r, y, Math.cos(a) * r], [0.28, 0.2, 0.28]);
    }
    tips.forEach(([a, out, y], k) => {
      const x = Math.sin(a) * out;
      const z = Math.cos(a) * out;
      const length = 1 + (k % 3) * 0.45;
      tube(tree, [[x, y, z], [x + 0.08, y - length * 0.5, z + 0.05], [x - 0.04, y - length, z]], 0.025, J.vine);
      if (k % 2 === 0) bead(tree, k % 4 ? J.flower : J.flower2, [x - 0.04, y - length, z], [0.09, 0.07, 0.09]);
    });
    for (let i = 0; i < 6; i++) {
      const a = i * 1.1;
      bead(tree, i % 2 ? J.flower : J.flower2, [Math.sin(a) * 0.62, 1.8 + i * 0.7, Math.cos(a) * 0.62], [0.11, 0.08, 0.11]);
    }
    // Ferns around the stage and palms in the distance.
    const fern = new THREE.SphereGeometry(1, 8, 4);
    geometries.add(fern);
    for (let i = 0; i < 26; i++) {
      const a = i * 2.399963;
      const r = stageRadius + 0.8 + (i % 4) * 1.3;
      const g = new THREE.Group();
      g.position.set(TREE_CENTRE.x + Math.cos(a) * r, -0.2, TREE_CENTRE.z + Math.sin(a) * r);
      g.rotation.y = a;
      scene.add(g);
      for (let k = 0; k < 7; k++) {
        const f = mesh(fern, J.fern, g);
        f.scale.set(0.14, 0.03, 0.75);
        f.rotation.set(-0.45, k * Math.PI * 2 / 7, 0, "YXZ");
        f.position.set(Math.sin(k * Math.PI * 2 / 7) * 0.45, 0.25, Math.cos(k * Math.PI * 2 / 7) * 0.45);
        f.castShadow = false;
      }
    }
    for (let i = 0; i < 16; i++) {
      const a = i * 2.399963 + 0.5;
      const r = stageRadius + 24 + (i % 4) * 5;
      const x = TREE_CENTRE.x + Math.cos(a) * r;
      const z = TREE_CENTRE.z + Math.sin(a) * r;
      const h = 7 + (i % 3) * 2;
      const lean = 0.8 + (i % 2) * 0.6;
      tube(scene, [[x, -0.25, z], [x + lean * 0.4, h * 0.5, z], [x + lean, h, z]], 0.28, J.palm);
      for (let k = 0; k < 8; k++) {
        const f = mesh(fern, J.leaf, scene);
        const fa = k * Math.PI / 4;
        f.scale.set(0.4, 0.06, 2.6);
        f.rotation.set(0.5, fa, 0, "YXZ");
        f.position.set(x + lean + Math.sin(fa) * 2.1, h - 0.9, z + Math.cos(fa) * 2.1);
      }
    }
  }

  // A lying lion with a pharaoh's head on a plinth, its feathered wings spread.
  function sphinx() {
    const S = {
      sand: material("#d9b56f", 0.9),
      stone: material("#e2c48a", 0.75),
      stoneDark: material("#c69f5e", 0.8),
      gold: material("#e9b93a", 0.35, { side: THREE.DoubleSide }),
      blue: material("#2d5fb8", 0.4),
      turquoise: material("#33b7a8", 0.4),
      eye: material("#1c1a2a", 0.3),
      pyramid: material("#e0c27f", 0.95),
    };
    pedestal(2.4, S.stone, S.stoneDark);
    box(tree, S.stoneDark, [0, 0.82, 0.1], [2.5, 0.75, 5.4], { kind: "base" });
    // Lion body, haunches, front paws and chest: frogs score on all of it.
    const leafy = { kind: "leaf" };
    blob(tree, S.stone, [0, 1.75, 0.45], [0.92, 0.7, 1.85], leafy);
    for (const s of [-1, 1]) {
      blob(tree, S.stone, [s * 0.6, 1.65, 1.5], [0.5, 0.55, 0.78], leafy);
      blob(tree, S.stone, [s * 0.5, 1.38, -1.8], [0.28, 0.24, 0.95], leafy);
    }
    blob(tree, S.stone, [0, 2.05, -0.95], [0.82, 0.92, 0.78], leafy);
    // Pharaoh's head and nemes headdress.
    blob(tree, S.stone, [0, 3.2, -1.3], [0.46, 0.56, 0.48], leafy);
    blob(tree, S.gold, [0, 3.48, -1.15], [0.64, 0.48, 0.6], leafy);
    for (const s of [-1, 1]) box(tree, S.gold, [s * 0.5, 2.82, -1.28], [0.2, 0.95, 0.34], { kind: "tree" });
    // Wings: feathered blades rising from the shoulders.
    const span = 3;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.35);
    shape.quadraticCurveTo(1.4, 1.15, span, 1.2);
    const trailing = [[2.55, 0.2], [2.15, 0.45], [1.85, -0.35], [1.45, 0.05], [1.1, -0.65], [0.75, -0.2], [0.35, -0.9], [0, -0.55]];
    let previous = [span, 1.2];
    for (const [u, v] of trailing) {
      shape.quadraticCurveTo((previous[0] + u) / 2 + 0.05, Math.min(previous[1], v) - 0.18, u, v);
      previous = [u, v];
    }
    shape.lineTo(0, 0.35);
    for (const s of [-1, 1]) {
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: 0.1, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1, curveSegments: 6,
      });
      geo.rotateX(-Math.PI / 2);
      if (s < 0) geo.scale(-1, 1, 1);
      const wing = mesh(geo, S.gold, tree);
      wing.position.set(s * 0.55, 2.5, -0.3);
      wing.rotation.set(0, s * -0.2, s * 0.45);
      collider(wing, "leaf", 0.92, 0.12);
      if (!visual) continue;
      // Rows of coloured feathers on top.
      const rows = [[0.62, S.blue, 2.7], [0.12, S.turquoise, 2.3], [-0.38, S.blue, 1.6]];
      for (const [v, mat, last] of rows) {
        for (let u = 0.25; u <= last; u += 0.3) {
          bead(wing, mat, [s * u, 0.14, -v], [0.11, 0.035, 0.28], [0, s * -0.15, 0]);
        }
      }
    }
    if (!visual) return;
    // Face: eyes, nose, beard; stripes on the headdress.
    for (const s of [-1, 1]) {
      bead(tree, S.eye, [s * 0.17, 3.36, -1.72], [0.08, 0.04, 0.03]);
      bead(tree, S.blue, [s * 0.17, 3.42, -1.71], [0.1, 0.015, 0.03]);
      for (let k = 0; k < 4; k++) bead(tree, S.blue, [s * 0.61, 3.18 - k * 0.24, -1.28], [0.03, 0.05, 0.17]);
    }
    bead(tree, S.stoneDark, [0, 3.15, -1.76], [0.07, 0.11, 0.08]);
    const beard = mesh(new THREE.CylinderGeometry(0.1, 0.07, 0.5, 10), S.blue, tree);
    beard.position.set(0, 2.55, -1.62);
    for (let k = 0; k < 5; k++) bead(tree, S.blue, [0, 3.55 + (k % 2) * 0.05, -1.65 + k * 0.28], [0.62, 0.04, 0.06]);
    bead(tree, S.blue, [0, 3.0, -1.25], [0.66, 0.05, 0.62]);
    tube(tree, [[0, 1.3, 2.3], [0.5, 1.25, 2.6], [0.9, 1.25, 2.1], [1.0, 1.3, 1.4]], 0.07, S.stone);
    // Dunes, stones and pyramids in the distance.
    for (let i = 0; i < 18; i++) {
      const a = i * 2.399963;
      const r = stageRadius + 2 + (i % 5) * 3;
      oval(scene, M.stone, TREE_CENTRE.x + Math.cos(a) * r, -0.35, TREE_CENTRE.z + Math.sin(a) * r, 2.4 + (i % 3), 0.5 + (i % 2) * 0.3, 1.8);
    }
    for (let i = 0; i < 4; i++) {
      const a = 2.2 + i * 0.55;
      const r = stageRadius + 28 + (i % 2) * 8;
      const h = 9 + (i % 3) * 3;
      const p = mesh(new THREE.ConeGeometry(h * 0.9, h, 4), S.pyramid);
      p.position.set(TREE_CENTRE.x + Math.cos(a) * r, h / 2 - 0.25, TREE_CENTRE.z + Math.sin(a) * r);
      p.rotation.y = Math.PI / 4 + a;
    }
  }

  // Shrek lying on his back, arms spread, on a mud bank. The model ("Shrek" by
  // HarrisonHag1, CC BY 4.0, public/models/shrek) is drawn when loaded; the
  // colliders are ellipsoids fitted to it (head, body, arms, legs), which also
  // stand in for it until it has loaded.
  function shrek() {
    const K = {
      mud: material("#6a5233", 0.95),
      mudLight: material("#81663f", 0.9),
      skin: material("#8bb43a", 0.6),
      shirt: material("#e6d8b4", 0.85),
      pants: material("#5b4a33", 0.85),
      white: material("#fbf8ec", 0.3),
      reed: material("#6f8a3a", 0.8),
      cattail: material("#5a3a22", 0.9),
      mushroom: material("#d24a3a", 0.5),
      wood: material("#7a5634", 0.85),
    };
    pedestal(2.3, K.mudLight, K.mud);
    blob(tree, K.mud, [0, 0.55, 0], [3.9, 0.7, 3.4], { kind: "base", segments: [24, 10] });
    // Where the model goes, lying on its back: feet towards +z, face up.
    const FIT = { x: 3.58, zMin: -2.7, zMax: 2.72, yMin: 1.17 };
    const leafy = { kind: "leaf" };
    const parts = [];
    const surface = model("shrek-collider");
    if (surface) {
      // His own surface (simplified), shown in plain green until the model is in.
      const geo = surface.clone();
      if (visual) geo.computeVertexNormals();
      const body = mesh(geo, K.skin, tree);
      collider(body, "leaf", 0.92, 0.15);
      parts.push(body);
    } else {
      // Without it: ellipsoids roughly fitted to him.
      parts.push(blob(tree, K.skin, [0, 2.62, -1.87], [0.79, 0.81, 0.82], leafy));
      parts.push(blob(tree, K.shirt, [0, 2.24, 0.26], [1.1, 0.98, 1.14], leafy));
      for (const s of [-1, 1]) {
        parts.push(blob(tree, K.skin, [s * 2.34, 2.11, 0.1], [1.24, 0.45, 0.41], leafy));
        parts.push(blob(tree, K.pants, [s * 0.46, 2.3, 1.75], [0.46, 0.65, 0.95], leafy));
      }
    }
    if (!visual) return;
    // The model: loaded in the background; the ellipsoids hide once it is in.
    const holder = new THREE.Group();
    tree.add(holder);
    import("three/examples/jsm/loaders/GLTFLoader.js").then(({ GLTFLoader }) => {
      new GLTFLoader().load("models/shrek/scene.gltf", gltf => {
        const model = gltf.scene;
        model.traverse(o => {
          if (!o.isMesh) return;
          // The eyes are a stray tiny mesh outside the skeleton; the texture has them.
          if (!o.isSkinnedMesh) {
            o.visible = false;
            return;
          }
          o.castShadow = true;
          o.receiveShadow = true;
          o.frustumCulled = false;
          for (const m of [o.material].flat()) {
            m.transparent = false;
            m.depthWrite = true;
            materials.add(m);
          }
          geometries.add(o.geometry);
        });
        // On its back: head (+y) towards -z, front (+z) up. Placed by the model's
        // own measurements (its rest pose spans x ±54.97, y -0.24…82.97,
        // z -17.41…17.37 in file units), the same numbers the colliders were fitted to.
        const pivot = new THREE.Group();
        pivot.rotation.x = -Math.PI / 2;
        pivot.add(model);
        const unit = (FIT.zMax - FIT.zMin) / (82.97 + 0.24);
        pivot.scale.setScalar(unit * scale);
        pivot.position.set(0, (FIT.yMin + 17.41 * unit) * scale, (FIT.zMin + 82.97 * unit) * scale);
        holder.add(pivot);
        for (const p of parts) p.visible = false;
      }, undefined, () => { /* keep the ellipsoids */ });
    });
    // Swamp: reeds with cattails, mushrooms, logs.
    for (let i = 0; i < 40; i++) {
      const a = i * 2.399963;
      const r = stageRadius + 0.7 + (i % 5) * 1.2;
      const x = TREE_CENTRE.x + Math.cos(a) * r;
      const z = TREE_CENTRE.z + Math.sin(a) * r;
      const h = 1 + (i % 3) * 0.35;
      tube(scene, [[x, -0.25, z], [x + 0.05, h * 0.5, z], [x + 0.12, h, z + 0.04]], 0.025, K.reed);
      if (i % 2 === 0) oval(scene, K.cattail, x + 0.12, h + 0.12, z + 0.04, 0.06, 0.18, 0.06);
      if (i % 7 === 3) {
        oval(scene, K.mushroom, x + 0.6, 0.12, z, 0.28, 0.14, 0.28);
        oval(scene, K.white, x + 0.6, -0.05, z, 0.08, 0.2, 0.08);
      }
    }
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05 + 0.4;
      const r = stageRadius + 4 + (i % 2) * 3;
      const log = mesh(new THREE.CylinderGeometry(0.35, 0.4, 3.2, 12), K.wood);
      log.position.set(TREE_CENTRE.x + Math.cos(a) * r, 0.1, TREE_CENTRE.z + Math.sin(a) * r);
      log.rotation.set(Math.PI / 2, 0, a);
    }
    // Far behind the players: Shrek's stump house and his outhouse, gnarled
    // swamp trees with hanging moss.
    const S = {
      bark: material("#4e3a26", 0.95),
      barkLight: material("#6b5034", 0.9),
      moss: material("#5d7a2f", 0.9),
      hangingMoss: material("#7d8f52", 0.9, { side: THREE.DoubleSide }),
      leaves: material("#3f5d26", 0.9),
      plank: material("#8a6238", 0.85),
      plankDark: material("#5e4024", 0.9),
      stone: material("#8d8a80", 0.95),
      window: material("#f3d27a", 0.6, { emissive: "#6b4a10" }),
      hole: material("#20160c", 0.9),
      roof: material("#6a7a3a", 0.95),
    };
    const at = (angle, distance) => [TREE_CENTRE.x + Math.sin(angle) * distance, TREE_CENTRE.z + Math.cos(angle) * distance];
    const homeDistance = stageRadius + 21;
    // The house, as in the films: a low plastered cottage under a thick, shaggy
    // grass roof, a huge broken tree trunk rising from behind it with roots
    // sprawling over the roof to the ground, and warning signs out front.
    function house(angle) {
      const H = {
        wall: material("#cdb995", 0.95),
        post: material("#6e4f2e", 0.9),
        door: material("#5a3c20", 0.85),
        trunk: material("#8b7c66", 0.95),
        trunkDark: material("#6c5f4c", 0.95),
        grass: material("#7c9a3a", 0.95),
        grassLight: material("#a3b552", 0.95, { side: THREE.DoubleSide }),
        sign: material("#a77b4a", 0.9),
      };
      const [x, z] = at(angle, homeDistance);
      const house = new THREE.Group();
      house.position.set(x, -0.25, z);
      house.rotation.y = angle + Math.PI;
      house.scale.setScalar(1.5);
      scene.add(house);
      // Cottage: plastered walls between dark posts, a door and two shuttered windows.
      const body = mesh(new THREE.BoxGeometry(6, 2.4, 3.6), H.wall, house);
      body.position.set(0, 1.2, 0);
      for (const px of [-3, -1.6, -0.55, 0.55, 1.6, 3]) {
        const post = mesh(new THREE.BoxGeometry(0.22, 2.5, 0.22), H.post, house);
        post.position.set(px, 1.25, 1.82);
      }
      const beam = mesh(new THREE.BoxGeometry(6.3, 0.24, 0.26), H.post, house);
      beam.position.set(0, 2.4, 1.84);
      const door = mesh(new THREE.BoxGeometry(1.05, 2, 0.08), H.door, house);
      door.position.set(0, 1.0, 1.84);
      for (const dx of [-0.26, 0, 0.26]) {
        const plank = mesh(new THREE.BoxGeometry(0.03, 1.95, 0.02), H.post, house);
        plank.position.set(dx, 1.0, 1.9);
      }
      for (const side of [-1, 1]) {
        const win = mesh(new THREE.BoxGeometry(0.85, 0.8, 0.05), S.window, house);
        win.position.set(side * 2.1, 1.45, 1.84);
        for (const s2 of [-1, 1]) {
          const shutter = mesh(new THREE.BoxGeometry(0.42, 0.9, 0.06), H.door, house);
          shutter.position.set(side * 2.1 + s2 * 0.66, 1.45, 1.87);
        }
      }
      // Shaggy grass roof: a thick mound with tufts hanging over the edges.
      const roof = mesh(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), H.grass, house);
      roof.scale.set(3.6, 1.5, 2.5);
      roof.position.set(0, 2.35, 0);
      const tuft = new THREE.ConeGeometry(0.22, 1, 5);
      geometries.add(tuft);
      for (let i = 0; i < 70; i++) {
        const a = i * 2.399963;
        const ring = 0.75 + (i % 4) * 0.08;
        const t = mesh(tuft, i % 3 ? H.grass : H.grassLight, house);
        const px = Math.cos(a) * 3.6 * ring;
        const pz = Math.sin(a) * 2.5 * ring;
        const len = 0.8 + (i % 5) * 0.2;
        t.scale.set(1, len, 1);
        t.position.set(px * 1.05, 2.45 + (1 - ring) * 2.2, pz * 1.05);
        // Pointing outwards and down, like grass over the eaves.
        t.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(px, -1.6, pz).normalize());
        t.castShadow = false;
      }
      // The huge broken trunk behind, leaning a little, with a jagged top.
      const trunk = mesh(new THREE.CylinderGeometry(1.2, 2.1, 9, 12, 4), H.trunk, house);
      trunk.position.set(0.4, 5.6, -1.4);
      trunk.rotation.z = -0.05;
      const crown = mesh(new THREE.ConeGeometry(1.25, 1.6, 7, 1, true), H.trunkDark, house);
      crown.position.set(0.15, 10.6, -1.4);
      crown.rotation.set(Math.PI, 0.3, 0.12);
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3 + 0.4;
        const shard = mesh(new THREE.ConeGeometry(0.3, 1.2 + (i % 3) * 0.5, 4), H.trunk, house);
        shard.position.set(0.2 + Math.sin(a) * 0.95, 10.4 + (i % 2) * 0.4, -1.4 + Math.cos(a) * 0.95);
      }
      for (let i = 0; i < 10; i++) {
        const a = i * 0.63;
        oval(house, H.grass, 0.4 + Math.sin(a) * 1.45, 3.8 + i * 0.6, -1.4 + Math.cos(a) * 1.45, 0.35, 0.7, 0.35);
      }
      // Roots sprawling from the trunk over the roof down to the ground.
      for (const [rx, rz, bend] of [[-4.6, 1.6, 1], [4.8, 1.2, -1], [-3.4, -2.8, 1], [3.8, -2.6, -1], [5.4, -0.4, -1]]) {
        tube(house, [[0.4, 4.2, -1.4], [rx * 0.45, 3.6, rz * 0.35 - 0.8], [rx * 0.85, 2.0 + bend * 0.2, rz * 0.8], [rx, -0.1, rz]], 0.34, H.trunk);
      }
      // Warning signs on posts.
      const signs = [["BEWARE\nOGRE", -3.2, 4.2, 0.25], ["STAY\nOUT", 0.9, 5.2, -0.1], ["DANGER", 3.6, 4.6, -0.3]];
      for (const [text, sx, sz, turn] of signs) {
        const stick = mesh(new THREE.CylinderGeometry(0.07, 0.08, 1.6, 6), H.post, house);
        stick.position.set(sx, 0.8, sz);
        const board = mesh(new THREE.BoxGeometry(1.3, 0.85, 0.08), H.sign, house);
        board.position.set(sx, 1.55, sz + 0.06);
        board.rotation.set(0, turn, (sx % 2) * 0.05);
        if (typeof document !== "undefined") {
          const canvas = document.createElement("canvas");
          canvas.width = 256;
          canvas.height = 160;
          const c = canvas.getContext("2d");
          c.fillStyle = "#a77b4a";
          c.fillRect(0, 0, 256, 160);
          c.fillStyle = "#3a1f0c";
          c.font = "bold 46px Georgia, serif";
          c.textAlign = "center";
          const lines = text.split("\n");
          lines.forEach((line, k) => c.fillText(line, 128, 80 + (k - (lines.length - 1) / 2) * 50 + 16));
          const texture = new THREE.CanvasTexture(canvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          const face = mesh(new THREE.PlaneGeometry(1.24, 0.79), material("#ffffff", 0.9, { map: texture }), house);
          face.position.copy(board.position).add(new THREE.Vector3(Math.sin(turn) * 0.05, 0, Math.cos(turn) * 0.05));
          face.rotation.copy(board.rotation);
          face.castShadow = false;
        }
      }
    }
    // The outhouse: planks, a slanted roof and the crescent moon on the door.
    function outhouse(angle) {
      const [x, z] = at(angle, homeDistance - 1);
      const outhouse = new THREE.Group();
      outhouse.position.set(x, -0.25, z);
      outhouse.rotation.y = angle + Math.PI;
      outhouse.scale.setScalar(2.8);
      scene.add(outhouse);
      const hut = mesh(new THREE.BoxGeometry(1.3, 2.3, 1.3), S.plank, outhouse);
      hut.position.y = 1.15;
      for (const dx of [-0.43, 0, 0.43]) {
        const seam = mesh(new THREE.BoxGeometry(0.04, 2.3, 0.02), S.plankDark, outhouse);
        seam.position.set(dx, 1.15, 0.66);
      }
      const roof = mesh(new THREE.BoxGeometry(1.6, 0.12, 1.7), S.plankDark, outhouse);
      roof.position.set(0, 2.45, 0);
      roof.rotation.x = -0.25;
      const door = mesh(new THREE.BoxGeometry(0.9, 1.9, 0.05), S.plankDark, outhouse);
      door.position.set(0, 1.0, 0.67);
      const moon = new THREE.Shape();
      moon.absarc(0, 0, 0.16, 0, Math.PI * 2, false);
      const bite = new THREE.Path();
      bite.absarc(0.08, 0.04, 0.14, 0, Math.PI * 2, true);
      moon.holes.push(bite);
      const crescent = mesh(new THREE.ShapeGeometry(moon, 20), S.hole, outhouse);
      crescent.position.set(-0.05, 1.6, 0.7);
      const handle = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.12, 8), S.stone, outhouse);
      handle.rotation.x = Math.PI / 2;
      handle.position.set(0.32, 1.0, 0.72);
    }
    // One landmark for each player to see: a camera looks across the field from
    // behind its launcher, so each stands opposite a launcher (the house and the
    // outhouse in turn). Alone, the house stands behind, a little to the side.
    const landmarks = views > 1
      ? Array.from({ length: views }, (_, i) => (i / views) * Math.PI * 2 + Math.PI)
      : [Math.PI + 0.35];
    landmarks.forEach((angle, i) => (i % 2 ? outhouse : house)(angle));
    // Gnarled swamp trees: a twisted trunk, crooked boughs, dark crowns and
    // moss hanging in strands.
    const strand = new THREE.ConeGeometry(0.12, 1, 5, 1, true);
    geometries.add(strand);
    for (let i = 0; i < 26; i++) {
      const angle = i * 2.399963 + 0.3;
      if (landmarks.some(l => Math.abs(Math.atan2(Math.sin(angle - l), Math.cos(angle - l))) < 0.35)) continue;
      const distance = stageRadius + 23 + (i % 5) * 4.5;
      const [x, z] = at(angle, distance);
      const h = 7 + (i % 4) * 1.6;
      const lean = (i % 2 ? 1 : -1) * (0.6 + (i % 3) * 0.3);
      const top = [x + lean, h, z + lean * 0.4];
      tube(scene, [[x, -0.25, z], [x - lean * 0.3, h * 0.35, z + 0.2], [x + lean * 0.4, h * 0.7, z - 0.2], top], 0.42, S.bark);
      for (let k = 0; k < 4; k++) {
        const a = k * Math.PI / 2 + i;
        const reach = 2.2 + (k % 2) * 0.8;
        const end = [top[0] + Math.sin(a) * reach, h - 0.6 - (k % 2) * 0.8, top[2] + Math.cos(a) * reach];
        tube(scene, [[top[0], h - 1.2, top[2]], [(top[0] + end[0]) / 2, h + 0.1, (top[2] + end[2]) / 2], end], 0.16, S.bark);
        oval(scene, S.leaves, end[0], end[1] + 0.5, end[2], 1.6, 0.8, 1.6);
        for (let m = 0; m < 3; m++) {
          const hang = mesh(strand, S.hangingMoss, scene);
          const len = 1.2 + ((i + k + m) % 3) * 0.7;
          hang.scale.set(1, len, 1);
          hang.rotation.x = Math.PI;
          hang.position.set(end[0] + (m - 1) * 0.5, end[1] - len / 2, end[2] + ((m + k) % 2 - 0.5) * 0.5);
          hang.castShadow = false;
        }
      }
      oval(scene, S.leaves, top[0], h + 0.6, top[2], 2.2, 1.0, 2.2);
    }
  }

  // A castle: four towers joined by walls around a keep. Frogs score on the
  // wall walks, the open tower tops and the keep's roof; the courtyard is a pit.
  // The castle built from Kenney's Castle Kit (see models.js); colliders are the
  // pieces' own triangles. Without the models loaded, the block castle below.
  function castle() {
    if (!model("wall")) return castleBlocks();
    const CELL = 1.3;
    const BASE_Y = 0.52;
    let kit;
    if (visual) {
      const texture = new THREE.TextureLoader().load(CASTLE_TEXTURE);
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      kit = material("#ffffff", 0.7, { map: texture, side: THREE.DoubleSide });
    }
    const C = {
      top: material("#e8c9a8", 0.8),
      side: material("#c99b78", 0.85),
      water: material("#5b9cc2", 0.25),
      hill: material("#86a865", 0.95),
    };
    pedestal(4.5, C.top, C.side);
    // One piece of the kit at `pos` turned by `turn`, `size` metres to a cell.
    function piece(name, pos, turn = 0, size = CELL, kind = null, parent = tree) {
      const geo = model(name).clone().scale(size, size, size);
      const obj = mesh(geo, kit, parent);
      obj.position.set(...pos);
      obj.rotation.y = turn;
      if (kind) collider(obj, kind, kind === "leaf" ? 0.92 : 0.7, 0.15);
      return obj;
    }
    const T = 2 * CELL;
    const corners = [[T, T], [-T, T], [-T, -T], [T, -T]];
    // Walls: three blocks between each pair of towers. Frogs score on their tops.
    corners.forEach(([ax, az], k) => {
      const [bx, bz] = corners[(k + 1) % 4];
      const turn = Math.atan2(bx - ax, bz - az) + Math.PI / 2;
      for (const t of [0.25, 0.5, 0.75]) piece("wall", [ax + (bx - ax) * t, BASE_Y, az + (bz - az) * t], turn, CELL, "leaf");
    });
    // Towers: two open on top, two with pointed roofs and flags.
    corners.forEach(([x, z], k) => {
      const turn = Math.atan2(x, z);
      piece("tower-square-base", [x, BASE_Y, z], turn, CELL, "tree");
      if (k % 2 === 0) {
        piece("tower-square-mid-windows", [x, BASE_Y + 1.01 * CELL, z], turn, CELL, "tree");
        piece("tower-square-top", [x, BASE_Y + 2.02 * CELL, z], turn, CELL, "leaf");
      } else {
        piece("tower-square-roof", [x, BASE_Y + 1.01 * CELL, z], turn, CELL, "tree");
        if (visual) piece("flag", [x, BASE_Y + 3.0 * CELL, z], turn, CELL);
      }
    });
    // The keep in the middle, open on top.
    const KEEP = 1.6;
    piece("tower-square-base", [0, BASE_Y, 0], 0, KEEP, "tree");
    piece("tower-square-mid-windows", [0, BASE_Y + 1.01 * KEEP, 0], 0, KEEP, "tree");
    piece("tower-square-top", [0, BASE_Y + 2.02 * KEEP, 0], 0, KEEP, "leaf");
    if (!visual) return;
    piece("gate", [0, BASE_Y, T + 0.66 * CELL], Math.PI / 2, CELL * 1.2);
    for (const side of [0, 1, 2, 3]) {
      const a = side * Math.PI / 2;
      piece("flag-banner-long", [Math.sin(a) * 0.82 * KEEP, BASE_Y + 0.4, Math.cos(a) * 0.82 * KEEP], a - Math.PI / 2, 0.9);
    }
    // A moat around the stage; rocks on its edge, trees and hills further out.
    const moat = mesh(new THREE.RingGeometry(stageRadius + 0.5, stageRadius + 3, 96), C.water);
    moat.rotation.x = -Math.PI / 2;
    moat.position.set(TREE_CENTRE.x, -0.22, TREE_CENTRE.z);
    moat.castShadow = false;
    for (let i = 0; i < 14; i++) {
      const a = i * 2.399963;
      const r = stageRadius + 3.6 + (i % 3) * 0.8;
      piece(i % 2 ? "rocks-large" : "rocks-small", [TREE_CENTRE.x + Math.cos(a) * r, -0.25, TREE_CENTRE.z + Math.sin(a) * r], a, 1.2 + (i % 3) * 0.3, null, scene);
    }
    for (let i = 0; i < 34; i++) {
      const a = i * 2.399963 + 0.7;
      const r = stageRadius + 24 + (i % 6) * 4;
      piece(i % 3 ? "tree-large" : "tree-small", [TREE_CENTRE.x + Math.cos(a) * r, -0.25, TREE_CENTRE.z + Math.sin(a) * r], a, 2.6 + (i % 4) * 0.5, null, scene);
    }
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05 + 0.3;
      oval(scene, C.hill, TREE_CENTRE.x + Math.cos(a) * (stageRadius + 40), -2, TREE_CENTRE.z + Math.sin(a) * (stageRadius + 40), 14, 7, 10);
    }
  }

  // The castle from simple blocks (used when the kit's models are not loaded).
  function castleBlocks() {
    const C = {
      wall: material("#bdb6a6", 0.85),
      wallDark: material("#938c7e", 0.9),
      top: material("#d3ccbc", 0.8),
      roof: material("#b0413e", 0.6),
      wood: material("#5d3f24", 0.8),
      window: material("#2b2722", 0.9),
      flag: material("#2f6fd0", 0.5, { side: THREE.DoubleSide }),
      flag2: material("#e3b33a", 0.5, { side: THREE.DoubleSide }),
      water: material("#5b9cc2", 0.25),
      pine: material("#3f6e3a", 0.8),
      hill: material("#86a865", 0.95),
    };
    pedestal(2.75, C.top, C.wallDark);
    // Many small blocks as one collider: [x, y, z, width, height, depth, turn].
    function blocks(mat, list, kind) {
      const parts = list.map(([x, y, z, w, h, d, turn = 0]) => new THREE.BoxGeometry(w, h, d).rotateY(turn).translate(x, y, z));
      const geo = mergeGeometries(parts);
      parts.forEach(g => g.dispose());
      const obj = mesh(geo, mat, tree);
      if (kind) collider(obj, kind, kind === "leaf" ? 0.92 : 0.7, 0.15);
      return obj;
    }
    const T = 1.95;
    const corners = [[T, T], [-T, T], [-T, -T], [T, -T]];
    const walls = [];
    const walks = [];
    const merlons = [];
    corners.forEach(([ax, az], k) => {
      const [bx, bz] = corners[(k + 1) % 4];
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      const dx = Math.sign(bx - ax);
      const dz = Math.sign(bz - az);
      const turn = Math.atan2(-dz, dx);
      const length = 2 * T - 0.9;
      const ox = Math.sign(mx);
      const oz = Math.sign(mz);
      walls.push([mx, 1.6, mz, length, 2.2, 0.5, turn]);
      walks.push([mx, 2.76, mz, length, 0.12, 0.66, turn]);
      for (let i = 0; i < 5; i++) {
        const t = (i - 2) * length / 5;
        merlons.push([mx + dx * t + ox * 0.26, 2.98, mz + dz * t + oz * 0.26, 0.3, 0.32, 0.14, turn]);
      }
    });
    blocks(C.wall, walls, "tree");
    blocks(C.top, walks, "leaf");
    // Towers: two open on top (with battlements), two with pointed roofs.
    const towerMerlons = [];
    corners.forEach(([x, z], k) => {
      cylinder(tree, C.wall, [x, 2.35, z], 0.58, 0.64, 3.7, { kind: "tree", sides: 20 });
      if (k % 2 === 0) {
        cylinder(tree, C.top, [x, 4.27, z], 0.74, 0.7, 0.14, { kind: "leaf", sides: 20 });
        for (let i = 0; i < 8; i++) {
          const a = i * Math.PI / 4;
          towerMerlons.push([x + Math.sin(a) * 0.66, 4.49, z + Math.cos(a) * 0.66, 0.24, 0.3, 0.14, a]);
        }
      } else {
        place(mesh(new THREE.ConeGeometry(0.8, 1.3, 20), C.roof, tree), [x, 4.85, z], { kind: "tree" });
      }
    });
    // The keep, its battlements, and a turret on top.
    box(tree, C.wallDark, [0, 1.8, 0], [1.5, 2.6, 1.5], { kind: "tree" });
    box(tree, C.top, [0, 3.17, 0], [1.72, 0.14, 1.72], { kind: "leaf" });
    for (let side = 0; side < 4; side++) {
      const a = side * Math.PI / 2;
      for (const t of [-0.6, 0, 0.6]) {
        towerMerlons.push([Math.sin(a) * 0.8 + Math.cos(a) * t, 3.38, Math.cos(a) * 0.8 - Math.sin(a) * t, 0.26, 0.28, 0.14, a]);
      }
    }
    blocks(C.wall, [...merlons, ...towerMerlons], "tree");
    cylinder(tree, C.wall, [0.35, 3.6, 0.35], 0.24, 0.26, 0.7, { kind: "tree", sides: 14 });
    place(mesh(new THREE.ConeGeometry(0.36, 0.6, 14), C.roof, tree), [0.35, 4.25, 0.35], { kind: "tree" });
    if (!visual) return;
    // Windows, gate, flags.
    corners.forEach(([x, z], k) => {
      const a = Math.atan2(x, z);
      for (const y of [1.6, 2.7, 3.6]) {
        box(tree, C.window, [x + Math.sin(a) * 0.62, y, z + Math.cos(a) * 0.62], [0.16, 0.34, 0.06], { rot: [0, a, 0] });
      }
      if (k % 2 === 1) {
        tube(tree, [[x, 5.4, z], [x, 6.3, z]], 0.025, C.wood);
        box(tree, k === 1 ? C.flag : C.flag2, [x + 0.28, 6.1, z], [0.52, 0.32, 0.02]);
      }
    });
    tube(tree, [[0.35, 4.5, 0.35], [0.35, 5.2, 0.35]], 0.02, C.wood);
    box(tree, C.flag2, [0.57, 5.02, 0.35], [0.42, 0.26, 0.02]);
    box(tree, C.wood, [0, 1.15, T + 0.26], [0.85, 1.25, 0.04]);
    box(tree, C.window, [0, 1.85, T + 0.26], [0.85, 0.2, 0.04]);
    for (let side = 0; side < 4; side++) {
      const a = side * Math.PI / 2;
      box(tree, C.window, [Math.sin(a) * 0.76, 2.4, Math.cos(a) * 0.76], [0.18, 0.4, 0.04], { rot: [0, a, 0] });
    }
    // A moat around the stage, pine trees and hills in the distance.
    const moat = mesh(new THREE.RingGeometry(stageRadius + 0.5, stageRadius + 3, 96), C.water);
    moat.rotation.x = -Math.PI / 2;
    moat.position.set(TREE_CENTRE.x, -0.22, TREE_CENTRE.z);
    moat.castShadow = false;
    const pine = new THREE.ConeGeometry(1.4, 4.5, 10);
    geometries.add(pine);
    for (let i = 0; i < 30; i++) {
      const a = i * 2.399963;
      const r = stageRadius + 24 + (i % 6) * 4;
      const x = TREE_CENTRE.x + Math.cos(a) * r;
      const z = TREE_CENTRE.z + Math.sin(a) * r;
      const p = mesh(pine, C.pine);
      p.position.set(x, 2, z);
      p.scale.setScalar(0.7 + (i % 3) * 0.25);
      p.position.y = -0.25 + 2.25 * p.scale.y;
    }
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05 + 0.3;
      oval(scene, C.hill, TREE_CENTRE.x + Math.cos(a) * (stageRadius + 40), -2, TREE_CENTRE.z + Math.sin(a) * (stageRadius + 40), 14, 7, 10);
    }
  }

  ({ classic, jungle, sphinx, shrek, castle })[map]();

  // Grow the whole stand by the chosen scale. Scaling every position and
  // geometry (each shared one once) keeps transforms at unit scale, which the
  // collision code expects.
  if (scale !== 1) {
    const scaled = new Set();
    baseGroup.traverse(o => {
      if (o === baseGroup) return;
      o.position.multiplyScalar(scale);
      if (o.isMesh && !scaled.has(o.geometry)) {
        scaled.add(o.geometry);
        o.geometry.scale(scale, scale, scale);
      }
    });
  }
  for (const args of pending) measure(...args);
  for (const c of colliders) {
    let p = c.object;
    while (p) {
      if (p === tree) { c.moving = true; break; }
      p = p.parent;
    }
  }

  // Each frog is one mesh (vertex-coloured), not ~30, to keep draw calls low with many frogs.
  const frogMaterial = visual ? material("#ffffff", 0.38) : undefined;
  if (frogMaterial) frogMaterial.vertexColors = true;
  const frogGeometries = new Map();
  function frogGeometry(color) {
    if (frogGeometries.has(color)) return frogGeometries.get(color);
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
    root.updateMatrixWorld(true);
    const parts = [];
    root.traverse(o => {
      if (!o.isMesh) return;
      const part = sphereGeometry.clone().applyMatrix4(o.matrixWorld);
      const c = o.material.color;
      const colours = new Float32Array(part.attributes.position.count * 3);
      for (let k = 0; k < colours.length; k += 3) colours.set([c.r, c.g, c.b], k);
      part.setAttribute("color", new THREE.BufferAttribute(colours, 3));
      parts.push(part);
    });
    const merged = mergeGeometries(parts);
    parts.forEach(p => p.dispose());
    geometries.add(merged);
    frogGeometries.set(color, merged);
    return merged;
  }
  function frog(color = 0) {
    const obj = new THREE.Mesh(frogGeometry(color), frogMaterial);
    obj.castShadow = true;
    obj.receiveShadow = true;
    return obj;
  }

  return { scene, tree, colliders, geometries, materials, M, FM, mesh, tube, leaf, frog, material, env };
}
