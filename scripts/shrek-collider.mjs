// Builds Shrek's collider (public/models/shrek/collider.json) from the model:
// the skinned surface in its rest pose, laid on its back and sized exactly as
// the map draws it (see shrek() in src/game/world.js), then simplified by
// merging vertices on a grid, so frogs meet his real shape without catching on
// small details. Run: node scripts/shrek-collider.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/models/shrek");
// Must match FIT in shrek() (world.js): feet at z 2.72, head at -2.7, back at y 1.17.
const FIT = { zMin: -2.7, zMax: 2.72, yMin: 1.17 };
const GRID = 0.06;

const json = JSON.parse(fs.readFileSync(path.join(DIR, "scene.gltf")));
const bin = fs.readFileSync(path.join(DIR, "scene.bin"));
const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const TYPES = { 5126: [4, "getFloat32"], 5125: [4, "getUint32"], 5123: [2, "getUint16"], 5121: [1, "getUint8"] };
function read(index) {
  const a = json.accessors[index];
  const bv = json.bufferViews[a.bufferView];
  const n = COMPONENTS[a.type];
  const [size, get] = TYPES[a.componentType];
  const stride = bv.byteStride || n * size;
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Float64Array(a.count * n);
  for (let i = 0; i < a.count; i++) {
    for (let k = 0; k < n; k++) out[i * n + k] = view[get](start + i * stride + k * size, true);
  }
  return out;
}

// World matrices of every node in the rest pose.
const world = [];
function walk(i, parent) {
  const node = json.nodes[i];
  const m = new THREE.Matrix4();
  if (node.matrix) m.fromArray(node.matrix);
  else m.compose(new THREE.Vector3(...(node.translation || [0, 0, 0])), new THREE.Quaternion(...(node.rotation || [0, 0, 0, 1])), new THREE.Vector3(...(node.scale || [1, 1, 1])));
  world[i] = parent.clone().multiply(m);
  for (const c of node.children || []) walk(c, world[i]);
}
for (const root of json.scenes[0].nodes) walk(root, new THREE.Matrix4());

const skin = json.skins[0];
const inverseBind = read(skin.inverseBindMatrices);
const jointMatrices = skin.joints.map((j, k) => world[j].clone().multiply(new THREE.Matrix4().fromArray(Array.from(inverseBind.slice(k * 16, k * 16 + 16)))));

// Rest pose (file units) -> the map's frame: on its back, head towards -z.
const unit = (FIT.zMax - FIT.zMin) / (82.97 + 0.24);
const place = p => [p.x * unit, p.z * unit + FIT.yMin + 17.41 * unit, -p.y * unit + FIT.zMin + 82.97 * unit];

// Vertices merged on a grid; triangles that collapse are dropped.
const cells = new Map();
const vertices = [];
const triangles = new Map();
function cell(v) {
  const key = v.map(x => Math.round(x / GRID)).join(",");
  if (!cells.has(key)) {
    cells.set(key, vertices.length / 3);
    vertices.push(...v.map(x => Math.round(x * 1000) / 1000));
  }
  return cells.get(key);
}
const p = new THREE.Vector3();
const t = new THREE.Vector3();
json.nodes.forEach(node => {
  if (node.mesh == null || node.skin == null) return;
  for (const prim of json.meshes[node.mesh].primitives) {
    const pos = read(prim.attributes.POSITION);
    const joints = read(prim.attributes.JOINTS_0);
    const weights = read(prim.attributes.WEIGHTS_0);
    const ids = [];
    for (let k = 0; k < pos.length / 3; k++) {
      p.set(0, 0, 0);
      for (let c = 0; c < 4; c++) {
        const w = weights[k * 4 + c];
        if (w) p.addScaledVector(t.set(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]).applyMatrix4(jointMatrices[joints[k * 4 + c]]), w);
      }
      ids.push(cell(place(p)));
    }
    const index = prim.indices != null ? read(prim.indices) : ids.map((_, k) => k);
    for (let k = 0; k < index.length; k += 3) {
      const tri = [ids[index[k]], ids[index[k + 1]], ids[index[k + 2]]];
      if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
      const key = [...tri].sort((a, b) => a - b).join(",");
      if (!triangles.has(key)) triangles.set(key, tri);
    }
  }
});
const indices = [...triangles.values()].flat();
fs.writeFileSync(path.join(DIR, "collider.json"), JSON.stringify({ vertices, indices }));
console.log(`collider.json: ${vertices.length / 3} vertices, ${indices.length / 3} triangles`);
