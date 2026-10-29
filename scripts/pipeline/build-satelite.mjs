#!/usr/bin/env node
/**
 * Imagen satelital (Sentinel-2 cloudless 2016, EOX, CC BY 4.0) reproyectada de Web Mercator a la rejilla
 * geográfica del relieve: el píxel (x, y) cubre lon0 … lon1 y lat0 … lat1 en partes iguales, igual que la
 * coordenada de textura del terreno.
 *
 * La foto ya trae las sombras del relieve (el Sol de las tomas, a media mañana) y el visor agrega las suyas:
 * sin corregir, las laderas a contraluz quedan oscurecidas dos veces. Se aplica la corrección C topográfica
 * (Teillet et al. 1982) con la dirección de luz estimada de la propia imagen contra el relieve de 30 m.
 *   capas/satelite-4096.webp · capas/satelite-2048.webp   todo el estado (z12, ≈ 48 m por píxel)
 *   capas/satelite-16m.bin   RHP1: teselas WebP de 256 px por 16 × 16 celdas (z13, ≈ 16 m por píxel) sobre Hidalgo,
 *                            para el detalle al acercarse; misma corrección y mismo ajuste de color que la global
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { CACHE, H, LAT0, LAT1, LAYERS, LON0, LON1, ROOT, STEP, W, kb, log, writePack } from './lib.mjs';
import { tileRange } from './sources.mjs';
import { FINE, KX, KZ, TILE, bilinear, colOf, loadFine, rowOf } from './dem.mjs';

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

/** Coordenada de píxel Web Mercator (centros en enteros) en el nivel z. */
const mercX = (lon, z) => ((lon + 180) / 360) * 2 ** z * TS - 0.5;
const mercY = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z * TS - 0.5; };
const fine = await loadFine();
const BRIGHT = { brightness: 1.22, saturation: 1.1 }, GAMMA = 1.12;

/** Resuelve un sistema lineal pequeño (eliminación gaussiana con pivoteo). */
function solve(A, b) {
  const k = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < k; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j]; }
  }
  return M.map((row, i) => row[k] / row[i]);
}

/** Normal del terreno (este, sur, arriba) en el píxel (x, y) de una rejilla de elevación w × h con píxeles de pxE × pxS m. */
function normalAt(elev, w, h, x, y, pxE, pxS, nv) {
  const ge = (elev[y * w + Math.min(w - 1, x + 1)] - elev[y * w + Math.max(0, x - 1)]) / (2 * pxE);
  const gs = (elev[Math.min(h - 1, y + 1) * w + x] - elev[Math.max(0, y - 1) * w + x]) / (2 * pxS);
  const l = Math.hypot(ge, gs, 1);
  nv[0] = -ge / l; nv[1] = -gs / l; nv[2] = 1 / l;
  return nv;
}

/** Luz de la foto y constante C por banda: se ajustan una vez (sobre la imagen de 4096 px) y se usan en todo. */
let corr = null;
/** Factor de la corrección C (acotado) para un píxel con coseno de incidencia cosI. */
const factor = (cosI, k) => Math.max(0.7, Math.min(1.6, (corr.L[2] + corr.C[k]) / (cosI + corr.C[k])));

