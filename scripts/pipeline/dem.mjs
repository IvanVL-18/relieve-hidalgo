/**
 * Relieve fino desde Terrain Tiles (terrarium z12, ≈ 36 m; en México la fuente es INEGI, Continental relief 2016).
 * El mosaico Web Mercator se remuestrea a rejillas geográficas que subdividen la del visor: en una rejilla de
 * factor f, el nodo (r·f, c·f) es el nodo (r, c) del visor, así todas las resoluciones quedan alineadas.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { CACHE, GRID, log } from './lib.mjs';
import { SOURCES, tileRange } from './sources.mjs';

/** Georreferencia de la rejilla del visor (la misma de shared/geo.ts), calculada de GRID y no del meta.json anterior. */
const latC = GRID.lat0 - ((GRID.H - 1) * GRID.step) / 2;
export const KX = 111.32 * Math.cos((latC * Math.PI) / 180), KZ = 110.57;
export const colOf = lon => (lon - GRID.lon0) / GRID.step;
export const rowOf = lat => (GRID.lat0 - lat) / GRID.step;
export const lonOfCol = c => GRID.lon0 + c * GRID.step;
export const latOfRow = r => GRID.lat0 - r * GRID.step;

/** Rejilla de análisis: 9 celdas finas por celda del visor (≈ 29 × 31 m). */
export const FINE = 9;
/** Relieve de detalle que carga el visor (≈ 87 × 92 m). */
export const DETAIL = 3;
/** Lado de las teselas de detalle (relieve de 30 m e imagen satelital), en celdas del visor (≈ 4.2 × 4.4 km). */
export const TILE = 16;

/** Rejilla que subdivide la del visor f veces. */
export const sub = f => {
  const step = GRID.step / f;
  return { f, w: (GRID.W - 1) * f + 1, h: (GRID.H - 1) * f + 1, step, dxm: step * KX * 1000, dzm: step * KZ * 1000, cellKm2: step * KX * step * KZ };
};

const Z = 12, TS = 256;

/** Elevación en metros sobre la rejilla fina (Float32, w × h). Se guarda en caché: borra data-src/cache/relieve para rehacerla. */
export async function loadFine() {
  const g = sub(FINE), t = tileRange(Z);
  const tileFile = (x, y) => path.join(CACHE, `${SOURCES.relieve.file}${Z}/${y}_${x}.png`);
  const cache = path.join(CACHE, `relieve/fino-${FINE}.f32`);
  let newest = 0;
  for (let y = t.y0; y <= t.y1; y++) for (let x = t.x0; x <= t.x1; x++) {
    const f = tileFile(x, y);
    if (!fs.existsSync(f)) throw new Error(`Falta la tesela de relieve ${path.relative(CACHE, f)}. Corre pnpm data:fetch relieve`);
    newest = Math.max(newest, fs.statSync(f).mtimeMs);
  }
  if (fs.existsSync(cache) && fs.statSync(cache).size === g.w * g.h * 4 && fs.statSync(cache).mtimeMs > newest) {
    return { ...g, data: new Float32Array(fs.readFileSync(cache).buffer.slice(0)) };
  }
  const MW = (t.x1 - t.x0 + 1) * TS, MH = (t.y1 - t.y0 + 1) * TS, mos = new Float32Array(MW * MH);
  for (let y = t.y0; y <= t.y1; y++) for (let x = t.x0; x <= t.x1; x++) {
    const { data, info } = await sharp(tileFile(x, y)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const ox = (x - t.x0) * TS, oy = (y - t.y0) * TS;
    for (let j = 0; j < TS; j++) for (let i = 0; i < TS; i++) {
      const k = (j * info.width + i) * 3;
      mos[(oy + j) * MW + ox + i] = data[k] * 256 + data[k + 1] + data[k + 2] / 256 - 32768;
    }
  }
  // remuestreo bilineal; los centros de los píxeles terrarium están en enteros + 0.5
  const n = 2 ** Z * TS;
  const mx = new Float64Array(g.w), my = new Float64Array(g.h);
  for (let c = 0; c < g.w; c++) mx[c] = ((GRID.lon0 + c * g.step + 180) / 360) * n - t.x0 * TS - 0.5;
  for (let r = 0; r < g.h; r++) {
    const phi = ((GRID.lat0 - r * g.step) * Math.PI) / 180;
    my[r] = ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n - t.y0 * TS - 0.5;
  }
  const out = new Float32Array(g.w * g.h);
  for (let r = 0; r < g.h; r++) {
    const y0 = Math.max(0, Math.min(MH - 2, Math.floor(my[r]))), ty = my[r] - y0;
    for (let c = 0; c < g.w; c++) {
      const x0 = Math.max(0, Math.min(MW - 2, Math.floor(mx[c]))), tx = mx[c] - x0, a = y0 * MW + x0;
      out[r * g.w + c] = (mos[a] * (1 - tx) + mos[a + 1] * tx) * (1 - ty) + (mos[a + MW] * (1 - tx) + mos[a + MW + 1] * tx) * ty;
    }
  }
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, Buffer.from(out.buffer));
  log(`relieve fino ${g.w}×${g.h} (${g.dxm.toFixed(0)} × ${g.dzm.toFixed(0)} m) desde ${(t.x1 - t.x0 + 1) * (t.y1 - t.y0 + 1)} teselas`);
  return { ...g, data: out };
}

