/**
 * Relieve para los análisis: tipos de las consultas al worker de relieve y algoritmos sin dependencias (también los
 * usan las pruebas en Node). Rejillas por nodos: el valor (r, c) es el del punto, no el promedio de una celda.
 */

/** Rejilla de resultados lista para MapApi.addRaster: bounds = bordes de los píxeles [oeste, sur, este, norte]. */
export interface TerrainGrid {
  width: number;
  height: number;
  bounds: [number, number, number, number];
  /** metros por píxel (≈) */
  res: number;
  /** fila 0 = norte; NaN = sin dato (o 0 en máscaras) */
  data: Float32Array | Uint8Array;
}

export type GridKind = 'elevacion' | 'pendiente' | 'orientacion' | 'acumulacion';

export interface Profile {
  /** distancia acumulada (km) y elevación (m) de cada muestra */
  km: Float32Array;
  elev: Float32Array;
  lon: Float32Array;
  lat: Float32Array;
}

export interface Watershed {
  /** máscara de la cuenca (1 = drena al punto) */
  grid: TerrainGrid;
  areaKm2: number;
  /** punto de salida, ajustado al cauce más cercano */
  outlet: [number, number];
  /** parte de la cuenca podría quedar fuera de la zona del mapa (toca el borde de la rejilla) */
  truncated: boolean;
}

export interface FlowPath { lon: Float32Array; lat: Float32Array; km: number }

/** Vecinos D8 [dfila, dcolumna] en el orden de los códigos de dirección 0–7 (los de scripts/pipeline/hidro.mjs). */
export const D8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]] as const;

/** Lado de las teselas de detalle en celdas del visor (lo fija la cadena de datos; viene en la cabecera de los paquetes). */
export const TILE_CELLS = 16;

/**
 * Normal (x, z) por el método de Horn sobre una rejilla de alturas (m) con margen de un nodo: devuelve las de los nodos
 * centrales (w − 2) × (h − 2). Un nodo sin dato (≤ 0) cuenta como el central. dxm, dzm: metros entre nodos.
 */
export function hornNormals(z: ArrayLike<number>, w: number, h: number, dxm: number, dzm: number, out: Float32Array) {
  const iw = w - 2;
  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c, z0 = z[i], o = ((r - 1) * iw + c - 1) * 2;
      if (z0 <= 0) { out[o] = 0; out[o + 1] = 0; continue; }
      const g = (k: number) => (z[k] > 0 ? z[k] : z0);
      const a = g(i - w - 1), b = g(i - w), cc = g(i - w + 1), dl = g(i - 1), dr = g(i + 1), e = g(i + w - 1), fd = g(i + w), gg = g(i + w + 1);
      const gx = (cc + 2 * dr + gg - (a + 2 * dl + e)) / (8 * dxm);
      const gz = (e + 2 * fd + gg - (a + 2 * b + cc)) / (8 * dzm);
      const il = 1 / Math.hypot(gx, 1, gz);
      out[o] = -gx * il; out[o + 1] = -gz * il;
    }
  }
  return out;
}

/** Pendiente (grados) u orientación (grados desde el norte, sentido horario; NaN en lo plano) por diferencias centradas. */
export function slopeGrid(z: Float32Array, w: number, h: number, dxm: number, dzm: number, kind: 'pendiente' | 'orientacion') {
  const out = new Float32Array(w * h).fill(NaN);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c;
    if (!(z[i] > 0)) continue;
    const at = (rr: number, cc: number) => { const v = z[Math.min(h - 1, Math.max(0, rr)) * w + Math.min(w - 1, Math.max(0, cc))]; return v > 0 ? v : z[i]; };
    const ge = (at(r, c + 1) - at(r, c - 1)) / ((c > 0 && c < w - 1 ? 2 : 1) * dxm);
    const gs = (at(r + 1, c) - at(r - 1, c)) / ((r > 0 && r < h - 1 ? 2 : 1) * dzm);
    if (kind === 'pendiente') out[i] = (Math.atan(Math.hypot(ge, gs)) * 180) / Math.PI;
    else if (Math.hypot(ge, gs) > 1e-3) out[i] = ((Math.atan2(-ge, gs) * 180) / Math.PI + 360) % 360;
  }
  return out;
}