async function render(size) {
  const img = new Uint8ClampedArray(size * size * 3), elev = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const lat = LAT0 - ((y + 0.5) / size) * (LAT0 - LAT1), fy = mercY(lat, Z) - T.y0 * TS;
    const y0 = Math.max(0, Math.min(mh - 2, Math.floor(fy))), ty = fy - y0;
    for (let x = 0; x < size; x++) {
      const lon = LON0 + ((x + 0.5) / size) * (LON1 - LON0), fx = mercX(lon, Z) - T.x0 * TS;
      const x0 = Math.max(0, Math.min(mw - 2, Math.floor(fx))), tx = fx - x0;
      const a = (y0 * mw + x0) * 3, b = a + 3, c = a + mw * 3, d = c + 3, o = (y * size + x) * 3;
      for (let k = 0; k < 3; k++) {
        img[o + k] = (mosaic[a + k] * (1 - tx) + mosaic[b + k] * tx) * (1 - ty) + (mosaic[c + k] * (1 - tx) + mosaic[d + k] * tx) * ty;
      }
      elev[y * size + x] = bilinear(fine.data, fine.w, fine.h, rowOf(lat) * FINE, colOf(lon) * FINE);
    }
  }
  const pxE = ((LON1 - LON0) / size) * KX * 1000, pxS = ((LAT0 - LAT1) / size) * KZ * 1000, nv = [0, 0, 0];
  const cosI = new Float32Array(size * size), step = size >= 4096 ? 3 : 2;
  if (!corr) {
    // dirección de la luz: brillo ≈ b0 + b1·n_este + b2·n_sur (mínimos cuadrados sobre una muestra)
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
    for (let y = 0; y < size; y += step) for (let x = 0; x < size; x += step) {
      const i = y * size + x, Y = 0.2126 * img[i * 3] + 0.7152 * img[i * 3 + 1] + 0.0722 * img[i * 3 + 2], nn = normalAt(elev, size, size, x, y, pxE, pxS, nv);
      const f = [1, nn[0], nn[1]];
      for (let r = 0; r < 3; r++) { v[r] += f[r] * Y; for (let c = 0; c < 3; c++) A[r][c] += f[r] * f[c]; }
    }
    const [, be, bs] = solve(A, v);
    const az = Math.atan2(be, -bs), el = (55 * Math.PI) / 180;   // altura del Sol típica de las tomas (≈ 10:30, temporada seca)
    const L = [Math.cos(el) * Math.sin(az), -Math.cos(el) * Math.cos(az), Math.sin(el)];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const nn = normalAt(elev, size, size, x, y, pxE, pxS, nv);
      cosI[y * size + x] = Math.max(0, nn[0] * L[0] + nn[1] * L[1] + nn[2] * L[2]);
    }
    // corrección C por banda: valor = m·cos(i) + c  →  corregido = valor · (cos θs + C) / (cos i + C), con C = c / m
    const C = [0, 1, 2].map(k => {
      let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
      for (let i = 0; i < size * size; i += step * 7) { const x = cosI[i], yv = img[i * 3 + k]; sx += x; sy += yv; sxx += x * x; sxy += x * yv; m++; }
      const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx), icpt = (sy - slope * sx) / m;
      // C chico sobrecorrige las laderas en sombra (poca señal): se acota; sin relación con la luz, no se corrige
      return slope > 0 ? Math.max(0.15, icpt / slope) : 1e3;
    });
    corr = { az, L, C };
    log(`luz de la foto desde ${(((az * 180) / Math.PI + 360) % 360).toFixed(0)}° (acimut), C = ${C.map(c => c.toFixed(2)).join(' / ')}`);
  } else {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const nn = normalAt(elev, size, size, x, y, pxE, pxS, nv), L = corr.L;
      cosI[y * size + x] = Math.max(0, nn[0] * L[0] + nn[1] * L[1] + nn[2] * L[2]);
    }
  }
  const out = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.max(0, Math.min(255, Math.round(img[i * 3 + k] * factor(cosI[i], k))));
  const file = path.join(LAYERS, `satelite-${size}.webp`);
  // un poco más de luz: el relieve lo sombrea el Sol del visor
  await sharp(out, { raw: { width: size, height: size, channels: 3 } }).modulate(BRIGHT).gamma(GAMMA).webp({ quality: size > 2048 ? 74 : 78, effort: 5 }).toFile(file);
  log(`satelite-${size}.webp ${kb(fs.statSync(file).size)}`);
}

/**
 * Teselas de detalle: 256 px por cada TILE × TILE celdas del visor, desde las teselas z13 (≈ 18 m). Solo las que tocan
 * Hidalgo o ~1 km alrededor; donde falta una tesela z13 se usa el mosaico z12.
 */
