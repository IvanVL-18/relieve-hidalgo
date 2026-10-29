#!/usr/bin/env node
/**
 * Susceptibilidad de laderas (índice propio e ilustrativo) a ≈ 90 m, con las reglas de src/relieve/shared/laderas.ts:
 *   puntos = 2 · pendiente (media de los 3 × 3 nodos de 30 m) + lluvia intensa (CHIRPS: máximo anual de lluvia en 5
 *            días, promedio 1981–2025) + roca (geología de INEGI 1:250 000) + cobertura (Serie VII)
 * y, para compararlo, lo que el CENAPRED publica de Hidalgo (atlas estatal: zonas de peligro por deslizamiento y los
 * deslizamientos registrados en 2008 y 2009) y el catálogo de la NASA. El Mapa Nacional de Susceptibilidad del CENAPRED
 * no se publica para Hidalgo (su servicio solo cubre los estados del Golfo afectados por la tormenta Fernand).
 *   capas/laderas.bin   RHK1: u32 firma · w · h · planos (3) · u8 [3][w·h], cada plano alineado a 4 bytes (empaque en shared/laderas.ts), w = (W − 1)·3,
 *                       solo hasta ~3 km del estado, gzip
 *   capas/laderas.json  km² por clase, rejilla de lluvia de CHIRPS (0.05°), deslizamientos registrados y contorno de las
 *                       zonas de peligro del atlas estatal
 *   out/deslizamientos.json · laderas_municipios.json   para la base de datos
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CACHE, GRID, H, LAT0, LAYERS, LON0, OUT, ROOT, STEP, W, colOf, fillPolygon, kb, log, parseCSV, rowOf, writeGz, writeJSON } from './lib.mjs';
import { SOURCES } from './sources.mjs';
import { FINE, loadFine, sub } from './dem.mjs';
import { USV_GROUPS } from '../../src/relieve/shared/usv.ts';
import { CLASES, COBERTURA, LLUVIA, PENDIENTE, ROCAS, claseDe, clasificar, coberturaDe, empacar, puntos } from '../../src/relieve/shared/laderas.ts';

const S = 3, w = (W - 1) * S, h = (H - 1) * S, F = FINE / S;
const t0 = Date.now(), lap = msg => log(`${msg} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
const muni = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'src/relieve/data/muni.bin')));
const nodeOf = (x, y) => Math.round((y + 0.5) / S) * W + Math.round((x + 0.5) / S);
const pxKm2 = (GRID.step / S) ** 2 * 111.32 * Math.cos((20.5 * Math.PI) / 180) * 110.57;

/* zona: hasta ~3 km del estado (como relieve-90m), con la rejilla de municipios del visor */
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

/* pendiente media a 30 m de los 3 × 3 nodos de cada píxel (misma fórmula que las cifras por municipio) */
const fine = await loadFine(), { w: fw, dxm, dzm } = sub(FINE), e = fine.data;
const slope = new Float32Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  let sum = 0, n = 0;
  for (let dy = 0; dy < F; dy++) for (let dx = 0; dx < F; dx++) {
    const r = y * F + dy, c = x * F + dx;
    if (r < 1 || c < 1 || c >= fw - 1 || r >= (H - 1) * FINE) continue;
    const i = r * fw + c;
    if (!(e[i] > 0 && e[i - 1] > 0 && e[i + 1] > 0 && e[i - fw] > 0 && e[i + fw] > 0)) continue;
    const gx = (e[i + 1] - e[i - 1]) / (2 * dxm), gz = (e[i + fw] - e[i - fw]) / (2 * dzm);
    sum += (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI; n++;
  }
  slope[y * w + x] = n ? sum / n : NaN;
}
lap('pendiente a 30 m por píxel de 90 m');

/*
 * lluvia intensa (CHIRPS v3, pentadas): por celda de 0.05°, el máximo de cada año de la lluvia en 5 días; su promedio
 * (lo que usa el índice), el valor de 10 años de periodo de retorno (Gumbel por momentos: media + 1.305 · desviación)
 * y la lluvia media anual. Al píxel de 90 m llega interpolado (bilineal entre centros de celda).
 */
