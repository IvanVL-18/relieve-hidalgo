import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { gradientPlanes } from '../scripts/pipeline/dem.mjs';
import { decodeElev, decodeVec } from '../src/relieve/worker/decode';
import meta from '../src/relieve/data/meta.json' with { type: 'json' };

const data = (name: string) => zlib.gunzipSync(fs.readFileSync(new URL(`../src/relieve/data/${name}`, import.meta.url)));

test('predictor de gradiente: el visor recupera exactamente lo que escribe la cadena de datos', () => {
  const w = 37, h = 23, v = new Int32Array(w * h);
  let s = 7;
  for (let i = 0; i < v.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; v[i] = 1500 + Math.round(Math.sin(i / 9) * 900) + (s % 300) - 150; }
  v[5] = 0; v[40] = 3379;
  assert.deepEqual(Array.from(decodeElev(gradientPlanes(v, w, h), w, h)), Array.from(v));
});

test('elev.bin: rejilla del visor; dentro del estado, el promedio de 270 m no rebasa los extremos medidos a 30 m', () => {
  const e = decodeElev(data('elev.bin'), meta.W, meta.H), muni = data('muni.bin');
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < e.length; i++) if (muni[i]) { min = Math.min(min, e[i]); max = Math.max(max, e[i]); }
  assert.equal(e.length, meta.W * meta.H);
  // fuera del estado la rejilla llega al volcán Jocotitlán (≈ 3 900 m, Estado de México)
  assert.ok(min >= meta.relief.min && max <= meta.relief.max && max > 3200, `min ${min}, max ${max}`);
});

test('vec.bin (versión 3): ríos, presas, límites, contorno y luces', () => {
  const v = decodeVec(data('vec.bin'));
  assert.equal(v.rivers.len.length, 1274);
  assert.equal(v.rivers.acc.length, v.rivers.x.length);
  assert.ok(v.borders.len.length > 100);
  assert.ok(v.outline && v.outline.len.length >= 1);
  assert.ok(v.lights && v.lights.pop.length > 4600);
  // todo dentro de la rejilla
  for (const L of [v.rivers, v.borders, v.outline!]) for (let k = 0; k < L.x.length; k++) {
    assert.ok(L.x[k] >= -1 && L.x[k] <= meta.W && L.y[k] >= -1 && L.y[k] <= meta.H);
  }
});
