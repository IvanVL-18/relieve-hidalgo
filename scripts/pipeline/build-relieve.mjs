#!/usr/bin/env node
/**
 * Relieve base del visor a partir de fuentes públicas (sustituye al script de Python del artefacto original).
 *
 * Entrada (npm run data:fetch relieve agua iter)
 *   cache/terrain/12/*.png        Terrain Tiles z12 (≈ 36 m; en México, INEGI Continental relief 2016)
 *   cache/inegi_hidalgo_2022.json municipios INEGI (se descarga si falta)
 *   cache/osm/agua_hidalgo.json   ríos, presas y lagos de OSM (si falta, la copia data-src/osm_agua.json.gz)
 *   cache/iter/…                  ITER 2020: localidades para etiquetas y luces nocturnas
 *
 * Salida (src/relieve/data/)
 *   meta.json        georreferencia; municipios con estadísticas del relieve a 30 m, área del polígono, población
 *                    y localidades; localidades del ITER para etiquetas; ríos y presas con nombre; punto más alto
 *   elev.bin         elevación ≈ 270 m (promedio de cada celda): residuo del predictor de gradiente, gzip
 *   muni.bin         municipio por nodo de la rejilla del visor (0 = fuera de Hidalgo), gzip
 *   muni-50m.bin     RHM2: municipio a ≈ 50 m (dilatado 2 píxeles) y la línea donde se recorta el terreno: el contorno
 *                    del estado sobre esa rejilla (el visor calcula de ella la distancia con signo y pone ahí las paredes), gzip
 *   relieve-90m.bin  RHD1: elevación ≈ 90 m (0 = sin dato, lejos del estado), para el sombreado fino, gzip
 *   relieve-30m.bin  RHP1: relieve de 30 m en teselas de 16 × 16 celdas (cuartos de metro), para el detalle al acercarse
 *   vec.bin          RHV1: ríos (drenaje a 90 m guiado por OSM), presas, límites municipales, contorno del estado
 *                    y localidades del ITER (luces nocturnas), gzip
 *   capas/flujo-90m.bin  RHH1: dirección del flujo D8 a 90 m (cuencas y trayectorias del agua en los análisis), gzip
 *   data-src/out/relieve_municipios.json · rios.json   para los demás pasos y la base de datos
 *
 * Uso: node scripts/pipeline/build-relieve.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CACHE, GRID, LAYERS, OUT, ROOT, dms, fillPolygon, kb, log, readIter, writeGz, writeJSON, writePack } from './lib.mjs';
import { RELIEF_CREDIT, SOURCES } from './sources.mjs';
import { DETAIL, FINE, KX, KZ, TILE, boxDown, colOf, gradientPlanes, latOfRow, loadFine, lonOfCol, rowOf, sub } from './dem.mjs';
import { accumulate, burnLines, chaikin, channelNetwork, flowDir, priorityFlood } from './hidro.mjs';
import { stateField } from '../../src/relieve/worker/raster.ts';

const t0 = Date.now();
const DATA = path.join(ROOT, 'src/relieve/data');
const { W, H } = GRID;
const lap = (msg) => log(`${msg} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

/* ================= relieve ================= */
const fine = await loadFine();
const F9 = sub(FINE), F3 = sub(DETAIL), F1 = sub(1);
const base = boxDown(fine.data, F9.w, F9.h, FINE);
const detail = boxDown(fine.data, F9.w, F9.h, FINE / DETAIL);
lap('relieve fino, base y detalle');

/**
 * Curvas de nivel iso de una rejilla por nodos (marching squares orientado, dentro = valor < iso a la izquierda):
 * anillos cerrados en coordenadas de nodo, con el punto de cada arista interpolado (la misma orilla que el bilineal).
 */
