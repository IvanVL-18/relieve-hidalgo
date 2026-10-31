#!/usr/bin/env node
/**
 * Edificios (Microsoft, Global ML Building Footprints, ODbL): las huellas detectadas en imágenes de satélite de Hidalgo
 * y ~800 m alrededor, en un paquete de teselas que el visor lee por partes al acercarse.
 *   capas/edificios.bin   RHP1 tipo 3, teselas de 16 × 16 celdas de la rejilla del visor (≈ 4.3 km) alineadas con las del
 *                         relieve de 30 m. Cada una, gzip de: u32 n · u8 vértices[n] · u8 altura[n] (m × 4) · u16 x, y del
 *                         primer vértice de cada edificio · i16 dx, dy de los demás (desde el vértice anterior).
 *                         Coordenadas en 1/3600 de celda desde (tx·16 − 1, ty·16 − 1): caben las huellas que se salen de
 *                         su tesela hasta una celda. Anillo sin repetir el primer vértice y en sentido horario en (x este,
 *                         z sur): así las paredes miran hacia afuera y el techo hacia arriba.
 *   data-src/out/edificios_municipios.json   edificios, km² de huellas y altura media estimada por municipio
 * Las huellas de México no traen altura: se estima con el área de la huella y la densidad de edificios alrededor (los
 * núcleos urbanos tienen más casas de dos y tres pisos), con una variación al azar fija por edificio. El visor lo dice.
 *   node scripts/pipeline/build-edificios.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { CACHE, H, LAT0, LAYERS, LON0, OUT, ROOT, STEP, W, kb, log, writeJSON, writePack } from './lib.mjs';
import { KX, KZ, TILE } from './dem.mjs';

const DIR = path.join(CACHE, 'edificios');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith('.csv.gz')).sort() : [];
if (!files.length) throw new Error('Faltan las huellas de edificios: corre pnpm data:fetch edificios');

// Hidalgo y ~800 m alrededor (municipios de 270 m del visor, dilatados 3 celdas)
const muni = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'src/relieve/data/muni.bin')));
const R = 3, near = new Uint8Array(W * H);
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
  if (!muni[r * W + c]) continue;
  for (let j = Math.max(0, r - R); j <= Math.min(H - 1, r + R); j++) for (let i = Math.max(0, c - R); i <= Math.min(W - 1, c + R); i++) near[j * W + i] = 1;
}
const colOf = lon => (lon - LON0) / STEP, rowOf = lat => (LAT0 - lat) / STEP;
const cellM2 = STEP * KX * 1000 * STEP * KZ * 1000;

/** Douglas–Peucker sobre un anillo abierto (en metros) hasta tolerancia tol. */
function simplify(pts, tol) {
  const n = pts.length, keep = new Uint8Array(n);
  keep[0] = keep[n >> 1] = 1;
  const rec = (a, b) => {
    const [ax, ay] = pts[a], [bx, by] = pts[b % n], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let best = -1, bd = tol;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / L;
      if (d > bd) { bd = d; best = k; }
    }
    if (best >= 0) { keep[best] = 1; rec(a, best); rec(best, b); }
  };
  rec(0, n >> 1);
  rec(n >> 1, n);
  return pts.filter((_, k) => keep[k]);
}

