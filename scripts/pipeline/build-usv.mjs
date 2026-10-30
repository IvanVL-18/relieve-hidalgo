#!/usr/bin/env node
/**
 * Uso del suelo y vegetación (INEGI Series VII y VI) → rejillas de clases a 4 veces la resolución del relieve (≈ 65 m).
 * El visor dibuja los bordes entre clases suavizados (sin escalones), así que la orilla sigue al polígono con ~30 m de
 * error. La Serie VII es el mapa base; la VI, la serie anterior del análisis de cambio de uso de suelo.
 *   capas/usv.bin · usv6.bin   gzip: u32 'RHU1' · u32 w · u32 h · u8 clase[w·h] (0 = sin dato)
 *   capas/usv.json · usv6.json clases [{ clave, nombre, grupo, sec }] (cada serie con su lista)
 *   out/usv_municipios.json    % de cada grupo por municipio (Serie VII)
 *   out/usv_poligonos.json · usv6_poligonos.json  polígonos para la base de datos
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CACHE, H, LAYERS, OUT, ROOT, W, colOf, fillPolygon, kb, log, rowOf, writeGz, writeJSON } from './lib.mjs';
import { SOURCES } from './sources.mjs';
import { USV_GROUPS, usvGroupOf } from '../../src/relieve/shared/usv.ts';

const S = 4, w = (W - 1) * S, h = (H - 1) * S;
const sentence = s => s.charAt(0) + s.slice(1).toLowerCase().replace(/\bvegetacion\b/g, 'vegetación');

/** Rasteriza una serie: clases ordenadas por clave (índice 1…n; 0 = sin dato) y la rejilla de clases. */
function rasterize(features, keyOf, nameOf) {
  const names = new Map();
  for (const f of features) if (!names.has(keyOf(f))) names.set(keyOf(f), nameOf(f));
  const claves = [...names.keys()].sort();
  if (claves.length > 255) throw new Error('demasiadas clases');
  const clases = claves.map(k => { const g = usvGroupOf(k); return { clave: k, nombre: names.get(k), grupo: g.group, sec: g.secondary }; });
  const idx = new Map(claves.map((k, i) => [k, i + 1]));
  const raster = new Uint8Array(w * h);
  const toPx = ([lon, lat]) => [colOf(lon) * S, rowOf(lat) * S];
  for (const f of features) {
    const g = f.geometry, v = idx.get(keyOf(f));
    for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) fillPolygon(poly, w, h, toPx, i => { raster[i] = v; });
  }
  return { clases, raster };
}

function save(name, { clases, raster }) {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x31555248, 0); head.writeUInt32LE(w, 4); head.writeUInt32LE(h, 8);
  const size = writeGz(path.join(LAYERS, `${name}.bin`), Buffer.concat([head, Buffer.from(raster.buffer)]));
  writeJSON(path.join(LAYERS, `${name}.json`), { clases });
  let filled = 0;
  for (const v of raster) if (v) filled++;
  log(`${name}.bin ${kb(size)} (${w}×${h}): ${clases.length} clases, ${(100 * filled / raster.length).toFixed(1)} % de la rejilla con dato`);
}

/* ================= Serie VII (mapa base) ================= */
const s7 = JSON.parse(fs.readFileSync(path.join(CACHE, SOURCES.usv.file), 'utf8')).features;
const serie7 = rasterize(s7, f => f.properties.CLAVE, f => sentence(f.properties.DESCRIPCIO.trim()));
save('usv', serie7);

// participación por municipio (usa la rejilla de municipios del relieve)
const muni = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'src/relieve/data/muni.bin')));
const share = Array.from({ length: 85 }, () => new Float64Array(USV_GROUPS.length));
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const v = serie7.raster[y * w + x];
  if (!v) continue;
  const m = muni[Math.round((y + 0.5) / S) * W + Math.round((x + 0.5) / S)];
  if (m) share[m][serie7.clases[v - 1].grupo]++;
}
writeJSON(path.join(OUT, 'usv_municipios.json'), share.slice(1).map((s, i) => {
  const tot = s.reduce((a, b) => a + b, 0) || 1;
  return { id: i + 1, ...Object.fromEntries(USV_GROUPS.map((g, k) => [g.id, +(100 * s[k] / tot).toFixed(1)])) };
}));
writeJSON(path.join(OUT, 'usv_poligonos.json'), s7.map(f => ({ clave: f.properties.CLAVE, descripcion: f.properties.DESCRIPCIO, geom: f.geometry })));

/* ================= Serie VI (cambio de uso de suelo) ================= */
// mismas claves que la Serie VII (más «ZU» y «VSa/MJ»): se usan sus nombres; si no está, se arma con la descripción
const file6 = path.join(CACHE, SOURCES.usv6.file);
if (!fs.existsSync(file6)) log('falta la Serie VI (pnpm data:fetch usv6): se omite usv6.bin');
else {
  const s6 = JSON.parse(fs.readFileSync(file6, 'utf8')).features;
  const name7 = new Map(serie7.clases.map(c => [c.clave, c.nombre]));
  const TIPO = { VSA: 'arbórea', VSa: 'arbustiva', VSh: 'herbácea' };
  const name6 = f => {
    const k = f.properties.CVE_UNION, d = f.properties.DESCRIP_S6.trim().toLowerCase(), m = /^(VS[AaH]?)\//.exec(k);
    if (name7.has(k)) return name7.get(k);
    if (k === 'ZU') return 'Zona urbana';
    return m ? `Vegetación secundaria ${TIPO[m[1]] ?? ''} de ${d}`.replace('  ', ' ') : sentence(d.toUpperCase());
  };
  save('usv6', rasterize(s6, f => f.properties.CVE_UNION, name6));
  writeJSON(path.join(OUT, 'usv6_poligonos.json'), s6.map(f => ({ clave: f.properties.CVE_UNION, descripcion: name6(f), geom: f.geometry })));
}
