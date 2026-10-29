import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { decodeElev } from '../src/relieve/worker/decode';
import meta from '../src/relieve/data/meta.json' with { type: 'json' };
import { CLOUD_KINDS, SKY_PRESETS, buildWeather, humidityOf, skyFor, windName, windVector, withAmount, type SkyParams } from '../src/relieve/shared/clouds';
import { makeGeo } from '../src/relieve/shared/geo';

const data = (name: string) => new Uint8Array(zlib.gunzipSync(fs.readFileSync(new URL(`../src/relieve/data/${name}`, import.meta.url))));
const KEYS = Object.keys(SKY_PRESETS.cumulos) as (keyof SkyParams)[];

test('cielo automático: continuo a lo largo del día, con niebla al amanecer y tormentas por la tarde', () => {
  let prev = skyFor('auto', 5).params;
  for (let h = 5.05; h <= 20.5; h += 0.05) {
    const p = skyFor('auto', h).params;
    for (const k of KEYS) assert.ok(Math.abs(p[k] - prev[k]) < 0.1 * Math.max(1, Math.abs(prev[k])), `salto en ${k} a las ${h.toFixed(2)} h`);
    prev = p;
  }
  assert.ok(skyFor('auto', 7).params.fog > 0.9, 'niebla al amanecer');
  assert.equal(skyFor('auto', 13).params.fog, 0, 'sin niebla a mediodía');
  assert.ok(skyFor('auto', 18).params.storm > skyFor('auto', 14).params.storm, 'más tormentas por la tarde');
  // fuera del rango del deslizador se queda en los extremos
  assert.deepEqual(skyFor('auto', 3).params, skyFor('auto', 5).params);
  // cada tipo tiene su descripción corta y los fijos no dependen de la hora
  for (const k of CLOUD_KINDS) assert.ok(skyFor(k.id, 12).text.length > 0 && skyFor(k.id, 12).text.length <= 45, `nota de ${k.id}`);
  assert.deepEqual(skyFor('tormenta', 6).params, skyFor('tormenta', 19).params);
});

test('cantidad: 0 quita las nubes, 0.5 deja el tipo como está y 1 las aumenta sin pasar de 1', () => {
  for (const p of Object.values(SKY_PRESETS)) {
    const none = withAmount(p, 0), same = withAmount(p, 0.5), more = withAmount(p, 1);
    assert.equal(none.cover + none.storm + none.fog, 0);
    for (const k of KEYS) assert.ok(Math.abs(same[k] - p[k]) < 1e-9, k);
    for (const k of ['cover', 'storm', 'fog'] as const) assert.ok(more[k] >= p[k] && more[k] <= 1, k);
  }
});

test('viento: nombre de donde viene y hacia dónde avanzan las nubes (x al este, z al sur)', () => {
  assert.equal(windName(0), 'del norte');
  assert.equal(windName(45), 'del noreste');
  assert.equal(windName(70), 'del este');
  assert.equal(windName(-90), 'del oeste');
  const [ex, ez] = windVector(90), [nx, nz] = windVector(0);
  assert.ok(ex < -0.99 && Math.abs(ez) < 1e-9, 'viento del este: hacia el oeste');
  assert.ok(nz > 0.99 && Math.abs(nx) < 1e-9, 'viento del norte: hacia el sur');
});

