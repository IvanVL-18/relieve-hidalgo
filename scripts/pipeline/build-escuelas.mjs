#!/usr/bin/env node
/**
 * Modo escuelas: climas, provincias fisiográficas y sistemas de topoformas de INEGI (1:1 000 000, vía IDEFOR) en la
 * rejilla del visor (factor 2, ≈ 135 m) y las 10 regiones geoculturales (data-src/regiones.json, leídas del mapa de la
 * Secretaría de Cultura del Estado de Hidalgo, 2019).
 *   capas/escuelas.bin   RHZ1: u32 firma · w · h · planos (3) · u8 [3][w·h] (clima, provincia, topoforma; 0 = fuera o sin
 *                        dato), cada plano alineado a 4 bytes; w = (W − 1)·2, h = (H − 1)·2 (bordes = los de la rejilla)
 *   capas/escuelas.json  clases de cada plano con sus km² en Hidalgo, y las regiones con sus municipios, habitantes,
 *                        superficie y el clima, la provincia y la topoforma que más ocupan
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CACHE, GRID, H, LAYERS, META, OUT, ROOT, W, colOf, fillPolygon, kb, log, readJSON, rowOf, writeGz, writeJSON } from './lib.mjs';
import { SOURCES } from './sources.mjs';

const S = 2, w = (W - 1) * S, h = (H - 1) * S;
const toPx = ([lon, lat]) => [colOf(lon) * S, rowOf(lat) * S];
const muni = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'src/relieve/data/muni.bin')));
// municipio de cada pixel (nodo de la rejilla del visor más cercano a su centro)
const muniOf = (x, y) => muni[Math.min(H - 1, Math.round((y + 0.5) / S)) * W + Math.min(W - 1, Math.round((x + 0.5) / S))];
const pxKm2 = (GRID.step / S) ** 2 * 111.32 * Math.cos((20.5 * Math.PI) / 180) * 110.57;

/** Rasteriza un GeoJSON por el valor de key (orden: el de order; lo demás al final). */
function rasterize(file, key, order, skip = () => false) {
  const gj = readJSON(path.join(CACHE, file)), plane = new Uint8Array(w * h), names = [...order];
  for (const f of gj.features) {
    const v = String(f.properties[key] ?? '').trim();
    if (!v || skip(f.properties)) continue;
    let k = names.indexOf(v);
    if (k < 0) { names.push(v); k = names.length - 1; }
    const g = f.geometry;
    if (!g) continue;
    for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) fillPolygon(poly, w, h, toPx, i => { plane[i] = k + 1; });
  }
  // huecos dentro del estado (bordes entre polígonos): el valor del vecino más cercano
  const q = [];
  for (let i = 0; i < w * h; i++) if (plane[i]) q.push(i);
  for (let qh = 0; qh < q.length; qh++) {
    const i = q[qh], x = i % w, y = (i - x) / w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j >= 0 && !plane[j] && muniOf(j % w, Math.floor(j / w))) { plane[j] = plane[i]; q.push(j); }
    }
  }
  // fuera del estado no se dibuja
  for (let i = 0; i < w * h; i++) if (!muniOf(i % w, Math.floor(i / w))) plane[i] = 0;
  return { plane, names };
}

const clima = rasterize(SOURCES.climas.file, 'TIPO_C', ['Cálido húmedo', 'Cálido subhúmedo', 'Semicálido húmedo', 'Semicálido subhúmedo', 'Templado húmedo', 'Templado subhúmedo',
  'Semifrío subhúmedo', 'Frío', 'Semiseco cálido', 'Semiseco semicálido', 'Semiseco templado', 'Seco semicálido', 'Seco templado']);
const prov = rasterize(SOURCES.provincias.file, 'NOMBRE', ['SIERRA MADRE ORIENTAL', 'EJE NEOVOLCÁNICO', 'LLANURA COSTERA DEL GOLFO NORTE', 'MESA DEL CENTRO'], p => p.ENTIDAD !== 'PROVINCIA');
const topo = rasterize(SOURCES.topoformas.file, 'NOMBRE', ['Sierra', 'Lomerío', 'Meseta', 'Valle', 'Llanura', 'Cañón', 'Cuerpo de agua'], p => p.NOMBRE === 'N/a');
// claves de clima de cada tipo (Köppen modificado por García), de la que más ocupa en Hidalgo a la que menos
const tipoDe = new Map();
for (const f of readJSON(path.join(CACHE, SOURCES.climas.file)).features) tipoDe.set(String(f.properties.CLAVE).trim(), String(f.properties.TIPO_C).trim());
const clave = rasterize(SOURCES.climas.file, 'CLAVE', []), areaClave = new Float64Array(clave.names.length + 1);
for (let i = 0; i < w * h; i++) if (clave.plane[i]) areaClave[clave.plane[i]]++;
const claves = new Map();
clave.names.map((n, k) => [n, areaClave[k + 1]]).filter(([, a]) => a > 0).sort((a, b) => b[1] - a[1]).forEach(([n]) => {
  const t = tipoDe.get(n);
  if (!claves.has(t)) claves.set(t, []);
  claves.get(t).push(n);
});

