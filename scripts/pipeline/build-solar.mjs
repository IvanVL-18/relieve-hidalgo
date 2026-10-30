#!/usr/bin/env node
/**
 * Potencial solar: radiación anual que recibe el terreno a ≈ 90 m (nodos de la rejilla de factor 3, como relieve-90m),
 * con el modelo de src/relieve/shared/solar.ts:
 *   1. relieve de 90 m de todo el rectángulo (promedio 3 × 3 del de 30 m): los horizontes ven también los cerros de
 *      los estados vecinos
 *   2. horizonte en 16 direcciones, por barrido con la envolvente convexa (sin límite de distancia), en bytes de 0.5°
 *   3. clima: global y difusa del año del Global Solar Atlas (9″, alineado a la rejilla del visor) suavizadas ~5 km (el
 *      Atlas ya resta la sombra del relieve; suavizado queda el clima de la región y no se cuenta dos veces) en una
 *      rejilla de 0.025°, repartidas en los meses con la climatología de NASA POWER (celdas de 1°)
 *   4. en cada nodo hasta ~3 km del estado: pendiente y orientación (Horn), factor de vista del cielo y radiación de cada
 *      mes
 * Salidas:
 *   capas/solar.bin   RHE1: u32 firma · w · h · f · u8 por nodo ((kWh/m²·año − 500) / 8; 0 = sin dato), gzip
 *   capas/solar.json  clima (rejillas del año y de los meses), cuantización y cifras por municipio
 *   out/solar_municipios.json   para la base de datos
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Unzip, UnzipInflate } from 'fflate';
import { CACHE, GRID, H, LAYERS, OUT, ROOT, W, kb, log, writeGz, writeJSON } from './lib.mjs';
import { SOURCES } from './sources.mjs';
import { DETAIL, FINE, boxDown, loadFine, sub } from './dem.mjs';
import {
  HORIZON_DIRS, MONTH_DAYS, SOLAR_Q, byteToH, byteToSolar, climateAt, dirAzimuths, dirWeights, hToByte, horizonSweep, irradiation, skyView, slopeAspect, solarToByte, sunTable,
} from '../../src/relieve/shared/solar.ts';

const t0 = Date.now(), lap = msg => log(`${msg} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

/* reparto en los meses: NASA POWER (cada mes ÷ media del año, por celda de 1°) */
const MONTH_KEYS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const power = p => {
  const f = path.join(CACHE, SOURCES.solar.file.replace('{p}', p));
  if (!fs.existsSync(f)) throw new Error(`Falta ${path.relative(CACHE, f)}. Corre npm run data:fetch solar`);
  return new Map(JSON.parse(fs.readFileSync(f, 'utf8')).features.map(x => [x.geometry.coordinates.slice(0, 2).join(','), MONTH_KEYS.map(k => x.properties.parameter[p][k])]));
};
const ghiP = power('ALLSKY_SFC_SW_DWN'), dhiP = power('ALLSKY_SFC_SW_DIFF');
const keys = [...ghiP.keys()].map(k => k.split(',').map(Number));
const lons = [...new Set(keys.map(k => k[0]))].sort((a, b) => a - b), lats = [...new Set(keys.map(k => k[1]))].sort((a, b) => b - a);
const shape = map => lats.flatMap(la => lons.map(lo => {
  const v = map.get(`${lo},${la}`);
  if (!v || v.some(x => !(x >= 0))) throw new Error(`NASA POWER sin dato en ${lo}, ${la}`);
  const year = v.reduce((s, x, m) => s + x * MONTH_DAYS[m], 0) / 365;
  return v.map(x => +(x / year).toFixed(4));
}));
const meses = { lon0: lons[0], lat0: lats[0], step: lons[1] - lons[0], nx: lons.length, ny: lats.length, ghi: shape(ghiP), dhi: shape(dhiP) };

/**
 * Lee de una sola pasada por el zip las filas r0–r1 y columnas c0–c1 de rejillas ASCII de ESRI (sin descomprimir todo:
 * cada archivo de México mide ~500 MB en texto).
 */
async function readAsc(zipFile, names, r0, r1, c0, c1) {
  const w = c1 - c0 + 1, out = {}, left = new Set(names);
  await new Promise((resolve, reject) => {
    const uz = new Unzip(file => {
      const name = names.find(n => file.name.endsWith('/' + n));
      if (!name) return;
      const grid = (out[name] = new Float32Array((r1 - r0 + 1) * w).fill(NaN)), dec = new TextDecoder();
      let row = -6, carry = '';
      file.ondata = (err, chunk, final) => {
        if (err) return reject(err);
        if (!left.has(name)) return;
        const lines = (carry + dec.decode(chunk, { stream: !final })).split('\n');
        carry = final ? '' : lines.pop();
        for (const line of lines) {
          if (row >= r0) {
            const v = line.trim().split(/\s+/);
            for (let c = c0; c <= c1; c++) grid[(row - r0) * w + c - c0] = parseFloat(v[c]);
          }
          if (++row > r1) { left.delete(name); break; }
        }
        if (!left.size) resolve();
      };
      file.start();
    });
    uz.register(UnzipInflate);
    const s = fs.createReadStream(zipFile, { highWaterMark: 1 << 20 });
    s.on('data', b => { if (left.size) uz.push(new Uint8Array(b.buffer, b.byteOffset, b.length)); else s.destroy(); });
    s.on('end', () => (left.size ? reject(new Error(`faltan ${[...left].join(', ')} en ${zipFile}`)) : resolve()));
    s.on('error', reject);
  });
  return out;
}