const cdir = path.join(CACHE, SOURCES.chirps.file), win = JSON.parse(fs.readFileSync(path.join(cdir, 'ventana.json'), 'utf8'));
const anios = [];
for (let y = SOURCES.chirps.anios[0]; y <= SOURCES.chirps.anios[1]; y++) if (fs.existsSync(path.join(cdir, `${y}.f32`))) anios.push(y);
if (anios.length < 30) throw new Error(`CHIRPS: solo ${anios.length} años en la caché (npm run data:fetch -- chirps)`);
const nc = win.cols * win.rows, sumMax = new Float64Array(nc), sumMax2 = new Float64Array(nc), sumTot = new Float64Array(nc), bad = new Uint8Array(nc);
for (const y of anios) {
  const a = new Float32Array(Uint8Array.from(fs.readFileSync(path.join(cdir, `${y}.f32`))).buffer);
  for (let c = 0; c < nc; c++) {
    let mx = 0, tot = 0;
    for (let k = 0; k < win.pentadas; k++) { const v = a[k * nc + c]; if (v < 0) bad[c] = 1; else { tot += v; if (v > mx) mx = v; } }
    sumMax[c] += mx; sumMax2[c] += mx * mx; sumTot[c] += tot;
  }
}
const N = anios.length, rx5 = new Float32Array(nc), rx10 = new Float32Array(nc), anual = new Float32Array(nc);
for (let c = 0; c < nc; c++) {
  if (bad[c]) { rx5[c] = rx10[c] = anual[c] = NaN; continue; }
  const m = sumMax[c] / N, sd = Math.sqrt(Math.max(0, sumMax2[c] / N - m * m) * (N / (N - 1)));
  rx5[c] = m; rx10[c] = m + 1.305 * sd; anual[c] = sumTot[c] / N;
}
const bilinear = (g, lon, lat) => {
  const fx = Math.min(win.cols - 1.001, Math.max(0, (lon - win.lon0) / win.step - 0.5)), fy = Math.min(win.rows - 1.001, Math.max(0, (win.lat0 - lat) / win.step - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, i = y0 * win.cols + x0;
  return (g[i] * (1 - tx) + g[i + 1] * tx) * (1 - ty) + (g[i + win.cols] * (1 - tx) + g[i + win.cols + 1] * tx) * ty;
};
const lonOf = x => LON0 + ((x + 0.5) / S) * STEP, latOf = y => LAT0 - ((y + 0.5) / S) * STEP;
lap(`lluvia intensa de CHIRPS: ${N} años (${anios[0]}–${anios.at(-1)}), ${win.cols}×${win.rows} celdas`);

/* roca: geología de INEGI 1:250 000 (tipo; la entidad «SUELO» son depósitos sin consolidar) */
const roca = new Uint8Array(w * h), tipos = new Map(ROCAS.map((r, i) => [r.tipo, i + 1])), sinTipo = new Set();
const toPx = ([lon, lat]) => [colOf(lon) * S, rowOf(lat) * S];
for (const f of JSON.parse(fs.readFileSync(path.join(CACHE, SOURCES.rocas.file), 'utf8')).features) {
  const p = f.properties, v = tipos.get(p.ENTIDAD === 'SUELO' ? 'Suelo' : p.TIPO);
  if (!v) { sinTipo.add(p.TIPO); continue; }
  const g = f.geometry;
  for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) fillPolygon(poly, w, h, toPx, i => { roca[i] = v; });
}
if (sinTipo.size) log(`tipos de roca sin puntos (sin dato): ${[...sinTipo].join(', ')}`);
lap('roca');

/* cobertura: Serie VII (rejilla de ≈ 65 m, factor 4) */
const ub = zlib.gunzipSync(fs.readFileSync(path.join(LAYERS, 'usv.bin'))), uw = ub.readUInt32LE(4), US = uw / (W - 1);
const coverOf = JSON.parse(fs.readFileSync(path.join(LAYERS, 'usv.json'), 'utf8')).clases.map(c => coberturaDe(USV_GROUPS[c.grupo].id, c.sec));

/* zonas de peligro por deslizamiento del atlas estatal (CENAPRED): rasterizadas y, para dibujarlas, simplificadas */
const zonaPx = new Uint8Array(w * h), zonas = [];
for (const { geometry: g } of JSON.parse(fs.readFileSync(path.join(CACHE, SOURCES.cenapred.file, `${SOURCES.cenapred.zonas.split('/').slice(1).join('_')}.json`), 'utf8')).features) {
  if (!g?.rings?.length) continue;
  fillPolygon(g.rings, w, h, toPx, i => { zonaPx[i] = 1; });
  for (const ring of g.rings) {
    const out = [];
    for (const [lon, lat] of ring) {
      const last = out.at(-1);
      if (!last || Math.hypot(lon - last[0], lat - last[1]) > 0.0003) out.push([+lon.toFixed(4), +lat.toFixed(4)]);
    }
    if (out.length > 3) zonas.push(out);
  }
}

/* clasificación y empaque */
const p0 = new Uint8Array(w * h), p1 = new Uint8Array(w * h), p2 = new Uint8Array(w * h);
const area = new Float64Array(6), enZona = new Float64Array(6), lluviaPx = new Float32Array(w * h), coverPx = new Int8Array(w * h);
const areaMun = Array.from({ length: 85 }, () => new Float64Array(7)); // clases 1–5 y, en 6, zonas del atlas
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const node = nodeOf(x, y), i = y * w + x, s = slope[i];
  if (!zone[node] || Number.isNaN(s)) continue;
  const mm = bilinear(rx5, lonOf(x), latOf(y));
  const cover = coverOf[ub[12 + Math.floor(((y + 0.5) / S) * US) * uw + Math.floor(((x + 0.5) / S) * US)] - 1];
  if (cover == null || Number.isNaN(mm)) continue;
  const kp = claseDe(s, PENDIENTE.cortes), kl = claseDe(mm, LLUVIA.cortes), r = roca[i] - 1;
  const k = clasificar(puntos(kp, kl, r, cover), s);
  p0[i] = empacar.p0(k, kp, cover); p1[i] = roca[i]; p2[i] = empacar.p2(kl, zonaPx[i]); lluviaPx[i] = mm; coverPx[i] = cover;
  if (muni[node]) { area[k] += pxKm2; areaMun[muni[node]][k] += pxKm2; if (zonaPx[i]) { enZona[k] += pxKm2; areaMun[muni[node]][6] += pxKm2; } }
}
const tot = area.reduce((a, b) => a + b, 0), pct = v => `${((100 * v) / tot).toFixed(1)} %`, zonaKm2 = enZona.reduce((a, b) => a + b, 0);
lap(`clases en Hidalgo: ${[1, 2, 3, 4, 5].map(k => pct(area[k])).join(' · ')} (muy baja → muy alta)`);
log(`zonas de peligro del atlas estatal: ${zonaKm2.toFixed(0)} km²; ${((100 * (enZona[4] + enZona[5])) / zonaKm2).toFixed(0)} % es alta o muy alta en el índice`);