// superficie de cada clase en Hidalgo y por municipio
const count = (p, n) => { const a = new Float64Array(n + 1); for (let i = 0; i < w * h; i++) if (p[i]) a[p[i]] += pxKm2; return a; };
const byMuni = (p, n) => { const a = Array.from({ length: 85 }, () => new Float64Array(n + 1)); for (let i = 0; i < w * h; i++) if (p[i]) a[muniOf(i % w, Math.floor(i / w))][p[i]] += pxKm2; return a; };
const classes = (r, extra = () => ({})) => {
  const a = count(r.plane, r.names.length), sum = a.reduce((s, v) => s + v, 0);
  return r.names.map((n, k) => ({ nombre: n, km2: Math.round(a[k + 1]), pct: +((100 * a[k + 1]) / sum).toFixed(1), ...extra(n) }));
};
const nice = s => s.charAt(0) + s.slice(1).toLowerCase().replace(/del golfo norte/, 'del Golfo Norte').replace(/ oriental/, ' Oriental').replace(/madre/, 'Madre').replace(/neovolcánico/, 'Neovolcánico').replace(/costera/, 'Costera').replace(/ centro/, ' Centro').replace(/mesa/, 'Mesa');
const climaCls = classes(clima, n => ({ claves: claves.get(n) ?? [] }));
const provCls = classes(prov).map(c => ({ ...c, nombre: nice(c.nombre) }));
const topoCls = classes(topo);

// regiones geoculturales
const reg = readJSON(path.join(ROOT, 'data-src/regiones.json'));
const cm = byMuni(clima.plane, clima.names.length), pm = byMuni(prov.plane, prov.names.length), tm = byMuni(topo.plane, topo.names.length);
const top = (rows, ids) => { const s = new Float64Array(rows[0].length); for (const id of ids) rows[id].forEach((v, k) => { s[k] += v; }); let b = 1; for (let k = 2; k < s.length; k++) if (s[k] > s[b]) b = k; return b - 1; };
const seen = new Set();
const regiones = reg.regiones.map(r => {
  const ids = r.municipios.map(n => {
    const i = META.names.indexOf(n);
    if (i < 0) throw new Error(`Municipio desconocido en regiones.json: ${n}`);
    if (seen.has(i)) throw new Error(`Municipio repetido en regiones.json: ${n}`);
    seen.add(i);
    return i + 1;
  });
  return {
    id: r.id, nombre: r.nombre, municipios: ids,
    pob: ids.reduce((s, id) => s + META.mun[id - 1][5], 0), km2: Math.round(ids.reduce((s, id) => s + META.mun[id - 1][3], 0)),
    clima: top(cm, ids), provincia: top(pm, ids), topoforma: top(tm, ids),
  };
});
if (seen.size !== META.names.length) throw new Error(`regiones.json cubre ${seen.size} de ${META.names.length} municipios`);

const MAGIC = 0x315a4852;   // «RHZ1»
const head = Buffer.alloc(16);
head.writeUInt32LE(MAGIC, 0); head.writeUInt32LE(w, 4); head.writeUInt32LE(h, 8); head.writeUInt32LE(3, 12);
const pad4 = b => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const size = writeGz(path.join(LAYERS, 'escuelas.bin'), Buffer.concat([head, pad4(Buffer.from(clima.plane)), pad4(Buffer.from(prov.plane)), pad4(Buffer.from(topo.plane))]));
writeJSON(path.join(LAYERS, 'escuelas.json'), {
  fuentes: { clima: SOURCES.climas.fuente, provincia: SOURCES.provincias.fuente, topoforma: SOURCES.topoformas.fuente, regiones: reg.fuente },
  nota: reg.nota, clima: climaCls, provincia: provCls, topoforma: topoCls, regiones,
});
writeJSON(path.join(OUT, 'regiones_geoculturales.json'), regiones.flatMap(r => r.municipios.map(m => ({ cve_mun: m, municipio: META.names[m - 1], region_id: r.id, region: r.nombre }))).sort((a, b) => a.cve_mun - b.cve_mun));
log(`capas/escuelas.bin ${kb(size)} (${w}×${h}); climas en Hidalgo: ${climaCls.filter(c => c.km2 > 0).map(c => `${c.nombre} ${c.pct} %`).join(', ')}`);
log(`provincias: ${provCls.filter(c => c.km2 > 0).map(c => `${c.nombre} ${c.pct} %`).join(', ')}`);
log(`topoformas: ${topoCls.filter(c => c.km2 > 0).map(c => `${c.nombre} ${c.pct} %`).join(', ')}`);
for (const r of regiones) log(`${r.nombre}: ${r.municipios.length} municipios, ${r.pob.toLocaleString('es-MX')} hab., ${r.km2} km²; clima ${climaCls[r.clima].nombre}, ${provCls[r.provincia].nombre}, ${topoCls[r.topoforma].nombre}`);
