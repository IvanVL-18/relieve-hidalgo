/**
 * Radiación solar sobre el relieve, sin dependencias: la usan la cadena de datos (capa anual a 90 m, build-solar.mjs) y
 * el análisis de potencial solar (meses de un punto). Modelo: radiación media diaria de cada mes de NASA POWER (global y
 * difusa sobre un plano horizontal) repartida en el día con la forma de un cielo despejado; directa sobre la superficie
 * inclinada solo cuando el Sol está sobre el horizonte del relieve; difusa isotrópica por el factor de vista del cielo
 * (Dozier y Marks 1987) y reflejada por el terreno que se ve (albedo 0.2).
 */

const RAD = Math.PI / 180;

/** Día representativo de cada mes (Klein 1977) y días por mes. */
export const MONTH_DAY = [17, 47, 75, 105, 135, 162, 198, 228, 258, 288, 318, 344];
export const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const ALBEDO = 0.2;

/**
 * Direcciones del horizonte: pasos enteros (columna, fila) en la rejilla (fila −1 = norte), así cada línea pasa justo
 * por nodos y no hay que interpolar. 16 direcciones, cada 18–27°.
 */
export const HORIZON_DIRS: readonly (readonly [number, number])[] = [
  [0, -1], [1, -2], [1, -1], [2, -1], [1, 0], [2, 1], [1, 1], [1, 2], [0, 1], [-1, 2], [-1, 1], [-2, 1], [-1, 0], [-2, -1], [-1, -1], [-1, -2],
];

/** Azimut (rad, desde el norte en sentido horario) de cada dirección, con las distancias reales entre nodos. */
export function dirAzimuths(dxm: number, dzm: number) {
  return Float64Array.from(HORIZON_DIRS, ([a, b]) => (Math.atan2(a * dxm, -b * dzm) + 2 * Math.PI) % (2 * Math.PI));
}

/** Horizonte cuantizado en un byte: 0.5° por paso desde −45° (0) hasta 80° (250). */
export const hToByte = (h: number) => Math.max(0, Math.min(250, Math.round((h / RAD + 45) * 2)));
export const byteToH = (q: number) => (q / 2 - 45) * RAD;

/**
 * Horizonte (rad sobre la horizontal) de cada nodo mirando en la dirección (a, b), sin límite de distancia: por cada
 * línea de nodos en esa dirección, del final hacia el principio, con la envolvente convexa superior de lo que queda
 * adelante (Dozier y Frew 1990; O(n)). z ≤ 0 o NaN = sin dato (no tapa). set(i, h) recibe el índice y el ángulo; sin
 * nada adelante (orilla de la rejilla) o sin dato, 0: se supone terreno plano más allá.
 */
export function horizonSweep(z: ArrayLike<number>, w: number, h: number, a: number, b: number, stepM: number, set: (i: number, h: number) => void) {
  const n = Math.max(w, h) + 1, idx = new Int32Array(n), zz = new Float64Array(n), st = new Int32Array(n);
  for (let r0 = 0; r0 < h; r0++) for (let c0 = 0; c0 < w; c0++) {
    const pr = r0 - b, pc = c0 - a;
    if (pr >= 0 && pc >= 0 && pr < h && pc < w) continue;   // no es el principio de una línea
    let L = 0;
    for (let r = r0, c = c0; r >= 0 && c >= 0 && r < h && c < w; r += b, c += a) { idx[L] = r * w + c; zz[L++] = z[r * w + c]; }
    let top = -1;
    for (let k = L - 1; k >= 0; k--) {
      const zk = zz[k];
      if (!(zk > 0)) { set(idx[k], 0); continue; }
      while (top >= 1) {
        const j = st[top], i = st[top - 1];
        // si el punto más lejano i se ve igual o más alto que j desde k, j queda tapado para k y para los de atrás
        if ((zz[i] - zk) * (j - k) >= (zz[j] - zk) * (i - k)) top--;
        else break;
      }
      set(idx[k], top >= 0 ? Math.atan2(zz[st[top]] - zk, (st[top] - k) * stepM) : 0);
      st[++top] = k;
    }
  }
}

