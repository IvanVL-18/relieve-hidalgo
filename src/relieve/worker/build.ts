import { makeGeo } from '../shared/geo';
import type { BuildRequest, BuildResult, LinesResult } from '../shared/types';
import { decodeElev, decodeMuniFine, decodeVec, fetchBin, type Lines, type VecData } from './decode';
import * as P from './palette';
import { lineField, rasterMini, stateField } from './raster';

/** Desenfoque de caja separable (dos pasadas), con bordes extendidos. */
function boxBlur(src: Float32Array, w: number, h: number, rad: number) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), k = 1 / (2 * rad + 1);
  for (let r = 0; r < h; r++) {
    const row = r * w;
    let s = 0;
    for (let c = -rad; c <= rad; c++) s += src[row + Math.min(w - 1, Math.max(0, c))];
    for (let c = 0; c < w; c++) {
      tmp[row + c] = s * k;
      s += src[row + Math.min(w - 1, c + rad + 1)] - src[row + Math.max(0, c - rad)];
    }
  }
  for (let c = 0; c < w; c++) {
    let s = 0;
    for (let r = -rad; r <= rad; r++) s += tmp[Math.min(h - 1, Math.max(0, r)) * w + c];
    for (let r = 0; r < h; r++) {
      out[r * w + c] = s * k;
      s += tmp[Math.min(h - 1, r + rad + 1) * w + c] - tmp[Math.max(0, r - rad) * w + c];
    }
  }
  return out;
}

/** Elevación bilineal en coordenadas de celda fraccionarias. */
function bilinear(e: Float32Array, w: number, h: number, fr: number, fc: number) {
  fr = Math.max(0, Math.min(h - 1.001, fr)); fc = Math.max(0, Math.min(w - 1.001, fc));
  const r = Math.floor(fr), c = Math.floor(fc), tr = fr - r, tc = fc - c, i = r * w + c;
  return (e[i] * (1 - tc) + e[i + 1] * tc) * (1 - tr) + (e[i + w] * (1 - tc) + e[i + w + 1] * tc) * tr;
}

/**
 * Paredes del zócalo a lo largo del contorno del estado: una franja vertical por tramo, partida cada ~1/4 de celda
 * para que su borde superior siga el relieve. La altura la pone el sombreador de vértices (la misma superficie que el
 * terreno): aquí solo va x, 1 = arriba / 0 = abajo, z. Normal horizontal hacia afuera, promediada en cada vértice.
 */
function buildWalls(outline: Lines, toX: (c: number) => number, toZ: (r: number) => number, kx: number, kz: number) {
  const pos: number[] = [], nor: number[] = [];
  for (let l = 0; l < outline.len.length; l++) {
    const s = outline.start[l], n = outline.len[l];
    // densificar
    const px: number[] = [], py: number[] = [];
    for (let j = 0; j + 1 < n; j++) {
      const ax = outline.x[s + j], ay = outline.y[s + j], bx = outline.x[s + j + 1], by = outline.y[s + j + 1];
      const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.25));
      for (let q = 0; q < k; q++) { px.push(ax + ((bx - ax) * q) / k); py.push(ay + ((by - ay) * q) / k); }
    }
    const closed = n > 2 && outline.x[s] === outline.x[s + n - 1] && outline.y[s] === outline.y[s + n - 1];
    if (!closed) { px.push(outline.x[s + n - 1]); py.push(outline.y[s + n - 1]); }
    const m = px.length;
    if (m < 2) continue;
    // sentido del anillo (área con signo en celdas) para que la normal apunte hacia afuera
    let area = 0;
    for (let j = 0; j < m; j++) { const k = (j + 1) % m; area += px[j] * py[k] - px[k] * py[j]; }
    const sgn = area > 0 ? 1 : -1, segs = closed ? m : m - 1;
    // normal de cada tramo en km (la escala de x y z es casi igual, pero se respeta)
    const snx = new Float32Array(segs), snz = new Float32Array(segs);
    for (let j = 0; j < segs; j++) {
      const k = (j + 1) % m, dx = (px[k] - px[j]) * kx, dz = (py[k] - py[j]) * kz, L = Math.hypot(dx, dz) || 1;
      snx[j] = (sgn * dz) / L; snz[j] = (-sgn * dx) / L;
    }
    const vn = (j: number) => {
      const a = closed ? (j - 1 + segs) % segs : Math.max(0, j - 1), b = closed ? j % segs : Math.min(segs - 1, j);
      const x = snx[a] + snx[b], z = snz[a] + snz[b], L = Math.hypot(x, z) || 1;
      return [x / L, 0, z / L];
    };
    for (let j = 0; j < segs; j++) {
      const k = (j + 1) % m;
      const ax = toX(px[j]), az = toZ(py[j]), bx = toX(px[k]), bz = toZ(py[k]);
      const na = vn(j), nb = vn(j + 1);
      pos.push(ax, 1, az, ax, 0, az, bx, 1, bz, bx, 1, bz, ax, 0, az, bx, 0, bz);
      nor.push(...na, ...na, ...nb, ...nb, ...na, ...nb);
    }
  }
  return { position: Float32Array.from(pos), normal: Float32Array.from(nor) };
}