/** Celdas que drenan a cada celda (incluida ella), por orden topológico; dir: D8 (−1 = sale de la rejilla). */
export function flowAccumulation(dir: Int8Array, w: number, h: number) {
  const n = w * h, indeg = new Uint8Array(n), acc = new Float32Array(n).fill(1), down = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const d = dir[i];
    if (d < 0) continue;
    const r = (i / w) | 0, c = i - r * w, rr = r + D8[d][0], cc = c + D8[d][1];
    if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
    down[i] = rr * w + cc;
    indeg[down[i]]++;
  }
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) if (!indeg[i]) queue[tail++] = i;
  while (head < tail) {
    const i = queue[head++], j = down[i];
    if (j < 0) continue;
    acc[j] += acc[i];
    if (--indeg[j] === 0) queue[tail++] = j;
  }
  return acc;
}

/** Celda de mayor acumulación a menos de `radius` celdas de i (para que un clic caiga sobre el cauce). */
export function snapToStream(acc: Float32Array, w: number, h: number, i: number, radius: number) {
  const r0 = (i / w) | 0, c0 = i - r0 * w;
  let best = i;
  for (let r = Math.max(0, r0 - radius); r <= Math.min(h - 1, r0 + radius); r++) {
    for (let c = Math.max(0, c0 - radius); c <= Math.min(w - 1, c0 + radius); c++) {
      if ((r - r0) ** 2 + (c - c0) ** 2 > radius * radius) continue;
      if (acc[r * w + c] > acc[best]) best = r * w + c;
    }
  }
  return best;
}

/**
 * Cuenca de la celda i: todas las que drenan hacia ella, recorriendo el flujo al revés.
 * Devuelve la máscara, el número de celdas y si alguna está en el borde de la rejilla (cuenca posiblemente recortada).
 */
export function upstreamMask(dir: Int8Array, w: number, h: number, i: number) {
  const mask = new Uint8Array(w * h), queue = new Int32Array(w * h);
  let head = 0, tail = 0, edge = false;
  mask[i] = 1; queue[tail++] = i;
  while (head < tail) {
    const j = queue[head++], r = (j / w) | 0, c = j - r * w;
    if (r === 0 || c === 0 || r === h - 1 || c === w - 1) edge = true;
    for (let k = 0; k < 8; k++) {
      const rr = r - D8[k][0], cc = c - D8[k][1];
      if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      const n = rr * w + cc;
      // el vecino n apunta a j si su dirección es justo la contraria al desplazamiento j → n
      if (!mask[n] && dir[n] === k) { mask[n] = 1; queue[tail++] = n; }
    }
  }
  return { mask, cells: tail, edge };
}

/** Trayectoria del agua desde la celda i siguiendo D8 hasta salir de la rejilla (o maxSteps). */
export function downstreamPath(dir: Int8Array, w: number, h: number, i: number, maxSteps = 1e6) {
  const path = [i], seen = new Set([i]);
  for (let k = 0; k < maxSteps; k++) {
    const d = dir[i];
    if (d < 0) break;
    const r = ((i / w) | 0) + D8[d][0], c = (i % w) + D8[d][1];
    if (r < 0 || c < 0 || r >= h || c >= w) break;
    i = r * w + c;
    if (seen.has(i)) break;
    seen.add(i);
    path.push(i);
  }
  return path;
}

/**
 * Consultas de relieve para los análisis (ctx.data.terrain()), a la mejor resolución disponible: 30 m donde hay
 * teselas, si no 90 m. Corren en el worker de relieve del visor.
 */
export interface TerrainApi {
  /** elevación (m s. n. m.) de cada punto; NaN fuera de la zona con dato */
  elevation(lon: ArrayLike<number>, lat: ArrayLike<number>): Promise<Float32Array>;
  /** perfil a lo largo de una polilínea, con muestras cada stepM metros (30 por omisión) */
  profile(lon: number[], lat: number[], stepM?: number): Promise<Profile>;
  /** rejilla de elevación (m), pendiente (°), orientación (° desde el norte) o área drenada (km², 90 m) */
  grid(kind: GridKind, bounds: [number, number, number, number], res?: 30 | 90): Promise<TerrainGrid>;
  /** cuenca que drena al punto (ajustado al cauce más cercano a menos de snapM metros) */
  watershed(lon: number, lat: number, snapM?: number): Promise<Watershed>;
  /** camino del agua desde el punto, río abajo */
  flowPath(lon: number, lat: number, maxKm?: number): Promise<FlowPath>;
}