function contourRings(v, w, h, iso) {
  const H = (r, c) => (r * w + c) * 2, V = (r, c) => (r * w + c) * 2 + 1;
  const next = new Map();
  const seg = (a, b) => next.set(a, b);
  for (let r = 0; r < h - 1; r++) for (let c = 0; c < w - 1; c++) {
    const tl = v[r * w + c] < iso, tr = v[r * w + c + 1] < iso, br = v[(r + 1) * w + c + 1] < iso, bl = v[(r + 1) * w + c] < iso;
    const k = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
    if (k === 0 || k === 15) continue;
    const T = H(r, c), B = H(r + 1, c), L = V(r, c), R = V(r, c + 1);
    const center = (v[r * w + c] + v[r * w + c + 1] + v[(r + 1) * w + c + 1] + v[(r + 1) * w + c]) / 4 < iso;
    switch (k) {
      case 8: seg(L, T); break; case 4: seg(T, R); break; case 2: seg(R, B); break; case 1: seg(B, L); break;
      case 12: seg(L, R); break; case 6: seg(T, B); break; case 3: seg(R, L); break; case 9: seg(B, T); break;
      case 14: seg(L, B); break; case 13: seg(B, R); break; case 11: seg(R, T); break; case 7: seg(T, L); break;
      case 10: if (center) { seg(R, T); seg(L, B); } else { seg(L, T); seg(R, B); } break;
      case 5: if (center) { seg(T, L); seg(B, R); } else { seg(T, R); seg(B, L); } break;
    }
  }
  const point = e => {
    const i = e >> 1, r = Math.floor(i / w), c = i % w;
    const [r2, c2] = e & 1 ? [r + 1, c] : [r, c + 1];
    const a = v[r * w + c], b = v[r2 * w + c2], t = a === b ? 0.5 : (iso - a) / (b - a);
    return [c + (c2 - c) * t, r + (r2 - r) * t];
  };
  const rings = [], seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const ring = [];
    for (let e = start; e !== undefined && !seen.has(e); e = next.get(e)) { seen.add(e); ring.push(point(e)); }
    if (ring.length > 2) { ring.push(ring[0]); rings.push(ring); }
  }
  return rings;
}

/* ================= municipios ================= */
const GEO_URL = 'https://raw.githubusercontent.com/PhantomInsights/mexico-geojson/main/2022/states/Hidalgo.json';
const geoFile = path.join(CACHE, 'inegi_hidalgo_2022.json');
if (!fs.existsSync(geoFile)) {
  log('descargando municipios INEGI…', GEO_URL);
  const res = await fetch(GEO_URL);
  if (!res.ok) throw new Error('No se pudo descargar el GeoJSON de municipios: ' + res.status);
  fs.writeFileSync(geoFile, Buffer.from(await res.arrayBuffer()));
}
const feats = JSON.parse(fs.readFileSync(geoFile, 'utf8')).features.sort((a, b) => a.properties.CVE_MUN.localeCompare(b.properties.CVE_MUN));
if (feats.length !== 84) throw new Error(`se esperaban 84 municipios y hay ${feats.length}`);
const polysOf = g => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

/** Municipio por nodo de una rejilla de factor f (el centro del píxel es el nodo). */
function rasterMuni(f) {
  const g = sub(f), out = new Uint8Array(g.w * g.h);
  const toPx = ([lon, lat]) => [colOf(lon) * f + 0.5, rowOf(lat) * f + 0.5];
  feats.forEach((ft, i) => { for (const p of polysOf(ft.geometry)) fillPolygon(p, g.w, g.h, toPx, k => { if (!out[k]) out[k] = i + 1; }); });
  return out;
}
/** Extiende los municipios n píxeles hacia afuera (el vecino más cercano por capas). */
function dilate(m, w, h, n) {
  let cur = m;
  for (let s = 0; s < n; s++) {
    const next = cur.slice();
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (cur[i]) continue;
      const v = (c > 0 && cur[i - 1]) || (c < w - 1 && cur[i + 1]) || (r > 0 && cur[i - w]) || (r < h - 1 && cur[i + w]);
      if (v) next[i] = v;
    }
    cur = next;
  }
  return cur;
}
const muni1 = rasterMuni(1), muni5 = dilate(rasterMuni(5), sub(5).w, sub(5).h, 2), muni9 = rasterMuni(FINE);
lap('municipios a 270, 50 y 30 m');

// área sobre el elipsoide WGS84 (proyección autálica), en km²
const A_ = 6378137, FL = 1 / 298.257223563, E2 = FL * (2 - FL), EE = Math.sqrt(E2);
const qf = phi => { const s = Math.sin(phi); return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * EE)) * Math.log((1 - EE * s) / (1 + EE * s))); };
const ringArea = ring => {
  let s = 0;
  for (let k = 0; k < ring.length - 1; k++) {
    const [l1, p1] = ring[k], [l2, p2] = ring[k + 1];
    s += ((l2 - l1) * Math.PI) / 180 * ((qf((p1 * Math.PI) / 180) + qf((p2 * Math.PI) / 180)) / 2);
  }
  return (Math.abs(s) * A_ * A_) / 2 / 1e6;
};
const polyArea = g => polysOf(g).reduce((s, p) => s + ringArea(p[0]) - p.slice(1).reduce((t, hole) => t + ringArea(hole), 0), 0);