/* nivel del año: Global Solar Atlas en la rejilla del visor (sus celdas de 0.0025° tienen el centro en nuestros nodos) */
const atlasZip = path.join(CACHE, SOURCES.atlas_solar.file);
if (!fs.existsSync(atlasZip)) throw new Error(`Falta ${SOURCES.atlas_solar.file}. Corre npm run data:fetch atlas_solar`);
const AS = { lon0: -119, lat1: 33, step: 0.0025 };
const ar0 = Math.round((AS.lat1 - GRID.lat0) / AS.step - 0.5), ac0 = Math.round((GRID.lon0 - AS.lon0) / AS.step - 0.5);
const atlas = await readAsc(atlasZip, ['GHI.asc', 'DIF.asc'], ar0, ar0 + H - 1, ac0, ac0 + W - 1);
lap('Global Solar Atlas: global y difusa del año');
/** promedio en una ventana de (2R + 1)² celdas, sin contar las que no tienen dato */
function smooth(v, R) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (const [src, dst, horiz] of [[v, tmp, true], [tmp, out, false]]) {
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      let s = 0, n = 0;
      for (let d = -R; d <= R; d++) {
        const rr = horiz ? r : r + d, cc = horiz ? c + d : c;
        if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
        const x = src[rr * W + cc];
        if (x > 0) { s += x; n++; }
      }
      dst[r * W + c] = n ? s / n : NaN;
    }
  }
  return out;
}
const L = 10, ghiS = smooth(atlas['GHI.asc'], 9), difS = smooth(atlas['DIF.asc'], 9);
const lat_ = { lon0: GRID.lon0, lat0: GRID.lat0, step: GRID.step * L, nx: Math.ceil((W - 1) / L) + 1, ny: Math.ceil((H - 1) / L) + 1 };
const sample = v => Array.from({ length: lat_.nx * lat_.ny }, (_, i) => {
  const x = v[Math.min(H - 1, Math.floor(i / lat_.nx) * L) * W + Math.min(W - 1, (i % lat_.nx) * L)];
  if (!(x > 0)) throw new Error('el Global Solar Atlas no cubre todo el rectángulo del mapa');
  return +x.toFixed(3);
});
const climate = { anual: { ...lat_, ghi: sample(ghiS), dhi: sample(difS) }, meses };

/* relieve de 90 m y zona: hasta ~3 km del estado, con la rejilla de municipios del visor */
const fine = await loadFine(), F3 = sub(DETAIL), S = FINE / DETAIL;
const z = boxDown(fine.data, fine.w, fine.h, S), { w, h, dxm, dzm } = F3, n = w * h;
const muni = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'src/relieve/data/muni.bin')));
let zone = Uint8Array.from(muni, v => (v ? 1 : 0));
for (let s = 0; s < 12; s++) {
  const next = zone.slice();
  for (let i = 0; i < W * H; i++) {
    if (zone[i]) continue;
    const c = i % W;
    if ((c > 0 && zone[i - 1]) || (c < W - 1 && zone[i + 1]) || (i >= W && zone[i - W]) || (i < W * (H - 1) && zone[i + W])) next[i] = 1;
  }
  zone = next;
}
const nodeOf = (c, r) => Math.round(r / DETAIL) * W + Math.round(c / DETAIL);
lap(`relieve de 90 m ${w}×${h}`);

/* horizontes: 16 planos de bytes */
const hz = new Uint8Array(HORIZON_DIRS.length * n);
HORIZON_DIRS.forEach(([a, b], d) => {
  const o = d * n;
  horizonSweep(z, w, h, a, b, Math.hypot(a * dxm, b * dzm), (i, v) => { hz[o + i] = hToByte(v); });
});
lap('horizontes en 16 direcciones');

