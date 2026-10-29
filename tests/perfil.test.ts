import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decimate, niceTicks, profileCsv, profileStats, sampleAt, verticalExaggeration } from '../src/relieve/analyses/perfil/profile';
import type { Profile } from '../src/relieve/shared/terrain';

/** Perfil sintético con muestras cada 30 m. */
function make(elev: (km: number) => number, km: number): Profile {
  const n = Math.round((km * 1000) / 30) + 1, p = { km: new Float32Array(n), elev: new Float32Array(n), lon: new Float32Array(n), lat: new Float32Array(n) };
  for (let i = 0; i < n; i++) { p.km[i] = (km * i) / (n - 1); p.elev[i] = elev(p.km[i]); p.lon[i] = -99 + i * 1e-4; p.lat[i] = 20.5; }
  return p;
}

test('perfil: subida, bajada, pendientes y punto más alto de una loma', () => {
  // sube 240 m en 3 km (8 %) y baja 240 m en 3 km
  const st = profileStats(make(k => 2000 + 80 * (k <= 3 ? k : 6 - k), 6));
  assert.ok(Math.abs(st.km - 6) < 1e-4);
  // en la cima se pierden hasta ~3 m del umbral y ~3 m del suavizado
  assert.ok(Math.abs(st.up - 240) < 7 && Math.abs(st.down - 240) < 7, `subida ${st.up}, bajada ${st.down}`);
  assert.ok(Math.abs(st.max - 2240) < 1 && Math.abs(st.km - 6) < 1e-3);
  assert.ok(Math.abs(st.meanSlope - 8) < 0.5, `media ${st.meanSlope}`);
  assert.ok(Math.abs(st.maxSlope - 8) < 0.5);
  // todo el trazo en la clase 5–10 % salvo la cima, donde se suaviza
  assert.ok(st.classKm[1] > 5.7, `km por clase ${st.classKm}`);
  assert.equal(st.start, 2000);
  assert.ok(Math.abs(st.end - 2000) < 0.01);
});

test('perfil: el ruido del relieve no suma subida', () => {
  // plano con ±1.5 m de ruido: sin umbral sumaría ~100 m por km
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 3;
  const st = profileStats(make(() => 1500 + rnd(), 10));
  assert.ok(st.up < 15 && st.down < 15, `subida ${st.up}`);
  assert.ok(st.meanSlope < 3, `media ${st.meanSlope}`);
});

test('perfil: huecos sin dato', () => {
  const p = make(k => 1000 + 10 * k, 3);
  for (let i = 40; i < 50; i++) p.elev[i] = NaN;   // hueco interno: se interpola
  for (let i = 0; i < 5; i++) p.elev[i] = NaN;     // fuera de la zona al principio
  const st = profileStats(p);
  assert.ok(Math.abs(st.elev[45] - (1000 + 10 * p.km[45])) < 0.01);
  assert.ok(Number.isNaN(st.elev[0]) && st.valid < 1 && st.valid > 0.8);
  assert.ok(Math.abs(st.start - (1000 + 10 * p.km[5])) < 0.01);
  const csv = profileCsv(p, st).split('\r\n');
  assert.equal(csv[0], '﻿km,longitud,latitud,elevacion_m,pendiente_pct');
  assert.match(csv[1], /^0\.000,-99\.000000,20\.500000,,$/);
  assert.equal(csv.length, p.km.length + 2);
});

test('perfil: muestras a dibujar, marcas de los ejes y cercanía', () => {
  const z = Array.from({ length: 10000 }, (_, i) => Math.sin(i / 300) * 100 + (i === 5000 ? 900 : 0));
  const idx = decimate(z, 600);
  assert.ok(idx.length <= 602 && idx[0] === 0 && idx[idx.length - 1] === 9999);
  assert.ok(idx.includes(5000), 'conserva el pico de una sola muestra');
  for (let k = 1; k < idx.length; k++) assert.ok(idx[k] > idx[k - 1]);
  assert.deepEqual(niceTicks(1830, 2410, 4).ticks, [1800, 2000, 2200, 2400, 2600]);
  assert.deepEqual(niceTicks(0, 6.3, 4).ticks, [0, 2, 4, 6, 8]);
  assert.equal(sampleAt(Float32Array.of(0, 1, 2, 3), 1.4), 1);
  assert.equal(sampleAt(Float32Array.of(0, 1, 2, 3), 9), 3);
  // 1 m vertical por píxel contra 1 km horizontal por cada 100 px → ×10
  assert.ok(Math.abs(verticalExaggeration(100, 100, 1, 100) - 10) < 1e-9);
});