/* ================= estadísticas a 30 m ================= */
const NM = 85, S = Array.from({ length: NM }, () => ({ n: 0, sum: 0, min: 1e9, max: -1e9, maxI: 0, slope: 0, p15: 0, p30: 0, tri: 0 }));
{
  const { w, h, dxm, dzm } = F9, e = fine.data;
  for (let r = 1; r < h - 1; r++) for (let c = 1; c < w - 1; c++) {
    const i = r * w + c, m = muni9[i];
    if (!m) continue;
    const z = e[i], t = S[m];
    const gx = (e[i + 1] - e[i - 1]) / (2 * dxm), gz = (e[i + w] - e[i - w]) / (2 * dzm);
    const sl = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
    t.n++; t.sum += z; t.slope += sl;
    if (sl > 15) t.p15++;
    if (sl > 30) t.p30++;
    if (z < t.min) t.min = z;
    if (z > t.max) { t.max = z; t.maxI = i; }
    // índice de rugosidad (Riley): diferencia media con los 8 vecinos
    t.tri += (Math.abs(e[i - w - 1] - z) + Math.abs(e[i - w] - z) + Math.abs(e[i - w + 1] - z) + Math.abs(e[i - 1] - z)
      + Math.abs(e[i + 1] - z) + Math.abs(e[i + w - 1] - z) + Math.abs(e[i + w] - z) + Math.abs(e[i + w + 1] - z)) / 8;
  }
}
const areas = feats.map(f => polyArea(f.geometry));
let peakM = 1;
for (let m = 2; m < NM; m++) if (S[m].max > S[peakM].max) peakM = m;
const peakI = S[peakM].maxI, stateMin = Math.min(...S.slice(1).map(t => t.min));
const peak = [+lonOfCol((peakI % F9.w) / FINE).toFixed(4), +latOfRow(Math.floor(peakI / F9.w) / FINE).toFixed(4), Math.round(S[peakM].max)];
const relieveMun = feats.map((f, k) => {
  const t = S[k + 1];
  return {
    id: k + 1, cve: '13' + f.properties.CVE_MUN, area_km2: +areas[k].toFixed(1),
    alt_min: Math.round(t.min), alt_max: Math.round(t.max), alt_media: Math.round(t.sum / t.n),
    pendiente: +(t.slope / t.n).toFixed(2), pct_pend_15: +((100 * t.p15) / t.n).toFixed(1), pct_pend_30: +((100 * t.p30) / t.n).toFixed(1),
    rugosidad: +(t.tri / t.n).toFixed(1),
  };
});
writeJSON(path.join(OUT, 'relieve_municipios.json'), relieveMun);
lap(`estadísticas a 30 m: punto más alto ${peak[2]} m (${feats[peakM - 1].properties.NOMGEO}), mínimo ${Math.round(stateMin)} m`);

/* ================= zona de Hidalgo (para recortar ríos y presas) ================= */
/** Nodos de la rejilla del visor a menos de n celdas del estado. */
function nearState(n) {
  let cur = Uint8Array.from(muni1, v => (v ? 1 : 0));
  for (let s = 0; s < n; s++) {
    const next = cur.slice();
    for (let i = 0; i < W * H; i++) {
      if (cur[i]) continue;
      const c = i % W;
      if ((c > 0 && cur[i - 1]) || (c < W - 1 && cur[i + 1]) || (i >= W && cur[i - W]) || (i < W * (H - 1) && cur[i + W])) next[i] = 1;
    }
    cur = next;
  }
  return cur;
}
const near6 = nearState(6), near2 = nearState(2);
const atNode = (mask, c, r) => { const cc = Math.round(c), rr = Math.round(r); return cc >= 0 && rr >= 0 && cc < W && rr < H && mask[rr * W + cc] > 0; };

/* ================= OpenStreetMap: ríos y cuerpos de agua ================= */
const aguaFile = path.join(CACHE, SOURCES.agua.file);
const osm = fs.existsSync(aguaFile)
  ? JSON.parse(fs.readFileSync(aguaFile, 'utf8'))
  : JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data-src/osm_agua.json.gz'))).toString('utf8'));
