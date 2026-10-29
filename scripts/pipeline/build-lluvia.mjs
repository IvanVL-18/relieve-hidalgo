#!/usr/bin/env node
/**
 * Lluvia media anual en la rejilla del visor (≈ 270 m): el visor la usa para repartir las nubes (más donde llueve más).
 *   capas/lluvia.bin   RHU1: u32 w · u32 h · u8 [w·h] = mm / 20 (0 = sin dato), w = W y h = H (un valor por nodo), gzip
 * Fuente: rangos de INEGI 1910–2009 publicados por CONAFOR para la Megalópolis; cada rango vale su punto medio
 * («600 - 800» → 700 mm), como en build-laderas.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CACHE, H, LAYERS, W, colOf, fillPolygon, kb, log, rowOf, writeGz } from './lib.mjs';
import { SOURCES } from './sources.mjs';

const file = path.join(CACHE, SOURCES.lluvia.file);
if (!fs.existsSync(file)) throw new Error(`Falta ${SOURCES.lluvia.file}: corre npm run data:fetch -- lluvia`);
const lluvia = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = new Uint8Array(W * H);
// el centro de la celda r del rasterizador (r + 0.5) cae en el nodo r de la rejilla
const toPx = ([lon, lat]) => [colOf(lon) + 0.5, rowOf(lat) + 0.5];
for (const f of lluvia.features) {
  const nums = (f.properties.PANUAL.match(/\d+/g) ?? []).map(Number);
  if (!nums.length) continue;
  const mm = nums.length > 1 ? (nums[0] + nums[1]) / 2 : nums[0];
  const v = Math.max(1, Math.min(255, Math.round(mm / 20)));
  const g = f.geometry;
  for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) fillPolygon(poly, W, H, toPx, i => { out[i] = v; });
}
let n = 0, sum = 0;
for (const v of out) if (v) { n++; sum += v * 20; }
const head = Buffer.alloc(12);
head.writeUInt32LE(0x31555248, 0); head.writeUInt32LE(W, 4); head.writeUInt32LE(H, 8);
const size = writeGz(path.join(LAYERS, 'lluvia.bin'), Buffer.concat([head, Buffer.from(out.buffer)]));
log(`capas/lluvia.bin ${kb(size)} (${W}×${H}): ${(100 * n / (W * H)).toFixed(1)} % con dato, media ${Math.round(sum / Math.max(1, n))} mm`);
