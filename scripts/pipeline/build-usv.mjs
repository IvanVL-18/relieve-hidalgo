#!/usr/bin/env node
/**
 * Uso del suelo y vegetación (INEGI Serie VII) → rejilla de clases a 4 veces la resolución del relieve (≈ 65 m). El visor
 * dibuja los bordes entre clases suavizados (sin escalones), así que la orilla sigue al polígono con ~30 m de error.
 *   capas/usv.bin   gzip: u32 'RHU1' · u32 w · u32 h · u8 clase[w·h] (0 = sin dato)
 *   capas/usv.json  clases [{ clave, nombre, grupo, sec }]
 *   out/usv_municipios.json  % de cada grupo por municipio · out/usv_poligonos.json  polígonos para la base de datos
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CACHE, H, LAYERS, OUT, ROOT, W, colOf, fillPolygon, kb, log, rowOf, writeGz, writeJSON } from './lib.mjs';
import { SOURCES } from './sources.mjs';
import { USV_GROUPS, usvGroupOf } from '../../src/relieve/shared/usv.ts';

const geo = JSON.parse(fs.readFileSync(path.join(CACHE, SOURCES.usv.file), 'utf8'));
const S = 4, w = (W - 1) * S, h = (H - 1) * S;
const sentence = s => s.charAt(0) + s.slice(1).toLowerCase().replace(/\bvegetacion\b/g, 'vegetación');

// clases por frecuencia (índice 1…n; 0 = sin dato)
const freq = new Map();
for (const f of geo.features) freq.set(f.properties.CLAVE, f.properties.DESCRIPCIO);
const claves = [...freq.keys()].sort();
if (claves.length > 255) throw new Error('demasiadas clases');
const clases = claves.map(k => { const g = usvGroupOf(k); return { clave: k, nombre: sentence(freq.get(k).trim()), grupo: g.group, sec: g.secondary }; });
const idx = new Map(claves.map((k, i) => [k, i + 1]));

const raster = new Uint8Array(w * h);
const toPx = ([lon, lat]) => [colOf(lon) * S, rowOf(lat) * S];
for (const f of geo.features) {
  const g = f.geometry, v = idx.get(f.properties.CLAVE);
  for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) fillPolygon(poly, w, h, toPx, i => { raster[i] = v; });
}
let filled = 0;
for (const v of raster) if (v) filled++;
log(`uso de suelo: ${claves.length} clases, ${(100 * filled / raster.length).toFixed(1)} % de la rejilla con dato`);

const head = Buffer.alloc(12);
head.writeUInt32LE(0x31555248, 0); head.writeUInt32LE(w, 4); head.writeUInt32LE(h, 8);
const size = writeGz(path.join(LAYERS, 'usv.bin'), Buffer.concat([head, Buffer.from(raster.buffer)]));
writeJSON(path.join(LAYERS, 'usv.json'), { clases });

// participación por municipio (usa la rejilla de municipios del relieve)
const muni = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'src/relieve/data/muni.bin')));
const share = Array.from({ length: 85 }, () => new Float64Array(USV_GROUPS.length));
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const v = raster[y * w + x];
  if (!v) continue;
  const m = muni[Math.round((y + 0.5) / S) * W + Math.round((x + 0.5) / S)];
  if (m) share[m][clases[v - 1].grupo]++;
}
writeJSON(path.join(OUT, 'usv_municipios.json'), share.slice(1).map((s, i) => {
  const tot = s.reduce((a, b) => a + b, 0) || 1;
  return { id: i + 1, ...Object.fromEntries(USV_GROUPS.map((g, k) => [g.id, +(100 * s[k] / tot).toFixed(1)])) };
}));
writeJSON(path.join(OUT, 'usv_poligonos.json'), geo.features.map(f => ({ clave: f.properties.CLAVE, descripcion: f.properties.DESCRIPCIO, geom: f.geometry })));
log(`usv.bin ${kb(size)} (${w}×${h})`);
