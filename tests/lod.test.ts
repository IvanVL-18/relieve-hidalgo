import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { TerrainLod } from '../src/relieve/engine/terrain';

/**
 * Selección de parches (CDLOD): para cualquier cámara, los parches cubren cada celda del estado una sola vez y dos
 * vecinos difieren a lo más en un nivel (lo que permite fundir los vértices sin grietas).
 */
const W = 300, H = 260;
function makeLod(depth = 8) {
  const mat = new THREE.MeshBasicMaterial();
  const lod = new TerrainLod(mat, mat, mat, { depth, range: 30, n: 32 });
  const elev = new Float32Array(W * H), state = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    elev[r * W + c] = 1500 + 400 * Math.sin(c / 17) * Math.cos(r / 23);
    state[r * W + c] = (c - 150) ** 2 / 140 ** 2 + (r - 130) ** 2 / 120 ** 2 < 1 ? 1 : 0;
  }
  lod.setData({ x0: 0, z0: 0, sx: 0.26, sz: 0.276 }, elev, state, W, H);
  return { lod, state };
}

/** Celdas → espaciado (celdas por cuadro) del parche que las cubre; cuenta coberturas. */
function coverage(lod: TerrainLod) {
  const cover = new Uint8Array(W * H), spacing = new Float32Array(W * H);
  const meshes = (lod.view.children as THREE.Mesh[]);
  meshes.forEach((m, q) => {
    const g = m.geometry as THREE.InstancedBufferGeometry, a = g.getAttribute('aPatch') as THREE.InstancedBufferAttribute;
    const quads = q === 0 ? 32 : 16;
    for (let i = 0; i < g.instanceCount; i++) {
      const c0 = a.getX(i), r0 = a.getY(i), s = a.getZ(i), size = s * quads;
      for (let r = r0; r < Math.min(H, r0 + size); r++) for (let c = c0; c < Math.min(W, c0 + size); c++) { cover[r * W + c]++; spacing[r * W + c] = s; }
    }
  });
  return { cover, spacing };
}

/** Frustum que lo abarca todo (para probar solo la selección por distancia). */
const everything = () => new THREE.Frustum(...Array.from({ length: 6 }, (_, i) => new THREE.Plane(new THREE.Vector3(...[[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]][i] as [number, number, number]), 1e6)));

for (const [name, cam] of [['cámara cerca del suelo', [40, 6, 40]], ['cámara alejada', [39, 300, 36]], ['cámara en la orilla', [2, 20, 70]]] as const) {
  test(`parches: cobertura única y vecinos a un nivel (${name})`, () => {
    const { lod, state } = makeLod();
    lod.update(new THREE.Vector3(...cam), everything(), 0.01, 2.5);
    const { cover, spacing } = coverage(lod);
    for (let i = 0; i < W * H; i++) {
      if (!state[i]) continue;
      assert.equal(cover[i], 1, `celda ${i % W},${Math.floor(i / W)} cubierta ${cover[i]} veces`);
    }
    for (let r = 0; r < H; r++) for (let c = 0; c + 1 < W; c++) {
      const a = spacing[r * W + c], b = spacing[r * W + c + 1], d = spacing[Math.min(H - 1, r + 1) * W + c];
      if (!state[r * W + c] || !a) continue;
      if (b) assert.ok(Math.max(a, b) / Math.min(a, b) <= 2, `salto de nivel en ${c},${r}: ${a} / ${b}`);
      if (d) assert.ok(Math.max(a, d) / Math.min(a, d) <= 2, `salto de nivel en ${c},${r}: ${a} / ${d}`);
    }
  });
}

test('parches: más finos cerca de la cámara', () => {
  const { lod } = makeLod();
  lod.update(new THREE.Vector3(40, 6, 40), everything(), 0.01, 2.5);
  const { spacing } = coverage(lod);
  // la celda bajo la cámara (≈ 150, 145) tiene el espaciado más fino (1/8 de celda); la del extremo opuesto, mayor
  assert.equal(spacing[145 * W + 153], 1 / 8);
  assert.ok(spacing[20 * W + 150] > 1 / 8);
});
