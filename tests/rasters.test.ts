import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cssToRgba, paletteRow } from '../src/relieve/engine/rasters';
import { stateField } from '../src/relieve/worker/raster';

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
