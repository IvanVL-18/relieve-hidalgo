import type { Profile } from '../../shared/terrain';
import { SLOPE_BREAKS, classOf } from '../scales';

/**
 * Cifras de un perfil de elevación (sin dependencias del navegador: también lo usan las pruebas). El relieve de 30 m
 * trae ruido de unos metros: la pendiente se mide sobre ~100 m y la subida acumulada ignora vaivenes de menos de 3 m
 * (como hacen los programas de GPS); sin eso, una carretera plana «subiría» cientos de metros.
 */
export interface ProfileStats {
  /** km totales */
  km: number;
  /** elevación con los huecos sin dato rellenados (NaN solo al principio o al final, fuera de la zona con relieve) */
  elev: Float32Array;
  /** pendiente con signo por muestra (%: metros por cada 100 m en horizontal; + = sube en el sentido del trazo) */
  slope: Float32Array;
  min: number; max: number; iMin: number; iMax: number;
  start: number; end: number;
  /** metros acumulados de subida y de bajada */
  up: number; down: number;
  /** media de |pendiente| a lo largo del trazo y la máxima (con su muestra) */
  meanSlope: number; maxSlope: number; iMaxSlope: number;
  /** km en cada clase de pendiente (SLOPE_BREAKS) */
  classKm: number[];
  /** fracción de las muestras con dato */
  valid: number;
}

export const CLIMB_THRESHOLD_M = 3;

export function profileStats(p: Profile, threshold = CLIMB_THRESHOLD_M): ProfileStats {
  const n = p.km.length, km = p.km, z = Float32Array.from(p.elev);
  let valid = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(z[i])) valid++;
  // huecos internos: interpolación lineal entre los vecinos con dato
  for (let i = 0, last = -1; i < n; i++) {
    if (!Number.isFinite(z[i])) continue;
    if (last >= 0 && i - last > 1) for (let k = last + 1; k < i; k++) z[k] = z[last] + ((z[i] - z[last]) * (km[k] - km[last])) / (km[i] - km[last]);
    last = i;
  }
  const stepM = n > 1 ? ((km[n - 1] - km[0]) * 1000) / (n - 1) : 30;
  // suavizado de ~90 m (media móvil) y pendiente sobre ~100 m
  const h = Math.max(0, Math.round(45 / stepM)), w = Math.max(1, Math.round(50 / stepM));
  const s = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    let sum = 0, q = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(n - 1, i + h); k++) if (Number.isFinite(z[k])) { sum += z[k]; q++; }
    if (q && Number.isFinite(z[i])) s[i] = sum / q;
  }
  const slope = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n - 1, i + w), d = (km[b] - km[a]) * 1000;
    if (d > 0 && Number.isFinite(s[a]) && Number.isFinite(s[b])) slope[i] = ((s[b] - s[a]) / d) * 100;
  }

  let min = Infinity, max = -Infinity, iMin = -1, iMax = -1, up = 0, down = 0, ref = NaN;
  let sumSlope = 0, lenSlope = 0, maxSlope = 0, iMaxSlope = -1;
  const classKm = new Array(SLOPE_BREAKS.length + 1).fill(0);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(z[i])) {
      if (z[i] < min) { min = z[i]; iMin = i; }
      if (z[i] > max) { max = z[i]; iMax = i; }
    }
    // subida y bajada con histéresis: cuenta solo cuando la altura se aleja más del umbral del último punto fijado
    if (Number.isFinite(s[i])) {
      if (!Number.isFinite(ref)) ref = s[i];
      else if (s[i] - ref >= threshold) { up += s[i] - ref; ref = s[i]; }
      else if (ref - s[i] >= threshold) { down += ref - s[i]; ref = s[i]; }
    }
    if (Number.isFinite(slope[i]) && Math.abs(slope[i]) > maxSlope) { maxSlope = Math.abs(slope[i]); iMaxSlope = i; }
    if (i > 0 && Number.isFinite(slope[i]) && Number.isFinite(slope[i - 1])) {
      const len = km[i] - km[i - 1], g = (Math.abs(slope[i]) + Math.abs(slope[i - 1])) / 2;
      sumSlope += g * len; lenSlope += len;
      classKm[classOf(g, SLOPE_BREAKS)] += len;
    }
  }
  const first = z.findIndex(Number.isFinite);
  let lastI = n - 1;
  while (lastI >= 0 && !Number.isFinite(z[lastI])) lastI--;
  // lo que quedó pendiente al final del trazo (menos que el umbral) también cuenta
  if (lastI >= 0 && Number.isFinite(s[lastI]) && Number.isFinite(ref)) { if (s[lastI] > ref) up += s[lastI] - ref; else down += ref - s[lastI]; }
  return {
    km: n ? km[n - 1] : 0, elev: z, slope, min, max, iMin, iMax,
    start: first >= 0 ? z[first] : NaN, end: lastI >= 0 ? z[lastI] : NaN,
    up, down, meanSlope: lenSlope ? sumSlope / lenSlope : NaN, maxSlope, iMaxSlope, classKm, valid: n ? valid / n : 0,
  };
}