async function renderTiles() {
  const Z2 = 13, PX = 256, nx = Math.ceil((W - 1) / TILE), ny = Math.ceil((H - 1) / TILE);
  const muni = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'src/relieve/data/muni.bin')));
  const near = (c0, r0, c1, r1) => {
    for (let r = Math.max(0, r0); r <= Math.min(H - 1, r1); r++) for (let c = Math.max(0, c0); c <= Math.min(W - 1, c1); c++) if (muni[r * W + c]) return true;
    return false;
  };
  const cache = new Map();
  const z13 = async (x, y) => {
    const key = y * 65536 + x;
    if (cache.has(key)) return cache.get(key);
    const f = path.join(CACHE, `s2/${Z2}/${y}_${x}.jpg`);
    const v = fs.existsSync(f) ? (await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data : null;
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    cache.set(key, v);
    return v;
  };
  const tiles = new Map(), A = PX + 2, img = new Float32Array(PX * PX * 3), elev = new Float32Array(A * A), nv = [0, 0, 0];
  const pxE = ((TILE * STEP) / PX) * KX * 1000, pxS = ((TILE * STEP) / PX) * KZ * 1000;
  let fromZ12 = 0;
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    if (!near(tx * TILE - 4, ty * TILE - 4, (tx + 1) * TILE + 4, (ty + 1) * TILE + 4)) continue;
    const colOfPx = i => tx * TILE + ((i + 0.5) * TILE) / PX, rowOfPx = j => ty * TILE + ((j + 0.5) * TILE) / PX;
    // mosaico local de las teselas z13 que cubren esta tesela
    const lonA = LON0 + colOfPx(-1) * STEP, lonB = LON0 + colOfPx(PX) * STEP, latA = LAT0 - rowOfPx(-1) * STEP, latB = LAT0 - rowOfPx(PX) * STEP;
    const X0 = Math.floor(mercX(lonA, Z2) / TS), X1 = Math.floor((mercX(lonB, Z2) + 1) / TS), Y0 = Math.floor(mercY(latA, Z2) / TS), Y1 = Math.floor((mercY(latB, Z2) + 1) / TS);
    const lw = (X1 - X0 + 1) * TS, lh = (Y1 - Y0 + 1) * TS, local = Buffer.alloc(lw * lh * 3), have = [];
    for (let Y = Y0; Y <= Y1; Y++) for (let X = X0; X <= X1; X++) {
      const d = await z13(X, Y);
      have.push(!!d);
      if (d) for (let y = 0; y < TS; y++) d.copy(local, (((Y - Y0) * TS + y) * lw + (X - X0) * TS) * 3, y * TS * 3, (y + 1) * TS * 3);
    }
    for (let j = 0; j < PX; j++) {
      const lat = LAT0 - rowOfPx(j) * STEP, fy = mercY(lat, Z2) - Y0 * TS, y0 = Math.max(0, Math.min(lh - 2, Math.floor(fy))), wy = fy - y0;
      for (let i = 0; i < PX; i++) {
        const lon = LON0 + colOfPx(i) * STEP, fx = mercX(lon, Z2) - X0 * TS, x0 = Math.max(0, Math.min(lw - 2, Math.floor(fx))), wx = fx - x0;
        const o = (j * PX + i) * 3;
        if (have[Math.floor(y0 / TS) * (X1 - X0 + 1) + Math.floor(x0 / TS)]) {
          const a = (y0 * lw + x0) * 3, b = a + 3, c = a + lw * 3, d = c + 3;
          for (let k = 0; k < 3; k++) img[o + k] = (local[a + k] * (1 - wx) + local[b + k] * wx) * (1 - wy) + (local[c + k] * (1 - wx) + local[d + k] * wx) * wy;
        } else {
          fromZ12++;
          const gx = mercX(lon, Z) - T.x0 * TS, gy = mercY(lat, Z) - T.y0 * TS;
          const x1 = Math.max(0, Math.min(mw - 2, Math.floor(gx))), y1 = Math.max(0, Math.min(mh - 2, Math.floor(gy))), ux = gx - x1, uy = gy - y1;
          const a = (y1 * mw + x1) * 3, b = a + 3, c = a + mw * 3, d = c + 3;
          for (let k = 0; k < 3; k++) img[o + k] = (mosaic[a + k] * (1 - ux) + mosaic[b + k] * ux) * (1 - uy) + (mosaic[c + k] * (1 - ux) + mosaic[d + k] * ux) * uy;
        }
      }
    }
    // relieve con un píxel de margen para las normales
    for (let j = 0; j < A; j++) for (let i = 0; i < A; i++) elev[j * A + i] = bilinear(fine.data, fine.w, fine.h, rowOfPx(j - 1) * FINE, colOfPx(i - 1) * FINE);
    const out = Buffer.alloc(PX * PX * 3), L = corr.L;
    for (let j = 0; j < PX; j++) for (let i = 0; i < PX; i++) {
      const nn = normalAt(elev, A, A, i + 1, j + 1, pxE, pxS, nv), cosI = Math.max(0, nn[0] * L[0] + nn[1] * L[1] + nn[2] * L[2]), o = (j * PX + i) * 3;
      for (let k = 0; k < 3; k++) out[o + k] = Math.max(0, Math.min(255, Math.round(img[o + k] * factor(cosI, k))));
    }
    tiles.set(ty * nx + tx, await sharp(out, { raw: { width: PX, height: PX, channels: 3 } }).modulate(BRIGHT).gamma(GAMMA).webp({ quality: 72, effort: 5 }).toBuffer());
  }
  const r = writePack(path.join(LAYERS, 'satelite-16m.bin'), { kind: 2, tileCells: TILE, nx, ny, px: PX, f: PX / TILE }, tiles);
  log(`satelite-16m.bin ${kb(r.size)}: ${r.tiles} teselas de ${PX} px, ${kb(r.mean)} en promedio${fromZ12 ? `; ${(fromZ12 / (r.tiles * PX * PX) * 100).toFixed(1)} % de píxeles desde z12` : ''}`);
}

await render(4096);
await render(2048);
await renderTiles();