export async function build(req: BuildRequest, progress: (stage: 'download' | 'build') => void) {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (k: string) => { const n = performance.now(); timings[k] = Math.round(n - t); t = n; };

  progress('download');
  const [elevRaw, muni, muniFineRaw, vecRaw] = await Promise.all([fetchBin(req.urls.elev), fetchBin(req.urls.muni), fetchBin(req.urls.muniFine), fetchBin(req.urls.vec)]);
  lap('download');
  progress('build');

  const { W: GW, H: GH, step: STEP } = req.grid, N = GW * GH;
  if (muni.length !== N) throw new Error('muni.bin no coincide con la rejilla');
  const elev = decodeElev(elevRaw, GW, GH);
  const vec = decodeVec(vecRaw);
  const muniFine = decodeMuniFine(muniFineRaw);
  const geo = makeGeo(req.grid);
  lap('decode');

  /* ---------- campos del relieve de 270 m: oclusión, brillo nocturno y normal ---------- */
  // oclusión ambiental: valles más oscuros que su entorno, a dos escalas (el relieve de 90 m la mejora después)
  const blurA = boxBlur(elev, GW, GH, 4), blurB = boxBlur(elev, GW, GH, 16);
  // brillo nocturno: cada localidad del censo como una mancha gaussiana según su población
  const glow = new Float32Array(N);
  const cellX = STEP * geo.KX, cellZ = STEP * geo.KZ;
  const L = vec.lights;
  if (L) {
    for (let k = 0; k < L.pop.length; k++) {
      const pop = L.pop[k], sigma = 0.25 + 0.0042 * Math.sqrt(pop);
      const lp = Math.min(1, Math.log10(Math.max(1, pop)) / 5), amp = lp * lp * (3 - 2 * lp);
      const fc = L.x[k], fr = L.y[k];
      const rc = Math.ceil((3 * sigma) / cellX), rr = Math.ceil((3 * sigma) / cellZ);
      for (let r = Math.max(0, Math.floor(fr - rr)); r <= Math.min(GH - 1, Math.ceil(fr + rr)); r++) {
        for (let c = Math.max(0, Math.floor(fc - rc)); c <= Math.min(GW - 1, Math.ceil(fc + rc)); c++) {
          const dx = (c - fc) * cellX, dz = (r - fr) * cellZ;
          glow[r * GW + c] += amp * Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma));
        }
      }
    }
  }
  // RGBA por nodo: R oclusión, G brillo (satura suave: los conglomerados urbanos no se queman en blanco),
  // B y A normal (x, z) en escala real, de −1…1 a 0…255. El color por altitud lo pinta el sombreador con la altura.
  const fields = new Uint8Array(N * 4), sx = 2 * cellX * 1000, sz = 2 * cellZ * 1000;
  for (let r = 0; r < GH; r++) {
    for (let c = 0; c < GW; c++) {
      const i = r * GW + c, e = elev[i], k = i * 4;
      fields[k] = P.toByte(1 + ((e - blurA[i]) / 90) * 0.5 + ((e - blurB[i]) / 260) * 0.5);
      fields[k + 1] = P.toByte(1 - Math.exp(-1.6 * glow[i]));
      const gx = (elev[r * GW + Math.min(GW - 1, c + 1)] - elev[r * GW + Math.max(0, c - 1)]) / sx;
      const gz = (elev[Math.min(GH - 1, r + 1) * GW + c] - elev[Math.max(0, r - 1) * GW + c]) / sz;
      const il = 1 / Math.hypot(gx, 1, gz);
      fields[k + 2] = Math.round((-gx * il * 0.5 + 0.5) * 255);
      fields[k + 3] = Math.round((-gz * il * 0.5 + 0.5) * 255);
    }
  }
  lap('fields');

  /* ---------- municipios a ~50 m + distancia con signo al contorno del estado (recorte del terreno) ---------- */
  // desde la línea del recorte (RHM2); con un archivo anterior, desde el contorno de vec.bin
  const mf = muniFine, ring = mf.rings ?? vec.outline, muniTex = new Uint8Array(mf.w * mf.h * 2);
  const sdf = ring ? stateField(ring, mf.w, mf.h, mf.f, 6) : null;
  for (let p = 0; p < mf.w * mf.h; p++) { muniTex[p * 2] = mf.data[p]; muniTex[p * 2 + 1] = sdf ? sdf[p] : mf.data[p] ? 0 : 255; }
  lap('outline');

  /* ---------- paredes del zócalo, sobre la línea del recorte ---------- */
  const walls = ring
    ? buildWalls(ring, c => geo.toX(geo.lonOfCol(c)), r => geo.toZ(geo.latOfRow(r)), cellX, cellZ)
    : { position: new Float32Array(0), normal: new Float32Array(0) };

  /* ---------- puntos del entorno (fuera de Hidalgo) ---------- */
  const DS = req.quality.dotStep, dotPos: number[] = [], dotCol: number[] = [];
  const muniAt = (r: number, c: number) => (r < 0 || c < 0 || r >= GH || c >= GW ? 0 : muni[r * GW + c]);
  const c0: P.RGB = [0, 0, 0];
  for (let r = 0; r < GH; r += DS) {
    for (let c = 0; c < GW; c += DS) {
      const g = r * GW + c;
      if (muni[g] || muniAt(r + 3, c) || muniAt(r - 3, c) || muniAt(r, c + 3) || muniAt(r, c - 3)) continue;
      dotPos.push(geo.toX(geo.lonOfCol(c)), elev[g] / 1000, geo.toZ(geo.latOfRow(r)));
      P.altRamp(elev[g], c0);
      P.mix(c0, [0.604, 0.651, 0.741], 0.55);
      dotCol.push(P.srgbToLinear(c0[0]), P.srgbToLinear(c0[1]), P.srgbToLinear(c0[2]));
    }
  }

  /* ---------- luces de las localidades (de noche); la altura la pone el sombreador ---------- */
  const nl = L?.pop.length ?? 0, lightPos = new Float32Array(nl * 3), lightSize = new Float32Array(nl);
  for (let k = 0; k < nl; k++) {
    lightPos[k * 3] = geo.toX(geo.lonOfCol(L!.x[k]));
    lightPos[k * 3 + 1] = bilinear(elev, GW, GH, L!.y[k], L!.x[k]) / 1000;
    lightPos[k * 3 + 2] = geo.toZ(geo.latOfRow(L!.y[k]));
    lightSize[k] = 3 + 3.6 * Math.log2(1 + L!.pop[k] / 600);
  }

  /* ---------- minimapa ---------- */
  const { w: MW, h: MH } = req.quality.mini;
  const mini = rasterMini(vec, GW, GH, MW, MH, (fr, fc, out, k) => {
    const r = Math.round(fr), c = Math.round(fc), i = r * GW + c, m = muni[i];
    const e2 = (dr: number, dc: number) => elev[Math.min(GH - 1, Math.max(0, r + dr)) * GW + Math.min(GW - 1, Math.max(0, c + dc))];
    const shade = Math.max(0.35, Math.min(1.25, 0.95 + (-(e2(0, 2) - e2(0, -2)) - (e2(2, 0) - e2(-2, 0))) / 900));
    if (m) {
      const border = muniAt(r, c + 1) !== m || muniAt(r + 1, c) !== m;
      const f = shade * (border ? 0.72 : 1);
      P.altRamp(elev[i], c0);
      out[k] = P.toByte(c0[0] * f); out[k + 1] = P.toByte(c0[1] * f); out[k + 2] = P.toByte(c0[2] * f); out[k + 3] = 255;
    } else {
      out[k] = 150; out[k + 1] = 160; out[k + 2] = 180; out[k + 3] = Math.round(26 * shade);
    }
  });
  lap('extras');

  const result: BuildResult = {
    type: 'done',
    elev, muni, muniFine: { w: mf.w, h: mf.h, f: mf.f, data: mf.data }, muniTex, fields,
    walls,
    dots: { position: Float32Array.from(dotPos), color: Float32Array.from(dotCol) },
    lights: { position: lightPos, size: lightSize },
    mini,
    timings,
  };
  const transfer: Transferable[] = [
    elev.buffer, muni.buffer, muniFine.data.buffer, muniTex.buffer, fields.buffer, walls.position.buffer, walls.normal.buffer,
    result.dots.position.buffer, result.dots.color.buffer, lightPos.buffer, lightSize.buffer, mini,
  ];
  return { result, transfer, vec };
}

/** Ríos, presas y límites como campos de distancia (después del primer cuadro). */
export function buildLines(vec: VecData, W: number, H: number, size: number) {
  const t = performance.now(), range = size >= 4096 ? 10 : 6;
  const data = lineField(vec, W, H, size, range);
  const result: LinesResult = { type: 'lines', size, range, data, ms: Math.round(performance.now() - t) };
  return { result, transfer: [data.buffer] as Transferable[] };
}