// 1) lectura en flujo: el primer vértice decide si vale la pena interpretar el renglón (la mitad cae en la Ciudad de México)
const raw = [];   // [gx0, gz0, …] de cada edificio en celdas del visor (anillo abierto)
let lines = 0, kept = 0, skipped = 0;
const t0 = Date.now();
for (const f of files) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(DIR, f)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    lines++;
    const i = line.indexOf('[[[');
    if (i < 0) continue;
    const j = line.indexOf(',', i), k = line.indexOf(']', j);
    const lon = +line.slice(i + 3, j), lat = +line.slice(j + 1, k);
    const c = Math.round(colOf(lon)), r = Math.round(rowOf(lat));
    if (c < 0 || r < 0 || c >= W || r >= H || !near[r * W + c]) continue;
    let g;
    try { g = JSON.parse(line).geometry; } catch { skipped++; continue; }
    if (g?.type !== 'Polygon') { skipped++; continue; }
    const ring = g.coordinates[0];
    const pts = ring.slice(0, ring.length - 1).map(([x, y]) => [colOf(x), rowOf(y)]);
    if (pts.length < 3) { skipped++; continue; }
    raw.push(pts);
    kept++;
  }
  log(`  ${f}: ${lines.toLocaleString('es-MX')} renglones leídos, ${kept.toLocaleString('es-MX')} edificios en la zona`);
}
log(`lectura: ${((Date.now() - t0) / 1000).toFixed(0)} s, ${skipped} descartados por forma`);

// 2) área, centro, sentido y simplificación (en metros: x al este, z al sur)
const mx = STEP * KX * 1000, mz = STEP * KZ * 1000;
const items = [];
const density = new Uint16Array(W * H);
for (const pts of raw) {
  let m = pts.map(([x, z]) => [x * mx, z * mz]);
  // orientación: área con signo (shoelace) en (x, z); se quiere horario (negativa)
  let a = 0;
  for (let k = 0; k < m.length; k++) { const [x0, z0] = m[k], [x1, z1] = m[(k + 1) % m.length]; a += x0 * z1 - x1 * z0; }
  a /= 2;
  const area = Math.abs(a);
  if (area < 12) continue;   // ruido de la detección
  if (a > 0) m.reverse();
  for (let tol = 0.4; m.length > 12 && tol < 8; tol *= 1.6) m = simplify(m, tol);
  if (m.length > 16 || m.length < 3) continue;
  let cx = 0, cz = 0;
  for (const [x, z] of m) { cx += x; cz += z; }
  cx /= m.length * mx; cz /= m.length * mz;
  const ci = Math.round(cx), ri = Math.round(cz);
  if (ci < 0 || ri < 0 || ci >= W || ri >= H) continue;
  density[ri * W + ci]++;
  items.push({ pts: m.map(([x, z]) => [x / mx, z / mz]), area, cx, cz });
}

// 3) altura estimada: densidad suavizada (3 × 3 celdas, edificios por km²) → núcleo urbano; pisos al azar fijo por edificio
const dens = new Float32Array(W * H);
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
  let s = 0, n = 0;
  for (let j = Math.max(0, r - 1); j <= Math.min(H - 1, r + 1); j++) for (let i = Math.max(0, c - 1); i <= Math.min(W - 1, c + 1); i++) { s += density[j * W + i]; n++; }
  dens[r * W + c] = s / n / (cellM2 / 1e6);
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Número al azar fijo en [0, 1) a partir de la posición. */
const hash = (x, z) => { let h = Math.imul(Math.round(x * 3600) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(z * 3600), 0xc2b2ae35); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; return (h >>> 0) / 4294967296; };
function heightOf(it) {
  const urban = smooth(500, 2600, dens[Math.round(it.cz) * W + Math.round(it.cx)]), u = hash(it.cx, it.cz), v = hash(it.cz + 7.1, it.cx - 3.3);
  const A = it.area;
  let floors;
  if (A < 35) floors = 1;                                           // cuartos, bodegas, baños
  else if (A < 450) floors = u < 0.05 + 0.25 * urban ? 3 : u < 0.2 + 0.5 * urban ? 2 : 1;   // casas
  else if (A < 2500) floors = u < 0.1 + 0.3 * urban ? 3 : 2;      // comercios, escuelas, edificios
  else floors = 2.6 + 0.8 * u;                                      // naves industriales y tiendas grandes (un piso alto)
  return Math.min(40, floors * 2.9 + 0.3 + (v - 0.5) * 0.8);
}

