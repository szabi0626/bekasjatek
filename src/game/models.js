// 3D models from files (public/models/…), as plain geometry: the game server
// builds colliders from the same triangles the browser draws. Models are loaded
// once, before a field is built (buildWorld needs them at hand).
import * as THREE from "three";

// Kenney's Castle Kit (CC0, www.kenney.nl): pieces in 1-unit cells, coloured
// from one palette texture.
export const CASTLE_PIECES = [
  "tower-square-base", "tower-square-mid", "tower-square-mid-windows", "tower-square-top",
  "tower-square-roof", "wall", "gate", "flag", "flag-banner-long",
  "tree-large", "tree-small", "rocks-large", "rocks-small",
];
export const CASTLE_TEXTURE = "models/castle/colormap.png";

const cache = new Map();
export const model = name => cache.get(name);

const SIZES = { 5126: 4, 5123: 2, 5125: 4, 5121: 1 };
const ARRAYS = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array };
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Reads a binary glTF (.glb) into one BufferGeometry: positions, normals, uvs, indices. */
export function parseGlb(data) {
  const bytes = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const view = new DataView(bytes);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)));
  const binStart = 20 + jsonLength + 8;
  function read(index) {
    const a = json.accessors[index];
    const bv = json.bufferViews[a.bufferView];
    const n = COMPONENTS[a.type];
    const size = SIZES[a.componentType];
    const stride = bv.byteStride || n * size;
    const start = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = new ARRAYS[a.componentType](a.count * n);
    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < n; k++) {
        const at = start + i * stride + k * size;
        out[i * n + k] = a.componentType === 5126 ? view.getFloat32(at, true)
          : a.componentType === 5125 ? view.getUint32(at, true)
          : a.componentType === 5123 ? view.getUint16(at, true) : view.getUint8(at);
      }
    }
    return out;
  }
  // Every primitive of every node (with the node's own transform), merged.
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const matrix = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const p = new THREE.Vector3();
  for (const node of json.nodes || []) {
    if (node.mesh == null) continue;
    matrix.compose(
      new THREE.Vector3(...(node.translation || [0, 0, 0])),
      new THREE.Quaternion(...(node.rotation || [0, 0, 0, 1])),
      new THREE.Vector3(...(node.scale || [1, 1, 1])),
    );
    normalMatrix.getNormalMatrix(matrix);
    for (const prim of json.meshes[node.mesh].primitives) {
      const base = positions.length / 3;
      const pos = read(prim.attributes.POSITION);
      const nor = prim.attributes.NORMAL != null ? read(prim.attributes.NORMAL) : null;
      const uv = prim.attributes.TEXCOORD_0 != null ? read(prim.attributes.TEXCOORD_0) : null;
      for (let i = 0; i < pos.length / 3; i++) {
        p.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(matrix);
        positions.push(p.x, p.y, p.z);
        if (nor) {
          p.set(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]).applyMatrix3(normalMatrix).normalize();
          normals.push(p.x, p.y, p.z);
        } else normals.push(0, 1, 0);
        uvs.push(uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0);
      }
      const idx = prim.indices != null ? read(prim.indices) : Array.from({ length: pos.length / 3 }, (_, i) => i);
      for (const i of idx) indices.push(base + i);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/**
 * Loads every model a field needs (each set on its own: one missing leaves the
 * others). `fetchBytes(path)` returns a file's bytes, path relative to the site root.
 */
export async function loadModels(fetchBytes) {
  await Promise.allSettled([loadCastle(fetchBytes), loadShrekCollider(fetchBytes)]);
}

/**
 * Shrek's collider: his model's surface, already laid out as the map places it
 * (made by scripts/shrek-collider.mjs).
 */
export async function loadShrekCollider(fetchBytes) {
  if (cache.has("shrek-collider")) return;
  const { vertices, indices } = JSON.parse(new TextDecoder().decode(await fetchBytes("models/shrek/collider.json")));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geo.setIndex(indices);
  cache.set("shrek-collider", geo);
}

/**
 * Loads the castle pieces. `fetchBytes(path)` returns the file's bytes (an
 * ArrayBuffer, or a Node Buffer), path relative to the site root.
 */
export async function loadCastle(fetchBytes) {
  await Promise.all(CASTLE_PIECES.map(async name => {
    if (cache.has(name)) return;
    cache.set(name, parseGlb(await fetchBytes(`models/castle/${name}.glb`)));
  }));
}