/** Horizonte de un solo nodo en cada dirección, recorriendo la rejilla hasta su orilla (para el clic del análisis). */
export function horizonAt(z: ArrayLike<number>, w: number, h: number, c: number, r: number, dxm: number, dzm: number) {
  const z0 = z[r * w + c], out = new Float64Array(HORIZON_DIRS.length);
  HORIZON_DIRS.forEach(([a, b], k) => {
    const step = Math.hypot(a * dxm, b * dzm);
    let best = -Infinity;
    for (let i = 1, cc = c + a, rr = r + b; cc >= 0 && rr >= 0 && cc < w && rr < h; i++, cc += a, rr += b) {
      const v = z[rr * w + cc];
      if (v > 0) best = Math.max(best, Math.atan2(v - z0, i * step));
    }
    out[k] = Number.isFinite(best) ? best : 0;
  });
  return out;
}

/** Pendiente y orientación (rad; orientación = hacia dónde baja, desde el norte en sentido horario) por Horn en el nodo i. */
export function slopeAspect(z: ArrayLike<number>, w: number, h: number, c: number, r: number, dxm: number, dzm: number) {
  const at = (dc: number, dr: number) => {
    const v = z[Math.min(h - 1, Math.max(0, r + dr)) * w + Math.min(w - 1, Math.max(0, c + dc))];
    return v > 0 ? v : z[r * w + c];
  };
  const ge = (at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1)) / (8 * dxm);
  const gs = (at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1)) / (8 * dzm);
  const g = Math.hypot(ge, gs);
  // baja hacia −gradiente: (este, norte) = (−ge, gs)
  return { slope: Math.atan(g), aspect: g > 1e-9 ? (Math.atan2(-ge, gs) + 2 * Math.PI) % (2 * Math.PI) : 0 };
}

/** Posición del Sol en la hora solar `hour` del día del año n (declinación de Spencer 1971): elevación y azimut (rad). */
export function solarGeometry(lat: number, n: number, hour: number) {
  const g = (2 * Math.PI * (n - 1)) / 365, phi = lat * RAD, w = (hour - 12) * 15 * RAD;
  const d = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const sinE = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(w);
  const az = Math.atan2(-Math.cos(d) * Math.sin(w), Math.sin(d) * Math.cos(phi) - Math.cos(d) * Math.sin(phi) * Math.cos(w));
  return { e: Math.asin(Math.max(-1, Math.min(1, sinE))), az: (az + 2 * Math.PI) % (2 * Math.PI) };
}

/** Pasos del día con el Sol arriba, por mes, para una latitud: lo que se repite en cada nodo de esa fila. */
export interface SunTable {
  /**
   * por mes: componentes del Sol (este, norte, arriba), elevación, direcciones del horizonte vecinas y peso, q (directa),
   * p (parte de la difusa del día en el paso) y e0 (radiación fuera de la atmósfera en un paso, kWh/m², normal al Sol)
   */
  months: { cx: Float32Array; cz: Float32Array; sinE: Float32Array; e: Float32Array; d0: Uint8Array; d1: Uint8Array; f: Float32Array; q: Float32Array; p: Float32Array; e0: number }[];
}

/** Paso del día (h) y espesor óptico del cielo despejado con que se reparte la directa en el día. */
const STEP_H = 0.5, TAU = 0.25;

/**
 * Tabla del Sol para una latitud: cada media hora solar, con la directa del día repartida como en un cielo despejado
 * (∝ sen e · exp(−τ / sen e)) y la difusa ∝ sen e; q = fracción de la directa horizontal del día en ese paso ÷ sen e,
 * así la directa sobre una superficie es B · Σ q · cos i (B = global − difusa del día).
 */
