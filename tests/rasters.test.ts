import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cssToRgba, paletteRow } from '../src/relieve/engine/rasters';
import type { Lines, VecData } from '../src/relieve/worker/decode';
import { lineField, stateField } from '../src/relieve/worker/raster';

test('colores CSS a RGBA sRGB', () => {
  assert.deepEqual(cssToRgba('#4fc3f7'), [0x4f, 0xc3, 0xf7, 255]);
  assert.deepEqual(cssToRgba('#fff'), [255, 255, 255, 255]);
  assert.deepEqual(cssToRgba('#11223380'), [0x11, 0x22, 0x33, 0x80]);
  assert.deepEqual(cssToRgba('rgba(10, 20, 30, 0.5)'), [10, 20, 30, 128]);
  assert.deepEqual(cssToRgba(null), [0, 0, 0, 0]);
  assert.deepEqual(cssToRgba('transparent'), [0, 0, 0, 0]);
});

test('paleta continua: extremos exactos e interpolación en sRGB', () => {
  const row = paletteRow(['#000000', '#ffffff'], 'continuous');
  assert.deepEqual(Array.from(row.subarray(0, 4)), [0, 0, 0, 255]);
  assert.deepEqual(Array.from(row.subarray(255 * 4, 256 * 4)), [255, 255, 255, 255]);
  assert.equal(row[128 * 4], 128);
});

test('paleta por clases: un color por valor; null = transparente', () => {
  const row = paletteRow([null, '#ff0000', '#00ff00'], 'categorical');
  assert.equal(row[3], 0);
  assert.deepEqual(Array.from(row.subarray(4, 8)), [255, 0, 0, 255]);
  assert.deepEqual(Array.from(row.subarray(8, 12)), [0, 255, 0, 255]);
  assert.equal(row[3 * 4 + 3], 0);
});

test('líneas finas: la distancia con signo se reconstruye exacta entre texeles (como en el sombreador)', () => {
  // un río casi horizontal que corre justo entre dos filas de texeles (el caso en que se cortaba de cerca) y un límite
  // diagonal; 64 × 64 texeles = 64 × 64 celdas
  const size = 64, range = 10;
  const line = (pts: number[][]): Lines => ({ start: Uint32Array.of(0), len: Uint32Array.of(pts.length), x: Float32Array.from(pts, p => p[0]), y: Float32Array.from(pts, p => p[1]) });
  const none: Lines = { start: new Uint32Array(0), len: new Uint32Array(0), x: new Float32Array(0), y: new Float32Array(0) };
  const river = [[4, 30], [60, 31]], border = [[5, 5], [58, 50]];
  const v: VecData = { rivers: { ...line(river), acc: Uint8Array.of(40, 40) }, borders: line(border), lakes: { outer: new Uint32Array(0), inner: new Uint32Array(0), rings: none }, outline: null, lights: null };
  const f = lineField(v, size + 1, size + 1, size, range);
  // mismo cálculo que rhLineS / rhLineDist en materials.ts
  const S = (x: number, y: number, ch: number) => {
    const q = (f[(Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))) * 4 + ch] - 128) / 127;
    return Math.sign(q) * q * q * range;
  };
  const dist = (x: number, y: number, ch: number) => {
    const tx = x - 0.5, ty = y - 0.5, i = Math.floor(tx), j = Math.floor(ty), fx = tx - i, fy = ty - j;
    const [a, b, c, d] = [S(i, j, ch), S(i + 1, j, ch), S(i, j + 1, ch), S(i + 1, j + 1, ch)];
    const lerp = (p: number, q: number, t: number) => p + (q - p) * t;
    const s = lerp(lerp(a, b, fx), lerp(c, d, fx), fy), u = lerp(lerp(Math.abs(a), Math.abs(b), fx), lerp(Math.abs(c), Math.abs(d), fx), fy);
    return Math.min(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d)) >= 0.75 ? u : Math.abs(s);
  };
  const exact = (x: number, y: number, [[ax, ay], [bx, by]]: number[][]) => {
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  };
  let worst = 0;
  for (let k = 0; k < 4000; k++) {
    const t = 0.05 + 0.9 * ((k * 0.618034) % 1), off = ((k * 0.414214) % 1) * 3 - 1.5;
    for (const [pts, ch] of [[river, 0], [border, 1]] as const) {
      const [[ax, ay], [bx, by]] = pts, len = Math.hypot(bx - ax, by - ay);
      const x = ax + (bx - ax) * t - ((by - ay) / len) * off, y = ay + (by - ay) * t + ((bx - ax) / len) * off;
      worst = Math.max(worst, Math.abs(dist(x, y, ch) - exact(x, y, pts as number[][])));
    }
  }
  // sin signo el error llegaba a medio texel sobre la línea; ahora es de centésimas (texel ≈ 50 m → < 1.5 m)
  assert.ok(worst < 0.03, `error máximo ${worst.toFixed(4)} texeles`);
  // lejos de las líneas, el campo dice «nada»
  assert.ok(dist(60, 5, 0) > 9 && dist(60, 5, 1) > 9);
});

test('recorte del terreno: distancia con signo a un contorno cuadrado', () => {
  // cuadrado de 10 × 10 celdas en una rejilla de 20 × 20 celdas con f = 2 (41 × 41 nodos)
  const ring = [[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]];
  const L = { start: Uint32Array.of(0), len: Uint32Array.of(ring.length), x: Float32Array.from(ring, p => p[0]), y: Float32Array.from(ring, p => p[1]) };
  const w = 41, h = 41, sdf = stateField(L, w, h, 2, 4);
  const at = (c: number, r: number) => sdf[r * w + c];
  assert.equal(at(20, 20), 1);      // dentro, lejos de la orilla
  assert.equal(at(1, 1), 255);      // fuera, lejos
  assert.equal(at(10, 20), 128);    // sobre la orilla (x = 5 celdas = nodo 10)
  assert.ok(at(11, 20) < 128 && at(9, 20) > 128);
  // cada nodo de distancia vale 127 / 4 (simétrico)
  assert.equal(128 - at(12, 20), at(8, 20) - 128);
});