// 4) teselas: edificio en la tesela de su centro; orden por renglón y columna (deltas chicos, comprime mejor)
const nx = Math.ceil((W - 1) / TILE), ny = Math.ceil((H - 1) / TILE), Q = 3600;
const byTile = new Map();
for (const it of items) {
  const tx = Math.min(nx - 1, Math.floor(it.cx / TILE)), ty = Math.min(ny - 1, Math.floor(it.cz / TILE));
  const k = ty * nx + tx;
  if (!byTile.has(k)) byTile.set(k, []);
  byTile.get(k).push(it);
}
const tiles = new Map();
const perMuni = new Map();
let total = 0, outside = 0, vtx = 0, hSum = 0;
for (const [k, list] of byTile) {
  const tx = k % nx, ty = Math.floor(k / nx), ox = tx * TILE - 1, oz = ty * TILE - 1;
  list.sort((a, b) => a.cz - b.cz || a.cx - b.cx);
  const ok = list.filter(it => it.pts.every(([x, z]) => x >= ox && z >= oz && x < ox + 18 && z < oz + 18));
  outside += list.length - ok.length;
  const n = ok.length, nv = new Uint8Array(n), hh = new Uint8Array(n), first = new Uint16Array(n * 2), rest = [];
  ok.forEach((it, b) => {
    const q = it.pts.map(([x, z]) => [Math.round((x - ox) * Q), Math.round((z - oz) * Q)]);
    nv[b] = q.length;
    const hm = heightOf(it);
    hh[b] = Math.min(255, Math.round(hm * 4));
    first[b * 2] = q[0][0]; first[b * 2 + 1] = q[0][1];
    for (let v = 1; v < q.length; v++) rest.push(q[v][0] - q[v - 1][0], q[v][1] - q[v - 1][1]);
    vtx += q.length; hSum += hm;
    const m = muni[Math.round(it.cz) * W + Math.round(it.cx)];
    if (m) { const s = perMuni.get(m) ?? { n: 0, km2: 0, h: 0 }; s.n++; s.km2 += it.area / 1e6; s.h += hm; perMuni.set(m, s); }
  });
  total += n;
  const head = Buffer.alloc(4);
  head.writeUInt32LE(n);
  const pad = (b, a) => Buffer.concat([b, Buffer.alloc((a - (b.length % a)) % a)]);
  // u32 n · u8 vértices · u8 alturas (alineado a 2) · u16 primeros vértices · i16 deltas
  const body = Buffer.concat([head, pad(Buffer.concat([Buffer.from(nv), Buffer.from(hh)]), 2), Buffer.from(first.buffer), Buffer.from(Int16Array.from(rest).buffer)]);
  tiles.set(k, zlib.gzipSync(body, { level: 9 }));
}
const r = writePack(path.join(LAYERS, 'edificios.bin'), { kind: 3, tileCells: TILE, nx, ny, px: Q, f: 1 }, tiles);
log(`edificios.bin ${kb(r.size)}: ${total.toLocaleString('es-MX')} edificios en ${r.tiles} teselas (${kb(r.mean)} en promedio), ${(vtx / total).toFixed(1)} vértices por edificio, altura media estimada ${(hSum / total).toFixed(1)} m; ${outside} fuera de su tesela`);

const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/relieve/data/meta.json'), 'utf8'));
const rows = [...perMuni].sort((a, b) => a[0] - b[0]).map(([m, s]) => ({ cve_mun: m, edificios: s.n, km2_huellas: +s.km2.toFixed(3), altura_media_estimada_m: +(s.h / s.n).toFixed(1) }));
writeJSON(path.join(OUT, 'edificios_municipios.json'), rows);
const inState = rows.reduce((s, x) => s + x.edificios, 0), top = [...rows].sort((a, b) => b.edificios - a.edificios).slice(0, 5);
log(`en Hidalgo: ${inState.toLocaleString('es-MX')} edificios; más: ${top.map(x => `${meta.names[x.cve_mun - 1]} ${x.edificios.toLocaleString('es-MX')}`).join(', ')}`);
