import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitView, flight, isClear, readingSeconds, timeline, type PathEnv } from '../src/relieve/analyses/recorridos/path';
import type { View } from '../src/relieve/shared/enlaces';

/** Llano a 1 000 m con una sierra de 3 000 m norte-sur en lon −98.5 (10 km de ancho). */
const env: PathEnv = {
  elev: lon => (Math.abs(lon + 98.5) < 0.05 ? 3000 : 1000),
  inside: () => true,
  kx: 104.3, ky: 110.6, ex: 3,
};

test('vista: la cámara baja detrás de una sierra no ve su objetivo y fitView la inclina hasta verlo', () => {
  // objetivo al este de la sierra, cámara al oeste (rumbo −90°: la cámara queda hacia el oeste), muy inclinada
  const v: View = { lon: -98.35, lat: 20.5, dist: 0.3, polar: 78, az: -90 };
  assert.equal(isClear(env, v), false);
  const f = fitView(env, v);
  assert.ok(f.polar < v.polar);
  assert.ok(isClear(env, f));
  // desde el este no hay nada que tape
  assert.ok(isClear(env, { ...v, az: 90 }));
});

test('vuelo: empieza y termina en las paradas, no atraviesa la sierra y no da tirones', () => {
  const a = fitView(env, { lon: -98.75, lat: 20.5, dist: 0.25, polar: 70, az: -90 });
  const b = fitView(env, { lon: -98.3, lat: 20.55, dist: 0.2, polar: 72, az: -70 });
  const f = flight(env, a, b);
  for (const k of ['lon', 'lat', 'dist', 'polar', 'az'] as const) {
    assert.ok(Math.abs(f(0)[k] - a[k]) < 1e-9, `inicio ${k}`);
    assert.ok(Math.abs(f(1)[k] - b[k]) < 1e-9, `final ${k}`);
  }
  let clear = 0, maxJump = 0, prev = f(0);
  const n = 400;
  for (let i = 1; i <= n; i++) {
    const v = f(i / n);
    if (isClear(env, v)) clear++;
    maxJump = Math.max(maxJump, Math.abs(v.polar - prev.polar));
    prev = v;
  }
  assert.ok(clear >= n * 0.97, `con vista libre ${clear}/${n}`);
  assert.ok(maxJump < 2.5, `salto de inclinación ${maxJump.toFixed(2)}°`);
});

test('línea de tiempo: tramos seguidos, paradas en orden y vista continua', () => {
  const start: View = { lon: -98.9, lat: 20.4, dist: 1.5, polar: 50, az: 10 };
  const stops = [
    { view: { lon: -98.75, lat: 20.5, dist: 0.3, polar: 60, az: 20 }, hold: 8 },
    { view: { lon: -98.3, lat: 20.55, dist: 0.25, polar: 65, az: 40 }, hold: 6 },
  ];
  const tl = timeline(env, start, stops);
  assert.equal(tl.legs.length, 4);
  for (let i = 1; i < tl.legs.length; i++) assert.equal(tl.legs[i].t0, tl.legs[i - 1].t1);
  assert.equal(tl.total, tl.legs.at(-1)!.t1);
  assert.deepEqual(tl.legs.map(l => [l.kind, l.stop]), [['fly', 0], ['hold', 0], ['fly', 1], ['hold', 1]]);
  assert.ok(Math.abs(tl.at(0).view.lon - start.lon) < 1e-9);
  // en el cambio de tramo la vista no salta
  for (const L of tl.legs.slice(1)) {
    const a = tl.at(L.t0 - 1).view, b = tl.at(L.t0 + 1).view;
    assert.ok(Math.abs(a.lon - b.lon) < 1e-3 && Math.abs(a.dist - b.dist) < 1e-2 && Math.abs(a.az - b.az) < 0.5, `salto en ${L.kind} ${L.stop}`);
  }
  assert.equal(tl.at(tl.legs[1].t0 + 10).phase, 'hold');
  assert.equal(readingSeconds('uno dos tres'), 7);
});