/* deslizamientos registrados */
const sentence = s => { const t = s.trim().replace(/\s+/g, ' ').toLowerCase(); return t.charAt(0).toUpperCase() + t.slice(1); };
const inMap = (lon, lat) => { const c = Math.round(colOf(lon)), r = Math.round(rowOf(lat)); return c >= 0 && r >= 0 && c < W && r < H && zone[r * W + c]; };
const historicos = [];
for (const capa of SOURCES.cenapred.historicos) {
  const d = JSON.parse(fs.readFileSync(path.join(CACHE, SOURCES.cenapred.file, `${capa.split('/').slice(1).join('_')}.json`), 'utf8'));
  for (const { attributes: a, geometry: g } of d.features) {
    if (!g || !inMap(g.x, g.y)) continue;
    const [dd, mm, yy] = String(a.FECHA ?? '').split('/');
    historicos.push({
      fecha: yy ? `${yy}-${mm}-${dd}` : String(a.AÑO ?? ''), lon: +g.x.toFixed(5), lat: +g.y.toFixed(5),
      nivel: sentence(a.VALOR_INDIC_CUALITAT ?? ''), roca: sentence(a.LITOLOGIA ?? ''), tipo: sentence(a.DESCRIPCION ?? ''), nota: sentence(a.OBSERVACIONES ?? ''),
    });
  }
}
const eventos = [];
const glc = path.join(CACHE, SOURCES.deslizamientos.file);
if (fs.existsSync(glc)) for (const r of parseCSV(fs.readFileSync(glc, 'utf8'))) {
  const lon = +r.longitude, lat = +r.latitude, c = Math.round(colOf(lon)), rr = Math.round(rowOf(lat));
  if (!(c >= 0 && rr >= 0 && c < W && rr < H && muni[rr * W + c])) continue;
  const [mm, dd, yy] = r.event_date.split(' ')[0].split('/');
  eventos.push({ fecha: `${yy}-${mm}-${dd}`, lugar: r.event_title, lon: +lon.toFixed(4), lat: +lat.toFixed(4), precision: r.location_accuracy, muertes: +r.fatality_count || 0 });
}
// validación: proporción de deslizamientos del atlas por clase frente a la proporción del área (razón de frecuencia)
const enClase = new Float64Array(6);
let enZonas = 0;
for (const p of historicos) {
  const i = Math.floor(rowOf(p.lat) * S) * w + Math.floor(colOf(p.lon) * S);
  enClase[p0[i] & 7]++; enZonas += (p2[i] >> 3) & 1;
}
const nh = historicos.length;
log(`deslizamientos del atlas estatal (CENAPRED): ${nh}; razón de frecuencia por clase (muy baja → muy alta): ${[1, 2, 3, 4, 5].map(k => ((enClase[k] / nh) / (area[k] / tot)).toFixed(2)).join(' · ')}`);
log(`  en alta o muy alta: ${((100 * (enClase[4] + enClase[5])) / nh).toFixed(0)} % de los deslizamientos en ${pct(area[4] + area[5])} del estado; en las zonas del atlas: ${((100 * enZonas) / nh).toFixed(0)} % en ${pct(zonaKm2)}`);
log(`catálogo de la NASA: ${eventos.length} deslizamientos en Hidalgo`);