if (!fs.existsSync(aguaFile)) log('usando la copia data-src/osm_agua.json.gz (sin descarga de OSM)');
const linesOf = e => (e.type === 'way' ? [e.geometry ?? []] : (e.members ?? []).filter(m => m.type === 'way').map(m => m.geometry ?? []));
const riverEls = osm.elements.filter(e => e.tags?.waterway === 'river');

/* ================= hidrología a 90 m ================= */
const T_KM2 = 10;                 // área drenada mínima para dibujar un cauce
const ACC_REF_KM2 = 18.7;         // referencia del ancho (la del visor anterior): u8 = 32·log2(área / ref)
const hydro = { segs: [], dir: null };
{
  const { w, h, dxm, dzm, cellKm2 } = F3;
  const z = Float32Array.from(detail);
  const burnt = burnLines(z, w, h, riverEls.flatMap(linesOf).map(g => g.map(p => [colOf(p.lon) * DETAIL, rowOf(p.lat) * DETAIL])), 15);
  const filled = priorityFlood(z, w, h);
  const dir = flowDir(filled, w, h, dxm, dzm), acc = accumulate(dir, w, h);
  const segs = channelNetwork(dir, acc, w, h, T_KM2 / cellKm2);
  hydro.dir = dir;
  for (const s of segs) {
    const pts = s.cells.map(i => [(i % w) / DETAIL, Math.floor(i / w) / DETAIL, acc[i] * cellKm2]);
    if (!pts.some(([c, r], k) => (k % 4 === 0 || k === pts.length - 1) && atNode(near6, c, r))) continue;
    // suavizado y luego simplificación a ~13 m: la misma curva con muchos menos puntos
    hydro.segs.push({ order: s.order, pts: simplify(chaikin(pts), 0.05), km2: pts[pts.length - 1][2] });
  }
  const maxOrder = Math.max(...hydro.segs.map(s => s.order));
  lap(`hidrología: ${burnt} celdas guiadas por OSM, ${hydro.segs.length} tramos (orden de Strahler hasta ${maxOrder})`);
}
const accByte = km2 => Math.max(0, Math.min(255, Math.round(Math.log2(km2 / ACC_REF_KM2) * 32)));
const toLonLat = (c, r) => [+lonOfCol(c).toFixed(5), +latOfRow(r).toFixed(5)];
const segKm = pts => { let L = 0; for (let k = 1; k < pts.length; k++) L += Math.hypot((pts[k][0] - pts[k - 1][0]) * GRID.step * KX, (pts[k][1] - pts[k - 1][1]) * GRID.step * KZ); return L; };
writeJSON(path.join(OUT, 'rios.json'), hydro.segs.map(s => ({ orden: s.order, area_km2: +s.km2.toFixed(1), km: +segKm(s.pts).toFixed(2), geom: s.pts.filter((_, k) => k % 2 === 0 || k === s.pts.length - 1).map(([c, r]) => toLonLat(c, r)) })));
{
  // dirección de flujo a 90 m para los análisis (cuencas, trayectoria del agua): u32 'RHH1' · w · h · f · i8 dir[w·h]
  // (0–7 según D8 de hidro.mjs, −1 = sale de la rejilla). Cubre la zona del mapa: lo que drena desde fuera no se ve.
  const head = Buffer.alloc(16);
  head.writeUInt32LE(0x31484852, 0); head.writeUInt32LE(F3.w, 4); head.writeUInt32LE(F3.h, 8); head.writeUInt32LE(DETAIL, 12);
  const n = writeGz(path.join(LAYERS, 'flujo-90m.bin'), Buffer.concat([head, Buffer.from(hydro.dir.buffer)]));
  log(`capas/flujo-90m.bin ${kb(n)}`);
}