export function sunTable(lat: number, dirAz: ArrayLike<number>): SunTable {
  const nd = dirAz.length, order = Array.from({ length: nd }, (_, k) => k).sort((x, y) => dirAz[x] - dirAz[y]);
  const months = MONTH_DAY.map(n => {
    const rows: number[][] = [];
    for (let t = STEP_H / 2; t < 24; t += STEP_H) {
      const { e, az } = solarGeometry(lat, n, t);
      if (e <= 0.005) continue;
      // direcciones del horizonte a cada lado del azimut del Sol
      let k = nd - 1;
      while (k > 0 && dirAz[order[k]] > az) k--;
      let lo = order[k], hi = order[(k + 1) % nd];
      if (dirAz[order[0]] > az) { lo = order[nd - 1]; hi = order[0]; }
      const span = (dirAz[hi] - dirAz[lo] + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI, f = ((az - dirAz[lo] + 2 * Math.PI) % (2 * Math.PI)) / span;
      const s = Math.sin(e);
      rows.push([Math.cos(e) * Math.sin(az), Math.cos(e) * Math.cos(az), s, e, lo, hi, f, s * Math.exp(-TAU / s)]);
    }
    const sum = rows.reduce((acc, x) => acc + x[7], 0) || 1, sumS = rows.reduce((acc, x) => acc + x[2], 0) || 1;
    const col = (j: number) => Float32Array.from(rows, x => x[j]);
    return {
      cx: col(0), cz: col(1), sinE: col(2), e: col(3), d0: Uint8Array.from(rows, x => x[4]), d1: Uint8Array.from(rows, x => x[5]), f: col(6),
      q: Float32Array.from(rows, x => x[7] / sum / x[2]), p: Float32Array.from(rows, x => x[2] / sumS),
      e0: 1.367 * (1 + 0.033 * Math.cos((2 * Math.PI * n) / 365)) * STEP_H,
    };
  });
  return { months };
}

/** Pesos de cada dirección para integrar en el azimut (mitad del hueco con cada vecina; suman 2π). */
export function dirWeights(dirAz: ArrayLike<number>) {
  const nd = dirAz.length, order = Array.from({ length: nd }, (_, k) => k).sort((x, y) => dirAz[x] - dirAz[y]), wts = new Float64Array(nd);
  for (let k = 0; k < nd; k++) {
    const prev = dirAz[order[(k + nd - 1) % nd]], next = dirAz[order[(k + 1) % nd]], cur = dirAz[order[k]];
    wts[order[k]] = (((next - cur + 2 * Math.PI) % (2 * Math.PI)) + ((cur - prev + 2 * Math.PI) % (2 * Math.PI))) / 2;
  }
  return wts;
}

/**
 * Factor de vista del cielo de una superficie con pendiente y orientación (rad) y su horizonte (rad por dirección):
 * V = 1/2π ∫ [cos S · sen² H + sen S · cos(φ − A) · (H − sen H cos H)] dφ, con H = ángulo cenital del horizonte, que no
 * baja del plano de la propia superficie (Dozier y Marks 1987). Plano sin relieve alrededor: (1 + cos S) / 2.
 */
export function skyView(slope: number, aspect: number, hor: ArrayLike<number>, dirAz: ArrayLike<number>, wts: ArrayLike<number>) {
  const cs = Math.cos(slope), ss = Math.sin(slope), ts = Math.tan(slope);
  let v = 0;
  for (let k = 0; k < hor.length; k++) {
    const ca = Math.cos(dirAz[k] - aspect), plane = -Math.atan(ts * ca), H = Math.PI / 2 - Math.max(hor[k], plane), sh = Math.sin(H);
    v += wts[k] * (cs * sh * sh + ss * ca * (H - sh * Math.cos(H)));
  }
  return Math.max(0, Math.min(1, v / (2 * Math.PI)));
}

/** Rejilla regular por nodos: nodo (0, 0) en (lon0, lat0), fila 0 = norte. */
export interface SolarLattice { lon0: number; lat0: number; step: number; nx: number; ny: number }

/**
 * Clima de radiación: el nivel del año del Global Solar Atlas (media diaria de la global y la difusa, suavizada para no
 * contar dos veces la sombra de los cerros) y su reparto en los meses de NASA POWER (cada mes ÷ media del año).
 */
export interface SolarClimate {
  anual: SolarLattice & { ghi: number[]; dhi: number[] };
  /** [celda][mes] */
  meses: SolarLattice & { ghi: number[][]; dhi: number[][] };
}

/** Pesos bilineales de un punto en una rejilla (fuera, la orilla): índices de los 4 nodos y sus pesos. */
function lattice(g: SolarLattice, lon: number, lat: number) {
  const x = Math.max(0, Math.min(g.nx - 1.000001, (lon - g.lon0) / g.step)), y = Math.max(0, Math.min(g.ny - 1.000001, (g.lat0 - lat) / g.step));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, x1 = Math.min(g.nx - 1, x0 + 1), y1 = Math.min(g.ny - 1, y0 + 1);
  return [[y0 * g.nx + x0, (1 - fx) * (1 - fy)], [y0 * g.nx + x1, fx * (1 - fy)], [y1 * g.nx + x0, (1 - fx) * fy], [y1 * g.nx + x1, fx * fy]] as const;
}

/** Global y difusa (media diaria, kWh/m²·día) de cada mes en un punto. */
export function climateAt(c: SolarClimate, lon: number, lat: number) {
  const a = lattice(c.anual, lon, lat), m = lattice(c.meses, lon, lat);
  let ga = 0, da = 0;
  for (const [i, wt] of a) { ga += c.anual.ghi[i] * wt; da += c.anual.dhi[i] * wt; }
  const ghi = new Array<number>(12), dhi = new Array<number>(12);
  for (let k = 0; k < 12; k++) {
    let sg = 0, sd = 0;
    for (const [i, wt] of m) { sg += c.meses.ghi[i][k] * wt; sd += c.meses.dhi[i][k] * wt; }
    ghi[k] = ga * sg; dhi[k] = Math.min(ghi[k], da * sd);
  }
  return { ghi, dhi };
}

/**
 * Radiación sobre una superficie: devuelve la anual (kWh/m²) y, en out (si se da), la media diaria de cada mes
 * (kWh/m²·día) en 12 lugares; con parts, además directa, difusa y reflejada de cada mes en 12 × 3. hor: horizonte del
 * relieve (rad por dirección, como HORIZON_DIRS); V: factor de vista del cielo de la superficie. Difusa de Hay y Davies:
 * la parte circunsolar (índice de anisotropía = directa ÷ la de fuera de la atmósfera) llega como la directa, con la
 * sombra del horizonte; el resto es isotrópica.
 */
export function irradiation(t: SunTable, slope: number, aspect: number, hor: ArrayLike<number>, V: number, ghi: ArrayLike<number>, dhi: ArrayLike<number>,
  out?: Float64Array, parts?: Float64Array) {
  const cs = Math.cos(slope), sx = Math.sin(slope) * Math.sin(aspect), sz = Math.sin(slope) * Math.cos(aspect);
  let year = 0;
  for (let m = 0; m < 12; m++) {
    const M = t.months[m], n = M.q.length, g = ghi[m], d = Math.min(dhi[m], g), B = g - d, k0 = B / M.e0;
    let beam = 0, circ = 0, iso = 0;
    for (let k = 0; k < n; k++) {
      const A = Math.min(1, k0 * M.q[k]);
      iso += M.p[k] * (1 - A);
      const ci = cs * M.sinE[k] + sx * M.cx[k] + sz * M.cz[k];
      if (ci <= 0) continue;
      const hz = hor[M.d0[k]] * (1 - M.f[k]) + hor[M.d1[k]] * M.f[k];
      if (M.e[k] > hz) { beam += M.q[k] * ci; circ += (M.p[k] * A * ci) / M.sinE[k]; }
    }
    const b = B * beam, dif = d * (circ + iso * V), ref = ALBEDO * g * (1 - V), day = b + dif + ref;
    if (out) out[m] = day;
    if (parts) { parts[m * 3] = b; parts[m * 3 + 1] = dif; parts[m * 3 + 2] = ref; }
    year += day * MONTH_DAYS[m];
  }
  return year;
}

/** Capa anual en un byte: 8 kWh/m² por paso desde 500 (0 = sin dato). */
export const SOLAR_Q = { offset: 500, step: 8 };
export const solarToByte = (kwh: number) => Math.max(1, Math.min(255, Math.round((kwh - SOLAR_Q.offset) / SOLAR_Q.step)));
export const byteToSolar = (q: number) => (q ? SOLAR_Q.offset + q * SOLAR_Q.step : NaN);