/*
 * Qué aporta cada factor: AUC (probabilidad de que el lugar de un deslizamiento registrado tenga más puntos que un lugar
 * cualquiera de Hidalgo; 0.5 = azar) del índice y de variantes, entre ellas la versión anterior (lluvia media anual de
 * INEGI en vez de la intensa de CHIRPS, sin roca).
 */
const lluviaAnual = new Uint16Array(w * h);
for (const f of JSON.parse(fs.readFileSync(path.join(CACHE, SOURCES.lluvia.file), 'utf8')).features) {
  const nums = (f.properties.PANUAL.match(/\d+/g) ?? []).map(Number);
  if (!nums.length) continue;
  const mm = nums.length > 1 ? (nums[0] + nums[1]) / 2 : nums[0], g = f.geometry;
  for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) fillPolygon(poly, w, h, toPx, i => { lluviaAnual[i] = mm; });
}
const factores = i => {
  const d = p0[i], kp = (d >> 3) & 7, kl = (p2[i] & 7) - 1, r = p1[i] - 1;
  return { kp, kl, roca: r >= 0 ? ROCAS[r].puntos : 0, cov: COBERTURA[coverPx[i]].puntos, anual: claseDe(lluviaAnual[i], [600, 1000, 1500, 2000]) };
};
const variantes = {
  'índice': f => 2 * f.kp + f.kl + f.roca + f.cov,
  'sin roca': f => 2 * f.kp + f.kl + f.cov,
  'sin lluvia': f => 2 * f.kp + f.roca + f.cov,
  'sin cobertura': f => 2 * f.kp + f.kl + f.roca,
  'lluvia anual (INEGI) en vez de intensa': f => 2 * f.kp + f.anual + f.roca + f.cov,
  'versión anterior (pendiente, lluvia anual, cobertura)': f => 2 * f.kp + f.anual + f.cov,
  'solo pendiente': f => f.kp,
};
const evPx = historicos.map(p => Math.floor(rowOf(p.lat) * S) * w + Math.floor(colOf(p.lon) * S)).filter(i => p0[i]);
for (const [nombre, fn] of Object.entries(variantes)) {
  const bins = new Float64Array(64), at = v => Math.round((v + 8) * 2);
  let n = 0;
  for (let i = 0; i < w * h; i++) if (p0[i] && muni[nodeOf(i % w, Math.floor(i / w))]) { bins[at(fn(factores(i)))]++; n++; }
  const below = new Float64Array(64);
  for (let b = 1; b < 64; b++) below[b] = below[b - 1] + bins[b - 1];
  let auc = 0;
  for (const i of evPx) { const b = at(fn(factores(i))); auc += (below[b] + bins[b] / 2) / n; }
  log(`  AUC ${(auc / evPx.length).toFixed(3)}: ${nombre}`);
}

