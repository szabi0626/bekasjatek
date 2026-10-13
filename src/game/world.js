// The playing field: stage, rotating tree, leaves and frogs. Shared by the
// browser (which draws it) and the game server (which only needs colliders),
// so nothing here may touch the DOM or WebGL.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

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
  // Distance of the launchers from the tree's axis (10.25 is the original game's).
  const radius = 10.25 + (s - 1) * 3.5;
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

/**
 * Builds the field into a new scene. With `visual: false` only the parts that
 * collide are created (no materials, decorations, frogs or launchers).
 */
export function buildWorld({ visual = true, treeScale = 1 } = {}) {
  const { scale, stageRadius } = layout(treeScale);
  const scene = new THREE.Scene();
  const geometries = new Set();
  const materials = new Set();
  function material(color, roughness = 0.55) {
    if (!visual) return undefined;
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
  function branch(parent, a, b, r1, r2) {
    const direction = b.clone().sub(a);
    const obj = mesh(new THREE.CylinderGeometry(r2, r1, direction.length(), 14), M.trunk, parent);
    obj.position.copy(a).add(b).multiplyScalar(0.5);
    obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    collider(obj);
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
    for (let i = 0; i < 28; i++) {
      const a = i * 2.399963;
      const radius = stageRadius + 1.4 + (i % 4) * 1.1;
      oval(scene, M.stone, TREE_CENTRE.x + Math.cos(a) * radius, -0.13, TREE_CENTRE.z + Math.sin(a) * radius,
        0.4 + (i % 3) * 0.15, 0.19, 0.4);
    }
  }

  const baseGroup = new THREE.Group();
  baseGroup.position.copy(TREE_CENTRE);
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
    const yellow = visual && mat === M.yellow;
    const rim = mesh(new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(points, true), 64, 0.035, 6, true
    ), yellow ? M.light : M.edge, parent);
    if (physical) collider(rim, "leaf", 0.85, 0.17);
    if (!visual) return;
    tube(parent, [[0, 0.115, -length * 0.72], [0, 0.12, 0], [0, 0.12, length * 0.8]], 0.022, yellow ? M.dark : M.vein);
    for (const side of [-1, 1]) {
      for (const z of [-0.55, 0.1, 0.65]) {
        tube(parent, [[0, 0.12, z + 0.2], [side * width * 0.45, 0.12, z], [side * width * 0.78, 0.115, z - 0.2]], 0.014, yellow ? M.dark : M.vein);
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
  // Grow the whole tree (and its pedestal) by the chosen scale. Scaling every
  // position and geometry keeps transforms at unit scale, which the collision code expects.
  if (scale !== 1) {
    baseGroup.traverse(o => {
      if (o === baseGroup) return;
      o.position.multiplyScalar(scale);
      if (o.isMesh) o.geometry.scale(scale, scale, scale);
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

  return { scene, tree, colliders, geometries, materials, M, FM, mesh, tube, leaf, frog, material };
}
