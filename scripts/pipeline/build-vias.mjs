#!/usr/bin/env node
/**
 * Red vial de OpenStreetMap → grafo con tiempos de recorrido y tiempos de cada localidad a cada servicio.
 *
 * Velocidad = velocidad base por tipo de vía (ROAD_CLASSES), limitada por maxspeed si existe,
 *   × 0.7 si no está pavimentada (salvo terracerías, que ya son lentas). Sin calles urbanas (ver CLASS_OF).
 *   × factor de terreno: 1 − 0.25·(sinuosidad − 1) − 0.8·pendiente media, entre 0.7 y 1 (la pendiente se mide
 *     sobre un relieve de 250 m, que exagera el sube y baja de los caminos que siguen curvas de nivel).
 * Son tiempos estimados en flujo libre, sin tráfico ni semáforos.
 *
 * vias.bin (gzip, RHG1): u32 magic · u32 nNodos · u32 nAristas · u32 nPuntos
 *   u16 nx[n] · u16 ny[n] (rejilla × 8) · u32 ea[m] · u32 eb[m] · u16 tiempo[m] (×0.5 s) · u16 largo[m] (×2 m)
 *   u8 clase[m] · u16 nombre[m] · u16 nPuntos[m] · i8 dx[p] · i8 dy[p] (desde el nodo a; el primero es 0,0)
 *   u32 bytes · nombres separados por \n (el 0 es vacío)
 * out/acceso_localidades.json  minutos de cada localidad al servicio más cercano (públicos) para la base de datos
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { BinWriter, CACHE, H, KX, KZ, LAYERS, OUT, ROOT, STEP, W, colOf, kb, log, readJSON, rowOf, writeGz, writeJSON } from './lib.mjs';
import { SOURCES } from './sources.mjs';
import { decodeElev } from '../../src/relieve/worker/decode.ts';
import { ROAD_CLASSES, WALK_KMH, buildAdjacency, dijkstra, nodeIndex } from '../../src/relieve/shared/routing.ts';
import { SERVICE_TYPES } from '../../src/relieve/shared/servicios.ts';

const CLASS_OF = {
  motorway: 0, motorway_link: 0, trunk: 1, trunk_link: 1, primary: 2, primary_link: 2, secondary: 3, secondary_link: 3,
  tertiary: 4, tertiary_link: 4, unclassified: 5, road: 5, track: 6,
};
// Las calles urbanas (residential, living_street) son ~80 % de las vías de OSM y casi no cambian el tiempo a un
// servicio: se omiten para que la red quepa en el navegador; el último tramo se estima desde el camino más cercano.
const UNPAVED = /^(unpaved|dirt|gravel|ground|earth|sand|mud|compacted|fine_gravel|grass)$/;
const MAX_EDGE_M = 600;

const elev = decodeElev(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'src/relieve/data/elev.bin')))), W, H);
const elevAt = (lon, lat) => {
  const fr = Math.max(0, Math.min(H - 1.001, rowOf(lat))), fc = Math.max(0, Math.min(W - 1.001, colOf(lon)));
  const r = Math.floor(fr), c = Math.floor(fc), tr = fr - r, tc = fc - c, i = r * W + c;
  return (elev[i] * (1 - tc) + elev[i + 1] * tc) * (1 - tr) + (elev[i + W] * (1 - tc) + elev[i + W + 1] * tc) * tr;
};
const km = (a, b) => Math.hypot((b.lon - a.lon) * KX, (b.lat - a.lat) * KZ);
const inGrid = p => { const c = colOf(p.lon), r = rowOf(p.lat); return c >= 0 && r >= 0 && c <= W - 1 && r <= H - 1; };

log('leyendo OpenStreetMap…');
// argumento opcional: otro archivo de Overpass (p. ej. una unión parcial de cuadrantes para pruebas)
const osm = JSON.parse(fs.readFileSync(process.argv[2] || path.join(CACHE, SOURCES.vias.file), 'utf8'));
const ways = osm.elements.filter(e => e.type === 'way' && CLASS_OF[e.tags?.highway] !== undefined && e.geometry?.length >= 2);
log(`${ways.length} vías`);

// vértices del grafo: nodos compartidos por varias vías o extremos de vía
const uses = new Map();
for (const w of ways) w.nodes.forEach((id, k) => uses.set(id, (uses.get(id) || 0) + (k === 0 || k === w.nodes.length - 1 ? 2 : 1)));

const nodeIdx = new Map(), nodePos = [];
const vertex = (id, p) => { let v = nodeIdx.get(id); if (v === undefined) { v = nodePos.length; nodeIdx.set(id, v); nodePos.push(p); } return v; };
const names = [''], nameIdx = new Map([['', 0]]);
const nameOf = t => {
  const ref = (t.ref || '').replace(/;/g, ' / ').trim(), name = (t.name || '').trim();
  const s = ref && name ? `${name} (${ref})` : ref || name;
  if (!nameIdx.has(s)) { nameIdx.set(s, names.length); names.push(s); }
  return nameIdx.get(s);
};

const edges = [];
for (const w of ways) {
  const t = w.tags, cls = CLASS_OF[t.highway], spec = ROAD_CLASSES[cls];
  let kmh = spec.kmh;
  const ms = parseFloat(t.maxspeed);
  if (ms > 5 && ms < 130) kmh = Math.min(kmh * 1.15, ms);
  if (cls < 6 && UNPAVED.test(t.surface || '')) kmh *= 0.7;
  const nm = nameOf(t);
  let pts = [w.geometry[0]], ids = [w.nodes[0]], acc = 0;
  for (let k = 1; k < w.nodes.length; k++) {
    const p = w.geometry[k];
    acc += km(pts[pts.length - 1], p) * 1000;
    pts.push(p); ids.push(w.nodes[k]);
    const last = k === w.nodes.length - 1;
    if (last || uses.get(w.nodes[k]) > 1 || acc > MAX_EDGE_M) {
      if (pts.every(inGrid)) edges.push({ a: ids[0], b: ids[ids.length - 1], pts, cls, kmh, nm });
      pts = [p]; ids = [w.nodes[k]]; acc = 0;
    }
  }
}

// tiempo por arista con pendiente y sinuosidad del relieve
const E = edges.map(e => {
  let L = 0, climb = 0, prev = elevAt(e.pts[0].lon, e.pts[0].lat);
  for (let k = 1; k < e.pts.length; k++) {
    L += km(e.pts[k - 1], e.pts[k]);
    const z = elevAt(e.pts[k].lon, e.pts[k].lat);
    climb += Math.abs(z - prev); prev = z;
  }
  const straight = km(e.pts[0], e.pts[e.pts.length - 1]);
  const sinuosity = L > 0.2 && straight > 0.01 ? Math.min(3, L / straight) : 1;
  const grade = L > 0 ? climb / (L * 1000) : 0;
  const f = Math.max(0.7, Math.min(1, 1 - 0.25 * (sinuosity - 1) - 0.8 * grade));
  return { ...e, m: L * 1000, s: (L / (e.kmh * f)) * 3600 };
});

// se descartan las islas pequeñas (tramos sueltos sin conexión)
for (const e of E) { e.va = vertex(e.a, e.pts[0]); e.vb = vertex(e.b, e.pts[e.pts.length - 1]); }
const parent = Int32Array.from({ length: nodePos.length }, (_, i) => i);
const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
for (const e of E) parent[find(e.va)] = find(e.vb);
const compSize = new Map();
for (let i = 0; i < nodePos.length; i++) compSize.set(find(i), (compSize.get(find(i)) || 0) + 1);
const keepE = E.filter(e => e.va !== e.vb && compSize.get(find(e.va)) >= 50);
const remap = new Int32Array(nodePos.length).fill(-1);
let nNodes = 0;
for (const e of keepE) for (const v of [e.va, e.vb]) if (remap[v] < 0) remap[v] = nNodes++;
log(`grafo: ${nNodes} nodos, ${keepE.length} aristas (de ${E.length}), ${names.length} nombres`);

// coordenadas en rejilla × 8
const gx = p => Math.round(colOf(p.lon) * 8), gy = p => Math.round(rowOf(p.lat) * 8);
const nx = new Uint16Array(nNodes), ny = new Uint16Array(nNodes);
for (let v = 0; v < nodePos.length; v++) if (remap[v] >= 0) { nx[remap[v]] = gx(nodePos[v]); ny[remap[v]] = gy(nodePos[v]); }

function simplify(p, tol) {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length); keep[0] = keep[p.length - 1] = 1;
  const st = [[0, p.length - 1]];
  while (st.length) {
    const [i0, i1] = st.pop(), [ax, ay] = p[i0], [bx, by] = p[i1], dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy);
    let best = -1, bi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = l === 0 ? Math.hypot(p[i][0] - ax, p[i][1] - ay) : Math.abs(dx * (p[i][1] - ay) - dy * (p[i][0] - ax)) / l;
      if (d > best) { best = d; bi = i; }
    }
    if (best > tol) { keep[bi] = 1; st.push([i0, bi], [bi, i1]); }
  }
  return p.filter((_, i) => keep[i]);
}

const ea = [], eb = [], et = [], el = [], ec = [], en = [], gl = [], dx = [], dy = [];
for (const e of keepE) {
  const a = remap[e.va], b = remap[e.vb];
  let p = simplify(e.pts.map(q => [colOf(q.lon) * 8, rowOf(q.lat) * 8]), 1.2).map(([x, y]) => [Math.round(x), Math.round(y)]);
  p[0] = [nx[a], ny[a]]; p[p.length - 1] = [nx[b], ny[b]];
  // densificar: pasos de máximo 12 unidades (1.5 celdas) para que la línea siga el relieve y quepa en i8
  const dense = [p[0]];
  for (let k = 1; k < p.length; k++) {
    const [x0, y0] = dense[dense.length - 1], [x1, y1] = p[k], n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 12);
    for (let s = 1; s <= n; s++) dense.push([Math.round(x0 + ((x1 - x0) * s) / n), Math.round(y0 + ((y1 - y0) * s) / n)]);
  }
  ea.push(a); eb.push(b); et.push(Math.min(65535, Math.round(e.s * 2))); el.push(Math.min(65535, Math.round(e.m / 2)));
  ec.push(e.cls); en.push(Math.min(65535, e.nm)); gl.push(dense.length);
  for (let k = 0; k < dense.length; k++) { dx.push(k ? dense[k][0] - dense[k - 1][0] : 0); dy.push(k ? dense[k][1] - dense[k - 1][1] : 0); }
}

const bw = new BinWriter();
bw.u32([0x31474852, nNodes, ea.length, dx.length]);
bw.u16(nx); bw.u16(ny); bw.u32(ea); bw.u32(eb); bw.u16(et); bw.u16(el); bw.u8(ec); bw.u16(en); bw.u16(gl);
bw.push(Buffer.from(Int8Array.from(dx).buffer)); bw.push(Buffer.from(Int8Array.from(dy).buffer));
bw.str(names);
log(`vias.bin ${kb(writeGz(path.join(LAYERS, 'vias.bin'), bw.buffer()))} (${dx.length} puntos de dibujo)`);

// grafo para la base de datos (lista para pgRouting)
const nodosOut = new Array(nNodes);
for (let v = 0; v < nodePos.length; v++) if (remap[v] >= 0) nodosOut[remap[v]] = [+nodePos[v].lon.toFixed(6), +nodePos[v].lat.toFixed(6)];
writeJSON(path.join(OUT, 'vias_nodos.json'), nodosOut);
writeJSON(path.join(OUT, 'vias_aristas.json'), keepE.map((e, k) => [ea[k], eb[k], ROAD_CLASSES[e.cls].id, names[e.nm], Math.round(e.m), Math.round(e.s)]));

/* ---------- tiempos de cada localidad al servicio más cercano (para la base de datos) ---------- */
const g = { nNodes, nEdges: ea.length, nx, ny, ea: Uint32Array.from(ea), eb: Uint32Array.from(eb), et: Float32Array.from(et, v => v * 0.5) };
Object.assign(g, buildAdjacency(nNodes, g.ea, g.eb));
const nearest = nodeIndex(g, W, H);
const walkS = (x, y, v) => (Math.hypot(((x - nx[v]) / 8) * STEP * KX, ((y - ny[v]) / 8) * STEP * KZ) / WALK_KMH) * 3600;
const snap = (lon, lat) => { const x = colOf(lon) * 8, y = rowOf(lat) * 8, v = nearest(x, y); return v < 0 ? null : { v, s: walkS(x, y, v) }; };
const servicios = readJSON(path.join(OUT, 'servicios.json'));
const locs = readJSON(path.join(OUT, 'localidades.json'));
const locSnap = locs.map(l => snap(l.lon, l.lat));
const acceso = locs.map(l => ({ cvegeo: l.cvegeo }));
for (const t of SERVICE_TYPES) {
  const src = servicios.filter(s => s.tipo === t.id && s.publico).map(s => snap(s.lon, s.lat)).filter(Boolean);
  const { dist } = dijkstra(g, src.map(s => s.v), src.map(s => s.s));
  let far = 0;
  locs.forEach((l, i) => {
    const sn = locSnap[i];
    const min = sn ? (dist[sn.v] + sn.s) / 60 : null;
    acceso[i][t.id] = min !== null && Number.isFinite(min) ? Math.round(min) : null;
    if (min > 60) far += l.pob;
  });
  log(`${t.plural.padEnd(16)} públicos: ${String(src.length).padStart(4)} · población a más de 60 min: ${far.toLocaleString('es-MX')}`);
}
writeJSON(path.join(OUT, 'acceso_localidades.json'), acceso);
