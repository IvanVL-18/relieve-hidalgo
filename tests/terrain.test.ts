import assert from 'node:assert/strict';
import { test } from 'node:test';
import { D8, downstreamPath, floodLevels, flowAccumulation, hornNormals, longestFlowPath, maskOutline, slopeGrid, snapToStream, upstreamMask } from '../src/relieve/shared/terrain';

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

test('cauce principal: el camino de flujo más largo llega desde la cabecera más lejana', () => {
  const { z, w, h, mid } = valley(), dir = d8(z, w, h);
  const outlet = (h - 1) * w + mid, { path, km } = longestFlowPath(dir, w, h, outlet, 1, 1);
  // termina en la salida, cada paso sigue el flujo y empieza en la fila más alta (la más lejana)
  assert.equal(path[path.length - 1], outlet);
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], d = dir[a];
    assert.equal(path[k], (Math.floor(a / w) + D8[d][0]) * w + (a % w) + D8[d][1]);
  }
  assert.equal(Math.floor(path[0] / w), 0);
  // la longitud es la suma de los pasos (1 recto, √2 en diagonal) y ningún otro camino es más largo
  const step = (d: number) => (Math.abs(d) === w || Math.abs(d) === 1 ? 1 : Math.SQRT2);
  let sum = 0;
  for (let k = 1; k < path.length; k++) sum += step(path[k] - path[k - 1]);
  assert.ok(Math.abs(sum - km) < 1e-4);
  const { mask } = upstreamMask(dir, w, h, outlet);
  for (let i = 0; i < w * h; i++) if (mask[i]) {
    const p = downstreamPath(dir, w, h, i);
    let L = 0;
    for (let k = 1; k < p.length && p[k - 1] !== outlet; k++) L += step(p[k] - p[k - 1]);
    assert.ok(L <= km + 1e-4);
  }
});

test('contorno de una máscara: anillos cerrados por los puntos medios, con huecos y diagonales unidas', () => {
  // cuadro de 3 × 3 con un hueco al centro: un anillo afuera y otro adentro
  const w = 5, h = 5, mask = new Uint8Array(w * h);
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) if (r !== 2 || c !== 2) mask[r * w + c] = 1;
  const rings = maskOutline(mask, w, h);
  assert.equal(rings.length, 2);
  for (const g of rings) assert.deepEqual(g[0], g[g.length - 1]);
  // todos los puntos quedan a media celda de un nodo de dentro y de uno de fuera
  for (const g of rings) for (const [x, y] of g) {
    const a = [Math.floor(x), Math.floor(y)], b = [Math.ceil(x), Math.ceil(y)];
    const v = (p: number[]) => (p[0] >= 0 && p[1] >= 0 && p[0] < w && p[1] < h ? mask[p[1] * w + p[0]] : 0);
    assert.notEqual(v(a), v(b));
  }
  // la orilla de la rejilla cuenta como fuera, y dos nodos en diagonal forman una sola figura
  const d = new Uint8Array(4);
  d[0] = 1; d[3] = 1;
  assert.equal(maskOutline(d, 2, 2).length, 1);
  assert.equal(maskOutline(new Uint8Array(4).fill(1), 2, 2).length, 1);
});

test('inundación: cada celda se inunda al nivel del paso más bajo desde el punto', () => {
  // dos hoyas separadas por un bordo de 105 m; el punto en el fondo de la izquierda (100 m)
  const w = 21, h = 9, z = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = c === 10 ? 105 : 100 + Math.abs(c - (c < 10 ? 5 : 15)) * 0.5 + Math.abs(r - 4) * 0.5;
  const seed = 4 * w + 5, f = floodLevels(z, w, h, seed, 20);
  assert.equal(f.level[seed], 100);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const L = f.level[r * w + c];
    // de su lado, cada celda se inunda justo a su altura (la hoya se llena de abajo arriba)
    if (c < 10) assert.ok(Math.abs(L - z[r * w + c]) < 1e-6);
    // del otro lado, nada se inunda antes de rebasar el bordo
    else assert.ok(L >= 105 - 1e-6);
  }
  // la orilla de la rejilla se toca primero en (0, 5), a 102 m
  assert.ok(Math.abs(f.edgeLevel - 102) < 1e-6);
  // con un tope por debajo del bordo, la otra hoya no se alcanza
  const g = floodLevels(z, w, h, seed, 4);
  for (let r = 0; r < h; r++) for (let c = 10; c < w; c++) assert.ok(Number.isNaN(g.level[r * w + c]));
  assert.ok(g.box[3] <= 9);
});
