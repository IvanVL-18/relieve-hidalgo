#!/usr/bin/env node
/**
 * Empaqueta los datos del relieve en los archivos que carga el visor.
 *
 * Entrada
 *   data-src/relief_v2.json            salida de scripts/python/build_relief.py (DEM SRTM, municipios, OSM)
 *   data-src/cache/inegi_hidalgo_2022.json  municipios INEGI (se descarga si falta)
 *
 * Salida (src/relieve/data/)
 *   meta.json  georreferencia, nombres, localidades, etiquetas
 *   elev.bin   elevación en metros: residuo del predictor de gradiente (L + U − UL),
 *              bytes bajos y luego altos, gzip
 *   muni.bin   municipio por celda (0 = fuera de Hidalgo), gzip
 *   vec.bin    ríos, presas y límites municipales en coordenadas de celda × 8, gzip
 *
 * Uso: npm run data   (o node scripts/pack-data.mjs [relief.json] [inegi.geojson])
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reliefPath = process.argv[2] || path.join(root, 'data-src/relief_v2.json');
const geoPath = process.argv[3] || path.join(root, 'data-src/cache/inegi_hidalgo_2022.json');
const GEO_URL = 'https://raw.githubusercontent.com/PhantomInsights/mexico-geojson/main/2022/states/Hidalgo.json';
const outDir = path.join(root, 'src/relieve/data');
fs.mkdirSync(outDir, { recursive: true });

const gz = buf => zlib.gzipSync(buf, { level: 9 });
const gunzipB64 = s => zlib.gunzipSync(Buffer.from(s, 'base64'));

// ---------- entrada ----------
let relief;
const raw = fs.readFileSync(reliefPath, 'utf8');
if (reliefPath.endsWith('.html')) {
  // también acepta el HTML del artefacto, que trae los mismos datos en `const DATA = {...};`
  const m = raw.match(/const DATA = (\{.*?\});\n/s);
  if (!m) throw new Error('No encontré `const DATA` en el HTML');
  relief = JSON.parse(m[1]);
} else relief = JSON.parse(raw);
const meta = relief.meta;
const { W, H } = meta;

// ---------- elevación ----------
const rowDelta = new Int16Array(new Uint8Array(gunzipB64(relief.elev)).buffer.slice(0));
const elev = new Int32Array(W * H);
for (let r = 0; r < H; r++) { let a = 0; for (let c = 0; c < W; c++) { a += rowDelta[r * W + c]; elev[r * W + c] = a; } }
const at = (r, c) => (r < 0 || c < 0 ? 0 : elev[r * W + c]);
const resid = new Int16Array(W * H);
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) resid[r * W + c] = elev[r * W + c] - (at(r, c - 1) + at(r - 1, c) - at(r - 1, c - 1));
const rb = new Uint8Array(resid.buffer), planes = new Uint8Array(W * H * 2);
for (let i = 0; i < W * H; i++) { planes[i] = rb[2 * i]; planes[W * H + i] = rb[2 * i + 1]; }
const elevBin = gz(planes);

// ---------- municipios ----------
const muniBin = gz(gunzipB64(relief.muni));

// ---------- límites municipales (INEGI) ----------
async function loadGeo() {
  if (!fs.existsSync(geoPath)) {
    console.log('Descargando municipios INEGI…', GEO_URL);
    const res = await fetch(GEO_URL);
    if (!res.ok) throw new Error('No se pudo descargar el GeoJSON: ' + res.status);
    fs.mkdirSync(path.dirname(geoPath), { recursive: true });
    fs.writeFileSync(geoPath, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(fs.readFileSync(geoPath, 'utf8'));
}
const geo = await loadGeo();
const toCR = ([lon, lat]) => [(lon - meta.lon0) / meta.step, (meta.lat0 - lat) / meta.step];

// Cada tramo compartido entre dos municipios se guarda una sola vez: se arma la topología por aristas.
const key = p => p[0].toFixed(7) + ',' + p[1].toFixed(7);
const coords = new Map(), edges = new Map();
for (const f of geo.features) {
  const g = f.geometry, polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys) for (const ring of poly) for (let k = 0; k + 1 < ring.length; k++) {
    const a = key(ring[k]), b = key(ring[k + 1]);
    if (a === b) continue;
    coords.set(a, ring[k]); coords.set(b, ring[k + 1]);
    const ek = a < b ? a + '|' + b : b + '|' + a;
    edges.set(ek, (edges.get(ek) || 0) + 1);
  }
}
const adj = new Map();
let shared = 0;
for (const [ek, n] of edges) {
  if (n < 2) continue;            // borde exterior del estado: lo dibujan las paredes del modelo
  shared++;
  const [a, b] = ek.split('|');
  (adj.get(a) || adj.set(a, []).get(a)).push(b);
  (adj.get(b) || adj.set(b, []).get(b)).push(a);
}
const used = new Set();
const ekOf = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
const chains = [];
function walk(start, next) {
  const out = [start];
  let prev = start, cur = next;
  used.add(ekOf(prev, cur));
  for (;;) {
    out.push(cur);
    const nb = adj.get(cur);
    if (nb.length !== 2) break;
    const nx = nb[0] === prev ? nb[1] : nb[0];
    if (used.has(ekOf(cur, nx))) break;
    used.add(ekOf(cur, nx));
    prev = cur; cur = nx;
  }
  return out;
}
for (const [v, nb] of adj) if (nb.length !== 2) for (const n of nb) if (!used.has(ekOf(v, n))) chains.push(walk(v, n));
for (const [v, nb] of adj) for (const n of nb) if (!used.has(ekOf(v, n))) chains.push(walk(v, n));   // anillos cerrados

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
const borders = chains.map(ch => simplify(ch.map(k => toCR(coords.get(k))), 0.08));
const borderPts = borders.reduce((s, b) => s + b.length, 0);

// ---------- ríos y presas ----------
const vec = JSON.parse(gunzipB64(relief.vec).toString('utf8'));

// ---------- vec.bin ----------
// Bloque de polilíneas: u32 n | u32 len[n] | i16 dx[N] | i16 dy[N]  (deltas dentro de cada línea, ×8)
class Writer {
  constructor() { this.parts = []; }
  u32(arr) { this.parts.push(Buffer.from(Uint32Array.from(arr).buffer)); }
  i16(arr) { this.parts.push(Buffer.from(Int16Array.from(arr).buffer)); }
  u8(arr) { this.parts.push(Buffer.from(Uint8Array.from(arr).buffer)); }
  lines(list) {   // list: arrays planos [x0, y0, x1, y1, …] ya en unidades ×8
    const lens = list.map(l => l.length / 2), dx = [], dy = [];
    for (const l of list) for (let k = 0; k < l.length; k += 2) {
      dx.push(k ? l[k] - l[k - 2] : l[k]); dy.push(k ? l[k + 1] - l[k - 1] : l[k + 1]);
    }
    this.u32([list.length]); this.u32(lens); this.i16(dx); this.i16(dy);
  }
  buffer() { return Buffer.concat(this.parts); }
}
const w = new Writer();
w.u32([0x31564852]);   // 'RHV1'
// ríos: polilíneas + acumulación (u8) por punto
w.lines(vec.rivers.map(f => f.filter((_, i) => i % 3 !== 2)));
w.u8(vec.rivers.flatMap(f => f.filter((_, i) => i % 3 === 2)));
if (w.parts.reduce((s, p) => s + p.length, 0) % 2) w.u8([0]);   // alinear
// presas y lagos: u32 nLagos | u32 nExt[n] | u32 nInt[n] | anillos (exteriores e interiores en orden)
w.u32([vec.lakes.length]); w.u32(vec.lakes.map(L => L.o.length)); w.u32(vec.lakes.map(L => L.i.length));
w.lines(vec.lakes.flatMap(L => [...L.o, ...L.i]));
// límites municipales
w.lines(borders.map(b => b.flatMap(([c, r]) => [Math.round(c * 8), Math.round(r * 8)])));
const vecBin = gz(w.buffer());

// ---------- meta ----------
const metaOut = {
  version: 2,
  W, H, step: meta.step, lon0: meta.lon0, lat0: meta.lat0,
  names: meta.names, codes: meta.codes, cent: meta.cent,
  riverLabels: meta.riverLabels, lakeLabels: meta.lakeLabels, places: meta.places,
  sources: {
    elevation: 'SRTM vía Terrain Tiles (AWS Open Data)',
    water: '© colaboradores de OpenStreetMap (ODbL) y red de drenaje calculada del relieve',
    boundaries: 'INEGI, Marco Geoestadístico 2022',
  },
};

fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(metaOut));
fs.writeFileSync(path.join(outDir, 'elev.bin'), elevBin);
fs.writeFileSync(path.join(outDir, 'muni.bin'), muniBin);
fs.writeFileSync(path.join(outDir, 'vec.bin'), vecBin);

const kb = n => (n / 1024).toFixed(0) + ' KB';
console.log(`rejilla ${W}×${H}, elevación ${elev.reduce((a, b) => Math.min(a, b))}–${elev.reduce((a, b) => Math.max(a, b))} m`);
console.log(`límites: ${shared} aristas compartidas de ${edges.size}, ${chains.length} tramos, ${borderPts} puntos tras simplificar`);
console.log(`elev.bin ${kb(elevBin.length)} · muni.bin ${kb(muniBin.length)} · vec.bin ${kb(vecBin.length)} · meta.json ${kb(JSON.stringify(metaOut).length)}`);