test('clima sintético: máscara del estado, humedad según la lluvia y fondo de los valles', () => {
  const W = 161, H = 121, elev = new Float32Array(W * H), muni = new Uint8Array(W * H), rain = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c;
    // un valle norte-sur en la columna 80 y una pendiente hacia el este
    elev[i] = 1000 + c * 5 + Math.min(600, Math.abs(c - 80) * 40);
    muni[i] = c > 15 && c < 145 && r > 15 && r < 105 ? 1 : 0;
    rain[i] = Math.round((400 + c * 12) / 20);
  }
  const g = buildWeather(elev, muni, W, H, 0.27, rain, 4, 6);
  const at = (c: number, r: number, k: number) => g.data[((r / 4 + g.m) * g.w + (c / 4 + g.m)) * 4 + k] / 255;
  assert.ok(at(80, 60, 0) > 0.95, 'dentro del estado');
  assert.ok(at(0, 0, 0) < 0.05 && g.data[0] === 0, 'fuera del estado y en el margen');
  assert.ok(at(128, 60, 1) > at(32, 60, 1) + 0.3, 'más humedad al este, donde llueve más');
  // el fondo del valle queda por debajo del relieve suavizado de la región
  assert.ok(at(80, 60, 3) < at(80, 60, 2) - 0.02, 'fondo del valle bajo el relieve suavizado');
  assert.ok(g.slope > 0 && g.maxSmooth > 1 && g.maxSmooth < 2.5, `pendiente ${g.slope}, máximo ${g.maxSmooth}`);
  // sin lluvia, humedad pareja
  assert.equal(buildWeather(elev, muni, W, H, 0.27, null, 4, 6).data[(20 * g.w + 20) * 4 + 1], 128);
  assert.ok(humidityOf(450) === 0 && humidityOf(2300) === 1 && humidityOf(1300) > 0.4 && humidityOf(1300) < 0.6);
});

test('clima real: llueve más en la Huasteca que en el Mezquital, y las nubes se reparten así', () => {
  const W = meta.W, H = meta.H, geo = makeGeo(meta);
  const elev = decodeElev(data('elev.bin'), W, H), muni = data('muni.bin'), lluvia = data('capas/lluvia.bin');
  const dv = new DataView(lluvia.buffer, lluvia.byteOffset);
  assert.equal(dv.getUint32(0, true), 0x31555248);
  assert.deepEqual([dv.getUint32(4, true), dv.getUint32(8, true)], [W, H]);
  const rain = lluvia.subarray(12);
  let missing = 0;
  for (let i = 0; i < W * H; i++) if (muni[i] && !rain[i]) missing++;
  assert.equal(missing, 0, 'todo el estado tiene lluvia media anual');
  const mm = (lon: number, lat: number) => rain[Math.round(geo.rowOf(lat)) * W + Math.round(geo.colOf(lon))] * 20;
  const huejutla = mm(-98.42, 21.14), ixmiquilpan = mm(-99.22, 20.48);
  assert.ok(huejutla > 1200 && ixmiquilpan < 600, `Huejutla ${huejutla} mm, Ixmiquilpan ${ixmiquilpan} mm`);
  const g = buildWeather(elev, muni, W, H, (meta.step * (geo.KX + geo.KZ)) / 2, rain);
  const hum = (lon: number, lat: number) => g.data[((Math.round(geo.rowOf(lat) / g.f) + g.m) * g.w + Math.round(geo.colOf(lon) / g.f) + g.m) * 4 + 1] / 255;
  // la sierra (Tlanchinol, ≈ 2 500 mm) es lo más húmedo; luego la Huasteca (Huejutla) y al final el Mezquital
  const sierra = hum(-98.66, 20.99), huasteca = hum(-98.42, 21.14), mezquital = hum(-99.22, 20.48);
  assert.ok(sierra > 0.8 && huasteca > 0.35 && mezquital < 0.1 && sierra > huasteca, `humedad ${sierra}, ${huasteca} y ${mezquital}`);
  // la base de los cúmulos sigue al relieve: más alta en el altiplano que en la Huasteca
  const base = (lon: number, lat: number) => g.data[((Math.round(geo.rowOf(lat) / g.f) + g.m) * g.w + Math.round(geo.colOf(lon) / g.f) + g.m) * 4 + 2] / 255 * 3500;
  assert.ok(base(-98.75, 20.0) > base(-98.42, 21.14) + 1200, `relieve suavizado ${base(-98.75, 20.0)} m y ${base(-98.42, 21.14)} m`);
});
