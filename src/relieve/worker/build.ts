import { BASE_KM, makeGeo } from '../shared/geo';
import type { BuildRequest, BuildResult } from '../shared/types';
import { decodeElev, decodeVec, fetchBin } from './decode';
import * as P from './palette';
import { rasterMini, rasterWater } from './raster';

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

export async function build(req: BuildRequest, progress: (stage: 'download' | 'build') => void) {
  const timings: Record<string, number> = {};
  let t = performance.now();
  const lap = (k: string) => { const n = performance.now(); timings[k] = Math.round(n - t); t = n; };

  progress('download');
  const [elevRaw, muni, vecRaw] = await Promise.all([fetchBin(req.urls.elev), fetchBin(req.urls.muni), fetchBin(req.urls.vec)]);
  lap('download');
  progress('build');

  const { W: GW, H: GH, step: STEP } = req.grid, N = GW * GH;
  if (muni.length !== N) throw new Error('muni.bin no coincide con la rejilla');
  const elev = decodeElev(elevRaw, GW, GH);
  const vec = decodeVec(vecRaw);
  const geo = makeGeo(req.grid);
  lap('decode');

  /* ---------- estadísticas ---------- */
  const NM = 85;
  const mMin = new Float32Array(NM).fill(1e9), mMax = new Float32Array(NM).fill(-1e9), mSum = new Float64Array(NM);
  const mCells = new Uint32Array(NM), mPeak = new Uint32Array(NM);
  for (let i = 0; i < N; i++) {
    const m = muni[i];
    if (!m) continue;
    const e = elev[i];
    if (e < mMin[m]) mMin[m] = e;
    if (e > mMax[m]) { mMax[m] = e; mPeak[m] = i; }
    mSum[m] += e; mCells[m]++;
  }
  let maxE = -1, maxI = 0, minE = 1e9;
  for (let m = 1; m < NM; m++) {
    if (mMax[m] > maxE) { maxE = mMax[m]; maxI = mPeak[m]; }
    if (mCells[m] && mMin[m] < minE) minE = mMin[m];
  }
  const mMean = new Float32Array(NM);
  for (let m = 1; m < NM; m++) mMean[m] = mCells[m] ? mSum[m] / mCells[m] : 0;

  /* ---------- agua y límites ---------- */
  const TEX = req.quality.tex;
  const water = rasterWater(vec, GW, GH, TEX);
  lap('water');

  /* ---------- campos derivados del relieve ---------- */
  // oclusión ambiental: valles más oscuros que su entorno, a dos escalas
  const blurA = boxBlur(elev, GW, GH, 4), blurB = boxBlur(elev, GW, GH, 16);
  // brillo nocturno: localidades como manchas gaussianas
  const glow = new Float32Array(N);
  const cellX = STEP * geo.KX, cellZ = STEP * geo.KZ;
  for (const [, kind, lon, lat, , popRaw] of req.places) {
    const pop = popRaw || [45000, 4000, 700][kind];
    const sigma = kind === 0 ? 0.9 + Math.sqrt(pop / 300000) * 2.2 : kind === 1 ? 0.5 + Math.sqrt(pop / 40000) * 0.8 : 0.32;
    const amp = kind === 0 ? 1 : kind === 1 ? 0.8 : 0.5;
    const fc = geo.colOf(lon), fr = geo.rowOf(lat);
    const rc = Math.ceil((3 * sigma) / cellX), rr = Math.ceil((3 * sigma) / cellZ);
    for (let r = Math.max(0, Math.floor(fr - rr)); r <= Math.min(GH - 1, Math.ceil(fr + rr)); r++) {
      for (let c = Math.max(0, Math.floor(fc - rc)); c <= Math.min(GW - 1, Math.ceil(fc + rc)); c++) {
        const dx = (c - fc) * cellX, dz = (r - fr) * cellZ;
        glow[r * GW + c] += amp * Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma));
      }
    }
  }
  lap('fields');

  /* ---------- color por altitud (sRGB) + oclusión ambiental en alfa ---------- */
  // El color de los mapas base «Uso de suelo» y «Satélite» viene de texturas; este es el de «Altitud».
  const alt = new Uint8Array(N * 4), glowB = new Uint8Array(N);
  const dxm = cellX * 1000, dzm = cellZ * 1000;
  const c0: P.RGB = [0, 0, 0];
  for (let r = 0; r < GH; r++) {
    for (let c = 0; c < GW; c++) {
      const i = r * GW + c, e = elev[i];
      const gx = (elev[r * GW + Math.min(GW - 1, c + 1)] - elev[r * GW + Math.max(0, c - 1)]) / (2 * dxm);
      const gz = (elev[Math.min(GH - 1, r + 1) * GW + c] - elev[Math.max(0, r - 1) * GW + c]) / (2 * dzm);
      const slope = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
      const k = i * 4;
      P.altRamp(e, c0);
      P.mix(c0, P.ROCK_ALT, Math.min(0.55, Math.max(0, (slope - 16) / 30)));
      P.scale(c0, 0.97 + 0.06 * P.fbm(c / 7 + 90, r / 7 + 90, 2));
      alt[k] = P.toByte(c0[0]); alt[k + 1] = P.toByte(c0[1]); alt[k + 2] = P.toByte(c0[2]);
      alt[k + 3] = P.toByte(1 + ((e - blurA[i]) / 90) * 0.5 + ((e - blurB[i]) / 260) * 0.5);
      glowB[i] = P.toByte(Math.pow(Math.min(1, glow[i]), 0.8));
    }
  }
  lap('color');

  /* ---------- malla del terreno ---------- */
  const S = req.quality.decimate;
  const W = Math.floor((GW - 1) / S) + 1, H = Math.floor((GH - 1) / S) + 1, NV = W * H;
  const gi = (v: number) => ((v / W) | 0) * S * GW + (v % W) * S;
  const vin = new Uint8Array(NV);
  for (let v = 0; v < NV; v++) vin[v] = muni[gi(v)] ? 1 : 0;
  const tri = new Uint32Array((W - 1) * (H - 1) * 6);
  let nt = 0;
  // aristas: cada vértice guarda 3 (derecha, abajo, diagonal); las que solo usa un triángulo son el borde del estado
  const edgeCount = new Uint8Array(NV * 3), edgeDir = new Int32Array(NV * 6);
  const addEdge = (a: number, b: number, k: number) => { edgeCount[k]++; edgeDir[k * 2] = a; edgeDir[k * 2 + 1] = b; };
  for (let r = 0; r < H - 1; r++) {
    for (let c = 0; c < W - 1; c++) {
      const v00 = r * W + c, v01 = v00 + 1, v10 = v00 + W, v11 = v10 + 1;
      if (vin[v00] && vin[v10] && vin[v01]) {
        tri[nt++] = v00; tri[nt++] = v10; tri[nt++] = v01;
        addEdge(v00, v10, v00 * 3 + 1); addEdge(v10, v01, v01 * 3 + 2); addEdge(v01, v00, v00 * 3);
      }
      if (vin[v01] && vin[v10] && vin[v11]) {
        tri[nt++] = v01; tri[nt++] = v10; tri[nt++] = v11;
        addEdge(v01, v10, v01 * 3 + 2); addEdge(v10, v11, v10 * 3); addEdge(v11, v01, v01 * 3 + 1);
      }
    }
  }
  // solo los vértices que usa algún triángulo
  const remap = new Int32Array(NV).fill(-1);
  let nv = 0;
  for (let k = 0; k < nt; k++) if (remap[tri[k]] < 0) remap[tri[k]] = nv++;
  const index = new Uint32Array(nt);
  for (let k = 0; k < nt; k++) index[k] = remap[tri[k]];
  const position = new Float32Array(nv * 3), normal = new Int16Array(nv * 3);
  const vAlt = new Uint8Array(nv * 4), vGlow = new Uint8Array(nv);
  const sx = 2 * S * cellX, sz = 2 * S * cellZ;
  for (let v = 0; v < NV; v++) {
    const j = remap[v];
    if (j < 0) continue;
    const R = ((v / W) | 0) * S, C = (v % W) * S, g = R * GW + C;
    position[j * 3] = geo.toX(geo.lonOfCol(C));
    position[j * 3 + 1] = elev[g] / 1000;
    position[j * 3 + 2] = geo.toZ(geo.latOfRow(R));
    const gx = (elev[R * GW + Math.min(GW - 1, C + S)] - elev[R * GW + Math.max(0, C - S)]) / 1000 / sx;
    const gz = (elev[Math.min(GH - 1, R + S) * GW + C] - elev[Math.max(0, R - S) * GW + C]) / 1000 / sz;
    const il = 32767 / Math.hypot(gx, 1, gz);
    normal[j * 3] = Math.round(-gx * il); normal[j * 3 + 1] = Math.round(il); normal[j * 3 + 2] = Math.round(-gz * il);
    for (let q = 0; q < 4; q++) vAlt[j * 4 + q] = alt[g * 4 + q];
    vGlow[j] = glowB[g];
  }
  lap('mesh');

  /* ---------- paredes del zócalo ---------- */
  let nEdges = 0;
  for (let k = 0; k < NV * 3; k++) if (edgeCount[k] === 1) nEdges++;
  const wPos = new Float32Array(nEdges * 18), wNor = new Float32Array(nEdges * 18), wTop = new Float32Array(nEdges * 6);
  let w = 0;
  for (let k = 0; k < NV * 3; k++) {
    if (edgeCount[k] !== 1) continue;
    const a = remap[edgeDir[k * 2]], b = remap[edgeDir[k * 2 + 1]];
    const ax = position[a * 3], ay = position[a * 3 + 1], az = position[a * 3 + 2];
    const bx = position[b * 3], by = position[b * 3 + 1], bz = position[b * 3 + 2];
    wPos.set([ax, ay, az, ax, BASE_KM, az, bx, by, bz, bx, by, bz, ax, BASE_KM, az, bx, BASE_KM, bz], w * 18);
    wTop.set([ay, ay, by, by, ay, by], w * 6);
    // normal horizontal hacia afuera; coincide con el sentido de los triángulos
    let nx = az - bz, nz = bx - ax;
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    for (let q = 0; q < 6; q++) { wNor[w * 18 + q * 3] = nx; wNor[w * 18 + q * 3 + 2] = nz; }
    w++;
  }

  /* ---------- puntos del entorno (fuera de Hidalgo) ---------- */
  const DS = req.quality.dotStep, dotPos: number[] = [], dotCol: number[] = [];
  const muniAt = (r: number, c: number) => (r < 0 || c < 0 || r >= GH || c >= GW ? 0 : muni[r * GW + c]);
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

  /* ---------- minimapa ---------- */
  const { w: MW, h: MH } = req.quality.mini;
  const mini = rasterMini(vec, GW, GH, MW, MH, (fr, fc, out, k) => {
    const r = Math.round(fr), c = Math.round(fc), i = r * GW + c, m = muni[i];
    const e2 = (dr: number, dc: number) => elev[Math.min(GH - 1, Math.max(0, r + dr)) * GW + Math.min(GW - 1, Math.max(0, c + dc))];
    const shade = Math.max(0.35, Math.min(1.25, 0.95 + (-(e2(0, 2) - e2(0, -2)) - (e2(2, 0) - e2(-2, 0))) / 900));
    if (m) {
      const border = muniAt(r, c + 1) !== m || muniAt(r + 1, c) !== m;
      const f = shade * (border ? 0.72 : 1);
      out[k] = alt[i * 4] * f; out[k + 1] = alt[i * 4 + 1] * f; out[k + 2] = alt[i * 4 + 2] * f; out[k + 3] = 255;
    } else {
      out[k] = 150; out[k + 1] = 160; out[k + 2] = 180; out[k + 3] = Math.round(26 * shade);
    }
  });
  lap('extras');

  const result: BuildResult = {
    type: 'done',
    elev, muni, minE, maxE, maxI,
    terrain: { position, normal, alt: vAlt, glow: vGlow, index },
    walls: { position: wPos, normal: wNor, top: wTop },
    dots: { position: Float32Array.from(dotPos), color: Float32Array.from(dotCol) },
    water: { size: TEX, data: water },
    mini,
    muniStats: { min: mMin, max: mMax, mean: mMean, cells: mCells, peak: mPeak },
    timings,
  };
  const transfer: Transferable[] = [
    elev.buffer, muni.buffer, position.buffer, normal.buffer, vAlt.buffer, vGlow.buffer, index.buffer,
    wPos.buffer, wNor.buffer, wTop.buffer, result.dots.position.buffer, result.dots.color.buffer, water.buffer, mini,
    mMin.buffer, mMax.buffer, mMean.buffer, mCells.buffer, mPeak.buffer,
  ];
  return { result, transfer };
}