/**
 * Baja de resolución con el promedio centrado de k × k nodos (k impar): cada nodo grueso es el promedio de la
 * celda que representa. Separable; en los bordes se repite el último nodo.
 */
export function boxDown(src, w, h, k) {
  const w2 = (w - 1) / k + 1, h2 = (h - 1) / k + 1, R = (k - 1) / 2;
  if (!Number.isInteger(w2) || !Number.isInteger(h2)) throw new Error('la rejilla no es divisible entre ' + k);
  const tmp = new Float32Array(w2 * h), out = new Float32Array(w2 * h2);
  for (let r = 0; r < h; r++) for (let c = 0; c < w2; c++) {
    let s = 0;
    for (let d = -R; d <= R; d++) s += src[r * w + Math.min(w - 1, Math.max(0, c * k + d))];
    tmp[r * w2 + c] = s / k;
  }
  for (let r = 0; r < h2; r++) for (let c = 0; c < w2; c++) {
    let s = 0;
    for (let d = -R; d <= R; d++) s += tmp[Math.min(h - 1, Math.max(0, r * k + d)) * w2 + c];
    out[r * w2 + c] = s / k;
  }
  return out;
}

/** Pendiente en grados (diferencias centradas) en el nodo i de una rejilla w × h; 0 en el borde. */
export function slopeAt(e, w, h, i, dxm, dzm) {
  const r = (i / w) | 0, c = i - r * w;
  if (r < 1 || c < 1 || r >= h - 1 || c >= w - 1) return 0;
  const gx = (e[i + 1] - e[i - 1]) / (2 * dxm), gz = (e[i + w] - e[i - w]) / (2 * dzm);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
}

/** Elevación bilineal en coordenadas fraccionarias de una rejilla. */
export function bilinear(e, w, h, fr, fc) {
  fr = Math.max(0, Math.min(h - 1.001, fr)); fc = Math.max(0, Math.min(w - 1.001, fc));
  const r = Math.floor(fr), c = Math.floor(fc), tr = fr - r, tc = fc - c, i = r * w + c;
  return (e[i] * (1 - tc) + e[i + 1] * tc) * (1 - tr) + (e[i + w] * (1 - tc) + e[i + w + 1] * tc) * tr;
}

/**
 * Codifica una rejilla de enteros (Int16) como en elev.bin: residuo del predictor de gradiente (L + U − UL),
 * bytes bajos y luego altos. Comprime mucho mejor que los valores crudos.
 */
export function gradientPlanes(v, w, h) {
  const n = w * h, planes = new Uint8Array(n * 2);
  const at = (r, c) => (r < 0 || c < 0 ? 0 : v[r * w + c]);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c, res = (v[i] - (at(r, c - 1) + at(r - 1, c) - at(r - 1, c - 1))) & 0xffff;
    planes[i] = res & 255; planes[n + i] = res >> 8;
  }
  return planes;
}
