import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLD_Q, buildingGeometry, decodeBuildings, triangulate } from '../src/relieve/shared/buildings';

/** Tesela como la escribe build-edificios.mjs: u32 n · u8 vértices · u8 alturas · u16 primer vértice · i16 deltas. */
function encode(rings: [number, number][][], heights: number[], tx: number, ty: number, T = 16) {
  const ox = tx * T - 1, oz = ty * T - 1, n = rings.length;
  const q = rings.map(r => r.map(([x, z]) => [Math.round((x - ox) * BLD_Q), Math.round((z - oz) * BLD_Q)]));
  const rest: number[] = [];
  for (const r of q) for (let v = 1; v < r.length; v++) rest.push(r[v][0] - r[v - 1][0], r[v][1] - r[v - 1][1]);
  let o = 4 + 2 * n;
  o += o & 1;
  const buf = new Uint8Array(o + n * 4 + rest.length * 2), dv = new DataView(buf.buffer);
  dv.setUint32(0, n, true);
  q.forEach((r, b) => { buf[4 + b] = r.length; buf[4 + n + b] = Math.round(heights[b] * 4); dv.setUint16(o + b * 4, r[0][0], true); dv.setUint16(o + b * 4 + 2, r[0][1], true); });
  rest.forEach((d, k) => dv.setInt16(o + n * 4 + k * 2, d, true));
  return buf;
}

// en celdas de la rejilla (x este, z sur), sentido horario en (x, z): área con signo negativa
const square: [number, number][] = [[100.10, 200.10], [100.10, 200.14], [100.14, 200.14], [100.14, 200.10]];
const ell: [number, number][] = [[100.30, 200.30], [100.30, 200.36], [100.36, 200.36], [100.36, 200.33], [100.33, 200.33], [100.33, 200.30]];
const signedArea = (r: [number, number][]) => r.reduce((s, [x, z], i) => { const [x1, z1] = r[(i + 1) % r.length]; return s + x * z1 - x1 * z; }, 0) / 2;

test('edificios: la tesela se lee igual que se escribió', () => {
  assert.ok(signedArea(square) < 0 && signedArea(ell) < 0);
  const d = decodeBuildings(encode([square, ell], [6.5, 9], 6, 12), 6, 12, 16);
  assert.equal(d.n, 2);
  assert.deepEqual([...d.nv], [4, 6]);
  assert.deepEqual([...d.h], [26, 36]);
  const all = [...square, ...ell];
  all.forEach(([x, z], k) => { assert.ok(Math.abs(d.xz[k * 2] - x) < 1 / BLD_Q && Math.abs(d.xz[k * 2 + 1] - z) < 1 / BLD_Q, `vértice ${k}`); });
});

test('edificios: huella cóncava (L) en n − 2 triángulos que suman su área', () => {
  const xz = ell.flat(), out: number[] = [];
  triangulate(xz, 0, ell.length, 0, out);
  assert.equal(out.length, (ell.length - 2) * 3);
  let sum = 0;
  for (let t = 0; t < out.length; t += 3) {
    const [a, b, c] = [out[t], out[t + 1], out[t + 2]].map(i => ell[i]);
    const s = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    assert.ok(s < 0, 'conserva el sentido del anillo');
    sum += s;
  }
  assert.ok(Math.abs(sum - signedArea(ell)) < 1e-9);
});

/** Punto dentro del anillo (rayo hacia +x). */
const inside = (r: [number, number][], x: number, z: number) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};

test('edificios: techos hacia arriba y paredes hacia afuera (también en la esquina interior de la L)', () => {
  const rings = [square, ell];
  const g = buildingGeometry(decodeBuildings(encode(rings, [6, 6], 6, 12), 6, 12, 16));
  assert.equal(g.index.length / 3, (3 * 4 - 2) + (3 * 6 - 2));
  const P = (i: number) => [g.pos[i * 3], g.pos[i * 3 + 2] * 0.05, g.pos[i * 3 + 1]];   // (x, y, z) con el techo arriba
  for (let t = 0; t < g.index.length; t += 3) {
    const [a, b, c] = [g.index[t], g.index[t + 1], g.index[t + 2]].map(P);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (a[1] > 0 && b[1] > 0 && c[1] > 0) { assert.ok(n[1] > 0, `techo ${t / 3} hacia abajo`); continue; }
    assert.ok(Math.abs(n[1]) < 1e-12);
    // un poco por delante de la pared: fuera de la huella; un poco por detrás: dentro
    const ring = rings[g.index[t] < 8 ? 0 : 1], L = Math.hypot(n[0], n[2]), e = 1e-4;
    const mx = (a[0] + b[0] + c[0]) / 3, mz = (a[2] + b[2] + c[2]) / 3;
    assert.ok(!inside(ring, mx + (n[0] / L) * e, mz + (n[2] / L) * e), `pared ${t / 3} hacia adentro`);
    assert.ok(inside(ring, mx - (n[0] / L) * e, mz - (n[2] / L) * e), `pared ${t / 3}: detrás no hay edificio`);
  }
});
