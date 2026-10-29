import assert from 'node:assert/strict';
import { test } from 'node:test';
import { D8, downstreamPath, flowAccumulation, hornNormals, slopeGrid, snapToStream, upstreamMask } from '../src/relieve/shared/terrain';

/** Dirección D8 hacia el vecino más bajo (o −1 si es mínimo local) de una rejilla de alturas. */
function d8(z: Float32Array, w: number, h: number) {
  const dir = new Int8Array(w * h).fill(-1);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    let best = 0, bk = -1;
    for (let k = 0; k < 8; k++) {
      const rr = r + D8[k][0], cc = c + D8[k][1];
      if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      const drop = (z[r * w + c] - z[rr * w + cc]) / Math.hypot(D8[k][0], D8[k][1]);
      if (drop > best) { best = drop; bk = k; }
    }
    dir[r * w + c] = bk;
  }
  return dir;
}

/** Valle en V que desagua hacia el sur por la columna central. */
function valley(w = 21, h = 15) {
  const z = new Float32Array(w * h), mid = (w - 1) / 2;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = 100 + Math.abs(c - mid) * 10 + (h - r) * 2;
  return { z, w, h, mid };
}

test('acumulación: el cauce del valle junta todas las celdas', () => {
  const { z, w, h, mid } = valley(), dir = d8(z, w, h), acc = flowAccumulation(dir, w, h);
  const outlet = (h - 1) * w + mid;
  // la salida del valle (fila de abajo, al centro) recibe más que cualquier otra celda
  assert.equal(acc.indexOf(Math.max(...acc)), outlet);
  // ninguna celda recibe más de lo que hay
  assert.ok(Math.max(...acc) <= w * h);
});

test('cuenca: desde la salida, toda la parte que drena a ella; el clic se ajusta al cauce', () => {
  const { z, w, h, mid } = valley(), dir = d8(z, w, h), acc = flowAccumulation(dir, w, h);
  const outlet = (h - 1) * w + mid;
  const { mask, cells, edge } = upstreamMask(dir, w, h, outlet);
  assert.equal(cells, acc[outlet]);
  assert.equal(mask.reduce((s, v) => s + v, 0), cells);
  assert.ok(edge);
  // un clic a dos celdas del cauce termina sobre él
  assert.equal(snapToStream(acc, w, h, (h - 3) * w + mid + 2, 3) % w, mid);
});

test('camino del agua: baja hasta salir y nunca sube', () => {
  const { z, w, h } = valley(), dir = d8(z, w, h);
  const path = downstreamPath(dir, w, h, 2 * w + 1);
  for (let k = 1; k < path.length; k++) assert.ok(z[path[k]] < z[path[k - 1]]);
  assert.equal(Math.floor(path[path.length - 1] / w), h - 1);
});

test('pendiente y orientación de un plano inclinado', () => {
  const w = 5, h = 5, dx = 30, z = new Float32Array(w * h);
  // sube 30 m por cada 30 m hacia el este: 45°, mirando al oeste (270°)
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = 1000 + c * 30;
  const s = slopeGrid(z, w, h, dx, dx, 'pendiente'), o = slopeGrid(z, w, h, dx, dx, 'orientacion');
  assert.ok(Math.abs(s[12] - 45) < 1e-6);
  assert.ok(Math.abs(o[12] - 270) < 1e-6);
});

test('normales de Horn: plano a 45° y sin dato tratado como el centro', () => {
  const w = 4, h = 3, z = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = 500 + c * 90;
  const n = hornNormals(z, w, h, 90, 90, new Float32Array((w - 2) * (h - 2) * 2));
  assert.ok(Math.abs(n[0] + Math.SQRT1_2) < 1e-6 && Math.abs(n[1]) < 1e-6);
  z[0] = 0;   // sin dato: no debe dar NaN
  assert.ok(hornNormals(z, w, h, 90, 90, new Float32Array(4)).every(Number.isFinite));
});
