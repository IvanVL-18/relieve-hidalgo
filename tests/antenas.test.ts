import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EARTH_R, losLift, viewshedRays } from '../src/relieve/shared/terrain';

const KR = (4 / 3) * EARTH_R;
const FLAT = 1e15;

test('zona visible: en un llano curvo el horizonte de radio queda donde dice la fórmula', () => {
  // 90 m entre nodos, antena de 30 m y receptor de 1.5 m: horizonte = √(2kR·30) + √(2kR·1.5) ≈ 27.6 km
  const n = 801, mid = 400, d = 90, z = new Float32Array(n * n).fill(100), out = new Uint8Array(n * n);
  viewshedRays(z, n, n, mid, mid, 130, 1.5, d, d, 35000, KR, out, 1);
  const horizon = Math.sqrt(2 * KR * 30) + Math.sqrt(2 * KR * 1.5);
  // último nodo visible hacia el este y hacia el norte
  for (const [dc, dr] of [[1, 0], [0, -1]]) {
    let last = 0;
    for (let k = 1; k < 390; k++) if (out[(mid + dr * k) * n + mid + dc * k] & 1) last = k;
    assert.ok(Math.abs(last * d - horizon) <= d, `horizonte ${last * d} m, esperado ${horizon.toFixed(0)} m`);
  }
  // el círculo de 35 km queda marcado y nada fuera de él
  assert.ok(out[mid * n + mid + 388] & 128);
  assert.equal(out[(mid + 300) * n + mid + 300], 0);
  // sin curvatura todo el círculo se ve
  const flat = new Uint8Array(n * n);
  viewshedRays(z, n, n, mid, mid, 130, 1.5, d, d, 35000, FLAT, flat, 1);
  assert.ok(flat[mid * n + mid + 388] & 1);
});

test('línea de vista: la altura que le falta a la antena coincide con la fórmula del horizonte', () => {
  const n = 801, mid = 400, d = 90, z = new Float32Array(n * n).fill(100);
  const at = (km: number) => losLift(z, n, n, mid, mid, 130, mid + (km * 1000) / d, mid, 1.5, d, d, KR);
  assert.ok(at(20) <= 0);
  assert.ok(at(27) <= 0);
  // a 32 km la antena debería medir (32 000 − √(2kR·1.5))² / 2kR
  const need = (32000 - Math.sqrt(2 * KR * 1.5)) ** 2 / (2 * KR);
  assert.ok(Math.abs(at(32) - (need - 30)) < 0.3, `faltan ${at(32).toFixed(2)} m, esperado ${(need - 30).toFixed(2)}`);
});

test('zona visible: una cresta tapa lo de atrás; dos torres se marcan cada una con su bit', () => {
  const w = 161, h = 41, z = new Float32Array(w * h).fill(100);
  for (let r = 0; r < h; r++) z[r * w + 60] = 300;   // cresta norte-sur en la columna 60
  const out = new Uint8Array(w * h);
  viewshedRays(z, w, h, 20, 20, 110, 1.5, 30, 30, 5000, FLAT, out, 1);
  assert.ok(out[20 * w + 50] & 1, 'antes de la cresta se ve');
  assert.ok(out[20 * w + 60] & 1, 'la cresta se ve');
  assert.equal(out[20 * w + 100] & 1, 0, 'detrás de la cresta no');
  // la torre B, detrás de la cresta, ve su lado
  viewshedRays(z, w, h, 140, 20, 110, 1.5, 30, 30, 5000, FLAT, out, 2);
  assert.equal(out[20 * w + 100] & 3, 2);
  assert.equal(out[20 * w + 50] & 3, 1);
  // antena necesaria para ver por encima de la cresta un punto a 80 nodos: (300 − 101.5·½) / ½ = 498.5 m
  const lift = losLift(z, w, h, 20, 20, 110, 100, 20, 1.5, 30, 30, FLAT);
  assert.ok(Math.abs(lift - (498.5 - 110)) < 0.01, `faltan ${lift}`);
});