/* ================= presas y lagos ================= */
function assemble(ways) {
  const pool = ways.filter(w => w.length >= 2).map(w => w.map(p => [p.lon, p.lat]));
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const rings = [];
  while (pool.length) {
    let cur = pool.pop(), changed = true;
    while (!same(cur[0], cur[cur.length - 1]) && changed) {
      changed = false;
      for (let k = 0; k < pool.length; k++) {
        const w = pool[k];
        if (same(w[0], cur[cur.length - 1])) cur = cur.concat(w.slice(1));
        else if (same(w[w.length - 1], cur[cur.length - 1])) cur = cur.concat(w.slice().reverse().slice(1));
        else if (same(w[w.length - 1], cur[0])) cur = w.slice(0, -1).concat(cur);
        else if (same(w[0], cur[0])) cur = w.slice().reverse().slice(0, -1).concat(cur);
        else continue;
        pool.splice(k, 1); changed = true; break;
      }
    }
    if (cur.length >= 4) rings.push(cur);
  }
  return rings;
}
const ringKm2 = r => { let s = 0; for (let k = 0; k < r.length; k++) { const a = r[k], b = r[(k + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return (Math.abs(s) / 2) * KX * KZ; };
function simplify(pts, tol) {   // Douglas–Peucker
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const [ax, ay] = pts[i0], [bx, by] = pts[i1], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let best = -1, bi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = pts[i];
      const d = L === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dx * (py - ay) - dy * (px - ax)) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; stack.push([i0, bi], [bi, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const q8 = pts => pts.flatMap(([c, r]) => [Math.round(c * 8), Math.round(r * 8)]);
const lakes = [], lakeLabels = [];
for (const e of osm.elements) {
  const t = e.tags ?? {};
  if (!(t.natural === 'water' || t.landuse === 'reservoir')) continue;
  const outer = e.type === 'way' ? assemble([e.geometry ?? []]) : assemble((e.members ?? []).filter(m => m.role === 'outer').map(m => m.geometry ?? []));
  const inner = e.type === 'way' ? [] : assemble((e.members ?? []).filter(m => m.role === 'inner').map(m => m.geometry ?? []));
  const A = outer.reduce((s, r) => s + ringKm2(r), 0) - inner.reduce((s, r) => s + ringKm2(r), 0);
  if (A < 0.04) continue;
  const cr = [...outer, ...inner].map(ring => ring.map(([lon, lat]) => [colOf(lon), rowOf(lat)]));
  if (!cr.some(ring => ring.some(([c, r], k) => k % Math.max(1, Math.floor(ring.length / 40)) === 0 && atNode(near2, c, r)))) continue;
  lakes.push({ o: cr.slice(0, outer.length).map(r => q8(simplify(r, 0.25))), i: cr.slice(outer.length).map(r => q8(simplify(r, 0.25))) });
  if (t.name && A >= 0.8) {
    const all = outer.flat();
    const lon = all.reduce((s, p) => s + p[0], 0) / all.length, lat = all.reduce((s, p) => s + p[1], 0) / all.length;
    if (atNode(muni1, colOf(lon), rowOf(lat))) lakeLabels.push({ n: t.name, lon: +lon.toFixed(4), lat: +lat.toFixed(4), a: +A.toFixed(1) });
  }
}

/* ================= nombres de ríos (OSM) ================= */
const byName = new Map();
for (const e of riverEls) {
  const nm = e.tags?.name?.trim();
  if (!nm || nm.length < 4) continue;
  for (const g of linesOf(e)) (byName.get(nm) || byName.set(nm, []).get(nm)).push(g);
}
let riverLabels = [];
for (const [nm, gs] of byName) {
  const pts = [];
  for (const g of gs) for (let k = 0; k + 1 < g.length; k++) {
    const a = g[k], b = g[k + 1], lon = (a.lon + b.lon) / 2, lat = (a.lat + b.lat) / 2;
    if (atNode(muni1, colOf(lon), rowOf(lat))) pts.push([lon, lat, Math.hypot((b.lon - a.lon) * KX, (b.lat - a.lat) * KZ)]);
  }
  const L = pts.reduce((s, p) => s + p[2], 0);
  if (L < 12) continue;
  let run = 0, at = pts[0];
  for (const p of pts) { run += p[2]; at = p; if (run >= L / 2) break; }
  riverLabels.push({ n: (nm[0].toUpperCase() + nm.slice(1)).replace(/^Rio /, 'Río '), lon: +at[0].toFixed(4), lat: +at[1].toFixed(4), km: Math.round(L) });
}
riverLabels.sort((a, b) => b.km - a.km);
const seenRiver = new Set();
riverLabels = riverLabels.filter(x => { const k = x.n.toLowerCase().replace(/í/g, 'i'); if (seenRiver.has(k)) return false; seenRiver.add(k); return true; }).slice(0, 16);

/* ================= límites municipales y contorno del estado (INEGI) ================= */
// Cada tramo compartido entre dos municipios se guarda una sola vez: topología por aristas.
const key = p => p[0].toFixed(7) + ',' + p[1].toFixed(7);
const coords = new Map(), edges = new Map();
for (const f of feats) for (const poly of polysOf(f.geometry)) for (const ring of poly) for (let k = 0; k + 1 < ring.length; k++) {
  const a = key(ring[k]), b = key(ring[k + 1]);
  if (a === b) continue;
  coords.set(a, ring[k]); coords.set(b, ring[k + 1]);
  const ek = a < b ? a + '|' + b : b + '|' + a;
  edges.set(ek, (edges.get(ek) || 0) + 1);
}
const ekOf = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
/** Une aristas en cadenas que cortan en los nodos donde se juntan más de dos. */
function chainsOf(pred) {
  const adj = new Map(), used = new Set(), out = [];
  for (const [ek, n] of edges) {
    if (!pred(n)) continue;
    const [a, b] = ek.split('|');
    (adj.get(a) || adj.set(a, []).get(a)).push(b);
    (adj.get(b) || adj.set(b, []).get(b)).push(a);
  }
  const walk = (start, next) => {
    const pts = [start];
    let prev = start, cur = next;
    used.add(ekOf(prev, cur));
    for (;;) {
      pts.push(cur);
      const nb = adj.get(cur);
      if (nb.length !== 2) break;
      const nx = nb[0] === prev ? nb[1] : nb[0];
      if (used.has(ekOf(cur, nx))) break;
      used.add(ekOf(cur, nx));
      prev = cur; cur = nx;
    }
    return pts;
  };
  for (const [v, nb] of adj) if (nb.length !== 2) for (const n of nb) if (!used.has(ekOf(v, n))) out.push(walk(v, n));
  for (const [v, nb] of adj) for (const n of nb) if (!used.has(ekOf(v, n))) out.push(walk(v, n));   // anillos cerrados
  return out.map(ch => simplify(ch.map(k => { const [lon, lat] = coords.get(k); return [colOf(lon), rowOf(lat)]; }), 0.08));
}
const borders = chainsOf(n => n >= 2);
// el contorno del estado son las aristas de un solo municipio; los anillos diminutos son huecos entre polígonos vecinos
const ringLen = r => r.reduce((s, p, k) => (k ? s + Math.hypot(p[0] - r[k - 1][0], p[1] - r[k - 1][1]) : 0), 0);
const allOutline = chainsOf(n => n === 1), longest = Math.max(...allOutline.map(ringLen));
const outline = allOutline.filter(r => ringLen(r) > longest * 0.02);

/* ================= localidades del ITER ================= */
const iter = readIter(path.join(CACHE, SOURCES.iter.file));
const locs = iter.filter(r => r.MUN !== '000' && !['0000', '9998', '9999'].includes(r.LOC))
  .map(r => ({ n: r.NOM_LOC.trim(), m: +r.MUN, loc: +r.LOC, lon: dms(r.LONGITUD), lat: dms(r.LATITUD), pob: +r.POBTOT || 0 }))
  .filter(l => Number.isFinite(l.lon) && Number.isFinite(l.lat));
const munPob = new Map(iter.filter(r => r.MUN !== '000' && r.LOC === '0000').map(r => [+r.MUN, +r.POBTOT]));
// etiquetas: ciudades (≥ 25 000 hab.), pueblos (≥ 2 500 o cabecera municipal, clave 0001) y localidades de ≥ 500
const kindOf = l => (l.pob >= 25000 ? 0 : l.pob >= 2500 || l.loc === 1 ? 1 : 2);
// en la etiqueta se omiten los calificativos entre corchetes del ITER («Benito Juárez [Colonia]»)
const places = locs.filter(l => l.pob >= 500 || l.loc === 1)
  .map(l => [l.n.replace(/\s*\[[^\]]*\]\s*$/, ''), kindOf(l), +l.lon.toFixed(4), +l.lat.toFixed(4), l.m, l.pob])
  .sort((a, b) => a[1] - b[1] || b[5] - a[5] || a[0].localeCompare(b[0], 'es'));
const lights = locs.filter(l => l.pob > 0 && colOf(l.lon) >= 0 && colOf(l.lon) <= W - 1 && rowOf(l.lat) >= 0 && rowOf(l.lat) <= H - 1);
log(`ITER: ${locs.length} localidades, ${places.length} etiquetas (${places.filter(p => p[1] === 0).length} ciudades, ${places.filter(p => p[1] === 1).length} pueblos)`);

/* ================= archivos del visor ================= */
const gz = buf => zlib.gzipSync(buf, { level: 9 });
fs.mkdirSync(DATA, { recursive: true });
const sizes = {};
const save = (name, buf) => { fs.writeFileSync(path.join(DATA, name), buf); sizes[name] = buf.length; };

save('elev.bin', gz(gradientPlanes(Int16Array.from(base, Math.round), W, H)));
save('muni.bin', gz(muni1));
{
  // municipio y distancia con signo al contorno (el visor recorta el terreno donde es positiva), y la línea del recorte
  // (marching squares sobre esa misma distancia): las paredes del zócalo van justo donde termina el terreno
  const g5 = sub(5), head = Buffer.alloc(16);
  head.writeUInt32LE(0x324d4852, 0); head.writeUInt32LE(g5.w, 4); head.writeUInt32LE(g5.h, 8); head.writeUInt32LE(5, 12);
  const L = { start: [], len: [], x: [], y: [] };
  for (const ring of outline) { L.start.push(L.x.length); L.len.push(ring.length); for (const [c, r] of ring) { L.x.push(c); L.y.push(r); } }
  const sdf = stateField({ start: Uint32Array.from(L.start), len: Uint32Array.from(L.len), x: Float32Array.from(L.x), y: Float32Array.from(L.y) }, g5.w, g5.h, 5, 6);
  const rings = contourRings(sdf, g5.w, g5.h, 128).map(r => simplify(r, 0.05)).filter(r => r.length > 8);
  // anillos: u32 n · u32 len[n] · i32 dx, dy intercalados (nodos de 50 m × 32, el primero absoluto)
  const parts = [Buffer.from(Uint32Array.from([rings.length, ...rings.map(r => r.length)]).buffer)];
  for (const r of rings) {
    const d = new Int32Array(r.length * 2);
    let px = 0, py = 0;
    r.forEach(([x, y], k) => { const qx = Math.round(x * 32), qy = Math.round(y * 32); d[k * 2] = k ? qx - px : qx; d[k * 2 + 1] = k ? qy - py : qy; px = qx; py = qy; });
    parts.push(Buffer.from(d.buffer));
  }
  const pad = Buffer.alloc((4 - (muni5.length % 4)) % 4);
  save('muni-50m.bin', gz(Buffer.concat([head, Buffer.from(muni5.buffer), pad, ...parts])));
  log(`contorno del recorte: ${rings.length} anillo(s), ${rings.reduce((n, r) => n + r.length, 0)} puntos`);
}
{
  // relieve de detalle: elevación entera hasta ~3 km del estado (lo que alcanza el horizonte de la oclusión);
  // lo demás va en 0 = sin dato, que comprime casi a nada
  const { w, h } = F3, near12 = nearState(12), v = Int16Array.from(detail, Math.round);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (!atNode(near12, c / DETAIL, r / DETAIL)) v[r * w + c] = 0;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(0x31444852, 0); head.writeUInt32LE(w, 4); head.writeUInt32LE(h, 8); head.writeUInt32LE(DETAIL, 12);
  save('relieve-90m.bin', gz(Buffer.concat([head, Buffer.from(gradientPlanes(v, w, h))])));
}

{
  // relieve de 30 m en teselas de TILE × TILE celdas del visor (≈ 4.2 × 4.4 km): cuartos de metro (0 = sin dato), con
  // un nodo de margen por lado para calcular las normales sin las vecinas; solo hasta ~1 km del estado
  const { w, h } = F9, T = TILE * FINE, P = T + 3, nx = Math.ceil((W - 1) / TILE), ny = Math.ceil((H - 1) / TILE);
  const near4 = nearState(4), tiles = new Map(), v = new Int32Array(P * P);
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    let any = false;
    for (let j = 0; j < P; j++) for (let i = 0; i < P; i++) {
      const x = tx * T + i - 1, y = ty * T + j - 1;
      const ok = x >= 0 && y >= 0 && x < w && y < h && atNode(near4, x / FINE, y / FINE);
      v[j * P + i] = ok ? Math.max(1, Math.round(fine.data[y * w + x] * 4)) : 0;
      any ||= ok;
    }
    if (any) tiles.set(ty * nx + tx, gz(gradientPlanes(v, P, P)));
  }
  const r = writePack(path.join(DATA, 'relieve-30m.bin'), { kind: 1, tileCells: TILE, nx, ny, px: P, f: FINE }, tiles);
  sizes['relieve-30m.bin'] = r.size;
  log(`relieve de 30 m: ${r.tiles} teselas (de ${nx}×${ny}), ${kb(r.mean)} en promedio`);
}

// vec.bin. Bloque de polilíneas: u32 n | u32 len[n] | i16 dx[N] | i16 dy[N] (deltas dentro de cada línea, ×8)
class Writer {
  constructor() { this.parts = []; this.len = 0; }
  push(b) { this.parts.push(b); this.len += b.length; }
  u32(a) { this.push(Buffer.from(Uint32Array.from(a).buffer)); }
  i16(a) { this.push(Buffer.from(Int16Array.from(a).buffer)); }
  u8(a) { this.push(Buffer.from(Uint8Array.from(a).buffer)); }
  lines(list) {
    const lens = list.map(l => l.length / 2), dx = [], dy = [];
    for (const l of list) for (let k = 0; k < l.length; k += 2) { dx.push(k ? l[k] - l[k - 2] : l[k]); dy.push(k ? l[k + 1] - l[k - 1] : l[k + 1]); }
    this.u32([list.length]); this.u32(lens); this.i16(dx); this.i16(dy);
  }
}
const vw = new Writer();
vw.u32([0x31564852]);   // 'RHV1'
// ríos: polilíneas + área drenada (u8) por punto
vw.lines(hydro.segs.map(s => q8(s.pts)));
vw.u8(hydro.segs.flatMap(s => s.pts.map(p => accByte(p[2]))));
if (vw.len % 2) vw.u8([0]);
// presas y lagos: u32 nLagos | u32 nExt[n] | u32 nInt[n] | anillos (exteriores e interiores en orden)
vw.u32([lakes.length]); vw.u32(lakes.map(L => L.o.length)); vw.u32(lakes.map(L => L.i.length));
vw.lines(lakes.flatMap(L => [...L.o, ...L.i]));
vw.lines(borders.map(q8));
// agregados en la versión 3 (los lectores anteriores se detienen antes): contorno del estado y luces (localidades)
vw.lines(outline.map(q8));
vw.u32([lights.length]);
vw.i16(lights.map(l => Math.round(colOf(l.lon) * 8))); vw.i16(lights.map(l => Math.round(rowOf(l.lat) * 8)));
vw.u32(lights.map(l => l.pob));
save('vec.bin', gz(Buffer.concat(vw.parts)));

// centroides (para volar y para la búsqueda): media de los nodos de cada municipio
const cs = Array.from({ length: NM }, () => [0, 0, 0]);
for (let i = 0; i < W * H; i++) if (muni1[i]) { const c = cs[muni1[i]]; c[0] += i % W; c[1] += Math.floor(i / W); c[2]++; }
const locCount = new Uint32Array(NM);
for (const l of locs) locCount[l.m]++;
const meta = {
  version: 3,
  ...GRID,
  names: feats.map(f => f.properties.NOMGEO),
  codes: feats.map(f => '13' + f.properties.CVE_MUN),
  cent: cs.slice(1).map(([c, r, n]) => [+lonOfCol(c / n).toFixed(4), +latOfRow(r / n).toFixed(4), n]),
  /** por municipio: [alt. mínima, máxima y media (m, a 30 m), área del polígono (km²), localidades, población 2020] */
  mun: relieveMun.map((m, k) => [m.alt_min, m.alt_max, m.alt_media, m.area_km2, locCount[k + 1], munPob.get(k + 1) ?? 0]),
  relief: { min: Math.round(stateMin), max: peak[2], peak },
  riverLabels, lakeLabels, places,
  sources: {
    elevation: RELIEF_CREDIT,
    water: '© colaboradores de OpenStreetMap (ODbL) y red de drenaje calculada del relieve',
    boundaries: 'INEGI, Marco Geoestadístico 2022',
    places: 'INEGI, Censo de Población y Vivienda 2020 (ITER)',
  },
};
save('meta.json', Buffer.from(JSON.stringify(meta)));

const totalArea = areas.reduce((s, a) => s + a, 0);
log(`estado: ${totalArea.toFixed(0)} km² · ${borders.length} tramos de límites · contorno ${outline.length} de ${allOutline.length} anillos · ${lakes.length} presas y lagos (${lakeLabels.length} con nombre) · ${riverLabels.length} ríos con nombre`);
log(Object.entries(sizes).map(([n, b]) => `${n} ${kb(b)}`).join(' · '));
lap('listo');