/* radiación anual de cada nodo de la zona, y cifras por municipio */
const dirAz = dirAzimuths(dxm, dzm), wts = dirWeights(dirAz), hor = new Float64Array(HORIZON_DIRS.length), nd = HORIZON_DIRS.length;
const out = new Uint8Array(n), km2 = dxm * dzm * 1e-6;
const BREAKS = [1600, 1800, 2000, 2200];
const mun = Array.from({ length: 85 }, () => ({ sum: 0, plano: 0, n: 0, min: Infinity, max: -Infinity, clases: [0, 0, 0, 0, 0] }));
const all = [];
let table = null;
for (let r = 0; r < h; r++) {
  const lat = GRID.lat0 - r * F3.step;
  // el Sol cambia poco en 30 filas (≈ 2.8 km)
  if (r % 30 === 0) table = sunTable(lat - 15 * F3.step, dirAz);
  for (let c = 0; c < w; c++) {
    const i = r * w + c, node = nodeOf(c, r);
    if (!zone[node] || !(z[i] > 0)) continue;
    for (let k = 0; k < nd; k++) hor[k] = byteToH(hz[k * n + i]);
    const { slope, aspect } = slopeAspect(z, w, h, c, r, dxm, dzm);
    const V = skyView(slope, aspect, hor, dirAz, wts);
    const cl = climateAt(climate, GRID.lon0 + c * F3.step, lat);
    const e = irradiation(table, slope, aspect, hor, V, cl.ghi, cl.dhi);
    out[i] = solarToByte(e);
    const m = muni[node];
    if (!m) continue;
    const q = byteToSolar(out[i]), M = mun[m];
    M.sum += q; M.n++; M.plano += cl.ghi.reduce((s, g, k) => s + g * MONTH_DAYS[k], 0);
    if (q < M.min) M.min = q;
    if (q > M.max) M.max = q;
    let k = 0;
    while (k < BREAKS.length && q > BREAKS[k]) k++;
    M.clases[k]++;
    all.push(q);
  }
}
lap('radiación anual');

all.sort((a, b) => a - b);
const pct = p => all[Math.min(all.length - 1, Math.floor(p * all.length))];
const total = mun.reduce((s, M) => s + M.n, 0), media = mun.reduce((s, M) => s + M.sum, 0) / total;
const municipios = mun.slice(1).map((M, k) => ({
  id: k + 1, media: Math.round(M.sum / M.n), plano: Math.round(M.plano / M.n), min: Math.round(M.min), max: Math.round(M.max),
  km2: M.clases.map(x => +(x * km2).toFixed(1)),
}));

const head = Buffer.alloc(16);
head.writeUInt32LE(0x31454852, 0); head.writeUInt32LE(w, 4); head.writeUInt32LE(h, 8); head.writeUInt32LE(DETAIL, 12);
const size = writeGz(path.join(LAYERS, 'solar.bin'), Buffer.concat([head, Buffer.from(out.buffer)]));
writeJSON(path.join(LAYERS, 'solar.json'), {
  q: SOLAR_Q, clases: BREAKS, periodos: { atlas: '1999–2018', meses: '2001–2025' },
  clima: climate,
  estado: { media: Math.round(media), p5: pct(0.05), p50: pct(0.5), p95: pct(0.95), min: all[0], max: all.at(-1) },
  municipios,
});
writeJSON(path.join(OUT, 'solar_municipios.json'), municipios.map(m => ({
  cve_mun: m.id, kwh_m2_anual_media: m.media, kwh_m2_anual_plano: m.plano, kwh_m2_anual_min: m.min, kwh_m2_anual_max: m.max,
  km2_menos_1600: m.km2[0], km2_1600_1800: m.km2[1], km2_1800_2000: m.km2[2], km2_2000_2200: m.km2[3], km2_mas_2200: m.km2[4],
})));
log(`Hidalgo: media ${Math.round(media)} kWh/m²·año sobre el terreno (5 % – 95 %: ${pct(0.05)}–${pct(0.95)}; ${all[0]}–${all.at(-1)})`);
const top = [...municipios].sort((a, b) => b.media - a.media);
log(`más soleados: ${top.slice(0, 3).map(m => `${m.id} ${m.media}`).join(', ')} · menos: ${top.slice(-3).map(m => `${m.id} ${m.media}`).join(', ')}`);
/* control: lo plano (global del Atlas) y un panel a la inclinación óptima hacia el sur con el horizonte del lugar, contra
   el sitio del Global Solar Atlas (versión 2.2, consultado el 2026-10-30; las rejillas descargables son de 2019) */
const REF = [['Pachuca', -98.737, 20.1224, 2213, 23, 2362], ['Ixmiquilpan', -99.2188, 20.4849, 2258, 22, 2401], ['Huejutla', -98.4206, 21.1392, 1801, 19, 1879], ['Zacualtipán', -98.6536, 20.6452, 1933, 20, 2036]];
for (const [name, lon, lat, ghiRef, opta, gtiRef] of REF) {
  const c = Math.round(((lon - GRID.lon0) / GRID.step) * DETAIL), r = Math.round(((GRID.lat0 - lat) / GRID.step) * DETAIL), i = r * w + c;
  for (let k = 0; k < nd; k++) hor[k] = byteToH(hz[k * n + i]);
  const cl = climateAt(climate, lon, lat), t = sunTable(lat, dirAz), flat = cl.ghi.reduce((s, g, k) => s + g * MONTH_DAYS[k], 0);
  const tilt = (opta * Math.PI) / 180, gti = irradiation(t, tilt, Math.PI, hor, skyView(tilt, Math.PI, hor, dirAz, wts), cl.ghi, cl.dhi);
  log(`${name}: plano ${Math.round(flat)} (Atlas ${ghiRef}), panel a ${opta}° al sur ${Math.round(gti)} (Atlas ${gtiRef}), terreno ${byteToSolar(out[i])} kWh/m²·año`);
}
log(`capas/solar.bin ${kb(size)} (${w}×${h}), solar.json ${kb(fs.statSync(path.join(LAYERS, 'solar.json')).size)}`);