/** Muestras a dibujar: en cada tramo, la más baja y la más alta en su orden (no se pierden cimas ni barrancas). */
export function decimate(z: ArrayLike<number>, maxPoints: number): number[] {
  const n = z.length;
  if (n <= maxPoints) return Array.from({ length: n }, (_, i) => i);
  const bins = Math.floor(maxPoints / 2), out: number[] = [0];
  for (let b = 0; b < bins; b++) {
    const a = Math.floor((b * n) / bins), e = Math.floor(((b + 1) * n) / bins);
    let lo = -1, hi = -1;
    for (let i = a; i < e; i++) {
      if (!Number.isFinite(z[i])) continue;
      if (lo < 0 || z[i] < z[lo]) lo = i;
      if (hi < 0 || z[i] > z[hi]) hi = i;
    }
    if (lo < 0) continue;
    for (const i of lo === hi ? [lo] : lo < hi ? [lo, hi] : [hi, lo]) if (i > out[out.length - 1]) out.push(i);
  }
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

/** Marcas redondas para un eje (pasos 1, 2, 2.5 o 5 × 10^k) que cubren [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 4) {
  const raw = (hi - lo) / Math.max(1, count), p = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(v => v >= raw) ?? 10 * p;
  const t0 = Math.floor(lo / step) * step, t1 = Math.ceil(hi / step) * step, ticks: number[] = [];
  for (let v = t0; v <= t1 + step * 1e-6; v += step) ticks.push(Number(v.toFixed(6)));
  return { ticks, step, lo: t0, hi: t1 };
}

/** Índice de la muestra más cercana a una distancia (km), por búsqueda binaria. */
export function sampleAt(km: ArrayLike<number>, d: number) {
  let lo = 0, hi = km.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (km[m] < d) lo = m; else hi = m; }
  return Math.abs(km[lo] - d) <= Math.abs(km[hi] - d) ? lo : hi;
}

/** CSV con una fila por muestra (con BOM para que Excel lea bien los acentos). */
export function profileCsv(p: Profile, st: ProfileStats) {
  const rows = ['km,longitud,latitud,elevacion_m,pendiente_pct'];
  for (let i = 0; i < p.km.length; i++) {
    const e = st.elev[i], g = st.slope[i];
    rows.push([p.km[i].toFixed(3), p.lon[i].toFixed(6), p.lat[i].toFixed(6), Number.isFinite(e) ? e.toFixed(1) : '', Number.isFinite(g) ? g.toFixed(1) : ''].join(','));
  }
  return '﻿' + rows.join('\r\n') + '\r\n';
}

/** «sube 8 %», «baja 12 %» o «plano» */
export const slopeText = (g: number) => (!Number.isFinite(g) ? '' : Math.abs(g) < 0.5 ? 'plano' : `${g > 0 ? 'sube' : 'baja'} ${Math.abs(g).toFixed(0)} %`);

/** Exageración vertical de una gráfica: cuánto más se estira un metro vertical que uno horizontal. */
export const verticalExaggeration = (plotW: number, plotH: number, km: number, meters: number) => (plotH / meters) / (plotW / (km * 1000));
