#!/usr/bin/env node
/**
 * Imagen satelital (Sentinel-2 cloudless 2016, EOX, CC BY 4.0) reproyectada de Web Mercator a la rejilla
 * geográfica del relieve: el píxel (x, y) cubre lon0 … lon1 y lat0 … lat1 en partes iguales, igual que la
 * coordenada de textura del terreno.
 *   capas/satelite-4096.webp · capas/satelite-2048.webp
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { CACHE, LAT0, LAT1, LAYERS, LON0, LON1, kb, log } from './lib.mjs';
import { tileRange } from './sources.mjs';

const Z = 12, T = tileRange(Z), TS = 256;
const mw = (T.x1 - T.x0 + 1) * TS, mh = (T.y1 - T.y0 + 1) * TS;
const mosaic = Buffer.alloc(mw * mh * 3);
let missing = 0;
for (let ty = T.y0; ty <= T.y1; ty++) for (let tx = T.x0; tx <= T.x1; tx++) {
  const f = path.join(CACHE, `s2/${Z}/${ty}_${tx}.jpg`);
  if (!fs.existsSync(f)) { missing++; continue; }
  const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const ox = (tx - T.x0) * TS, oy = (ty - T.y0) * TS;
  for (let y = 0; y < info.height; y++) data.copy(mosaic, ((oy + y) * mw + ox) * 3, y * info.width * 3, (y + 1) * info.width * 3);
}
log(`mosaico ${mw}×${mh} (z${Z}), faltan ${missing} teselas`);

const n = 2 ** Z * TS;
const mx = lon => ((lon + 180) / 360) * n - T.x0 * TS;
const my = lat => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n - T.y0 * TS; };

async function render(size) {
  const out = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    const lat = LAT0 - ((y + 0.5) / size) * (LAT0 - LAT1), fy = my(lat) - 0.5;
    const y0 = Math.max(0, Math.min(mh - 2, Math.floor(fy))), ty = fy - y0;
    for (let x = 0; x < size; x++) {
      const lon = LON0 + ((x + 0.5) / size) * (LON1 - LON0), fx = mx(lon) - 0.5;
      const x0 = Math.max(0, Math.min(mw - 2, Math.floor(fx))), tx = fx - x0;
      const a = (y0 * mw + x0) * 3, b = a + 3, c = a + mw * 3, d = c + 3, o = (y * size + x) * 3;
      for (let k = 0; k < 3; k++) {
        out[o + k] = (mosaic[a + k] * (1 - tx) + mosaic[b + k] * tx) * (1 - ty) + (mosaic[c + k] * (1 - tx) + mosaic[d + k] * tx) * ty;
      }
    }
  }
  const file = path.join(LAYERS, `satelite-${size}.webp`);
  // un poco más de luz: el relieve ya sombrea con el Sol del visor
  await sharp(out, { raw: { width: size, height: size, channels: 3 } }).modulate({ brightness: 1.3, saturation: 1.12 }).gamma(1.15).webp({ quality: size > 2048 ? 74 : 78, effort: 5 }).toFile(file);
  log(`satelite-${size}.webp ${kb(fs.statSync(file).size)}`);
}
await render(4096);
await render(2048);