const head = Buffer.alloc(16);
head.writeUInt32LE(0x314b4852, 0); head.writeUInt32LE(w, 4); head.writeUInt32LE(h, 8); head.writeUInt32LE(3, 12);
/* para la base de datos: deslizamientos registrados con la clase del índice en su lugar, y km² por municipio */
const nodeAt = (lon, lat) => Math.round(rowOf(lat)) * W + Math.round(colOf(lon));
const claseEn = (lon, lat) => { const i = Math.floor(rowOf(lat) * S) * w + Math.floor(colOf(lon) * S); return [p0[i] & 7 || null, (p2[i] >> 3) & 1]; };
writeJSON(path.join(OUT, 'deslizamientos.json'), [
  ...historicos.map(p => { const [clase, zona] = claseEn(p.lon, p.lat); return { fuente: 'CENAPRED, atlas estatal', fecha: p.fecha, lon: p.lon, lat: p.lat, cve_mun: muni[nodeAt(p.lon, p.lat)] || null, nivel_atlas: p.nivel, litologia: p.roca, descripcion: p.nota, clase_indice: clase, en_zona_atlas: !!zona, precision: null, muertes: null }; }),
  ...eventos.map(e => { const [clase, zona] = claseEn(e.lon, e.lat); return { fuente: 'NASA, Global Landslide Catalog', fecha: e.fecha, lon: e.lon, lat: e.lat, cve_mun: muni[nodeAt(e.lon, e.lat)] || null, nivel_atlas: null, litologia: null, descripcion: e.lugar, clase_indice: clase, en_zona_atlas: !!zona, precision: e.precision, muertes: e.muertes }; }),
]);
writeJSON(path.join(OUT, 'laderas_municipios.json'), areaMun.slice(1).map((a, i) => ({
  cve_mun: i + 1, muy_baja_km2: +a[1].toFixed(2), baja_km2: +a[2].toFixed(2), media_km2: +a[3].toFixed(2), alta_km2: +a[4].toFixed(2), muy_alta_km2: +a[5].toFixed(2), zona_atlas_km2: +a[6].toFixed(2),
})));

const pad4 = b => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const size = writeGz(path.join(LAYERS, 'laderas.bin'), Buffer.concat([head, pad4(p0), pad4(p1), pad4(p2)]));
const r1 = v => (Number.isNaN(v) ? null : Math.round(v * 10) / 10);
writeJSON(path.join(LAYERS, 'laderas.json'), {
  clases: CLASES,
  km2: Array.from(area.slice(1), v => +v.toFixed(1)),
  lluvia: { lon0: win.lon0, lat0: win.lat0, step: win.step, cols: win.cols, rows: win.rows, anios: [anios[0], anios.at(-1)], rx5: Array.from(rx5, r1), rx10: Array.from(rx10, r1), anual: Array.from(anual, v => (Number.isNaN(v) ? null : Math.round(v))) },
  historicos, eventos, zonas,
});
let mn = Infinity, mx = -Infinity;
for (let i = 0; i < w * h; i++) if (p0[i] && muni[nodeOf(i % w, Math.floor(i / w))]) { mn = Math.min(mn, lluviaPx[i]); mx = Math.max(mx, lluviaPx[i]); }
log(`lluvia máxima en 5 días en Hidalgo: ${mn.toFixed(0)}–${mx.toFixed(0)} mm (promedio de los máximos anuales)`);
log(`capas/laderas.bin ${kb(size)} (${w}×${h}), laderas.json ${kb(fs.statSync(path.join(LAYERS, 'laderas.json')).size)}`);
