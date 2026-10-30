/**
 * Impresión 3D: alturas de la superficie a imprimir (mm por nodo, con relieves táctiles) y STL binario de una malla
 * cerrada: superficie, paredes verticales en el contorno y base plana. Sin dependencias: lo usan el worker y las pruebas.
 * Rejilla de impresión: nx × ny celdas (fila 0 = sur) y (nx + 1) × (ny + 1) nodos; x hacia el este, y hacia el norte.
 */
import { bilinear } from '../../shared/terrain';

/** Rejilla por nodos (como TerrainGrid): bounds = bordes de los píxeles [oeste, sur, este, norte], fila 0 = norte. */
export interface SourceGrid { width: number; height: number; bounds: [number, number, number, number]; data: Float32Array }

export interface PrintGrid {
  nx: number;
  ny: number;
  /** mm por celda hacia el este y hacia el norte */
  cx: number;
  cy: number;
  /** lon/lat del nodo suroeste y grados por celda */
  lon0: number;
  lat0: number;
  dLon: number;
  dLat: number;
}

export type RiverMode = 'no' | 'hundidos' | 'relieve';

export interface PrintParams {
  /** mm de altura por metro de elevación (escala horizontal × exageración) */
  mmPerM: number;
  /** grosor bajo el punto más bajo (mm) */
  base: number;
  rivers: RiverMode;
  /** área drenada mínima de los ríos (km²) */
  riverKm2: number;
  /** límites municipales en relieve (solo los que quedan dentro de lo que se imprime) */
  borders: boolean;
  /** alto (o hondo) de los relieves táctiles y ancho de sus líneas, mm */
  feature: number;
  line: number;
  /** localidades: posición y radio del domo (mm) */
  places: { lon: number; lat: number; r: number }[];
}

export interface PrintInput {
  grid: PrintGrid;
  elev: SourceGrid;
  /** área drenada (km², 90 m) para los ríos */
  acc?: SourceGrid | null;
  /** municipio de cada nodo (0 = fuera de Hidalgo) */
  muni: Uint8Array;
  /** celdas a imprimir (nx × ny) */
  inside: Uint8Array;
  params: PrintParams;
}

export interface PrintSurface {
  /** altura de cada nodo sobre la cara de abajo (mm) */
  top: Float32Array;
  /** celdas que se imprimen, ya sin cruces en diagonal */
  inside: Uint8Array;
  cells: number;
  elevMin: number;
  elevMax: number;
  /** alto total del modelo (mm) */
  height: number;
}

/** Valor bilineal de una rejilla por nodos en lon/lat (NaN si no hay dato alrededor). */
export function sampleLL(g: SourceGrid, lon: number, lat: number) {
  const [W, S, E, N] = g.bounds;
  const x = ((lon - W) / (E - W)) * g.width - 0.5, y = ((N - lat) / (N - S)) * g.height - 0.5;
  if (x < -0.5 || y < -0.5 || x > g.width - 0.5 || y > g.height - 0.5) return NaN;
  return bilinear(g.data, g.width, g.height, x, y);
}

/**
 * Quita los cruces en diagonal (dos celdas que solo se tocan por una esquina) sumando una de las otras dos: así cada
 * vértice del contorno es una variedad y los programas de laminado no se quejan. Modifica inside.
 */
export function cleanMask(inside: Uint8Array, nx: number, ny: number) {
  for (let changed = true; changed;) {
    changed = false;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i, a = inside[k], b = inside[k + 1], c = inside[k + nx], d = inside[k + nx + 1];
      if (a && d && !b && !c) { inside[k + 1] = 1; changed = true; }
      else if (b && c && !a && !d) { inside[k] = 1; changed = true; }
    }
  }
}

/** Distancia euclidiana (en nodos) de cada nodo al nodo marcado más cercano (Felzenszwalb y Huttenlocher). */
export function distanceField(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e20, n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const g = new Float64Array(w * h);
  for (let k = 0; k < w * h; k++) g[k] = mask[k] ? 0 : INF;
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  for (let c = 0; c < w; c++) { for (let r = 0; r < h; r++) f[r] = g[r * w + c]; pass(h); for (let r = 0; r < h; r++) g[r * w + c] = d[r]; }
  const out = new Float32Array(w * h);
  for (let r = 0; r < h; r++) { for (let c = 0; c < w; c++) f[c] = g[r * w + c]; pass(w); for (let c = 0; c < w; c++) out[r * w + c] = Math.sqrt(d[c]); }
  return out;
}

/**
 * Nodos de la rejilla de impresión por donde pasan los ríos: cada celda con área drenada ≥ minKm2 se une con su vecina
 * de más área (río abajo, aproximado) con un segmento, así la línea queda continua a cualquier escala.
 */
export function riverNodes(acc: SourceGrid, g: PrintGrid, minKm2: number): Uint8Array {
  const W = g.nx + 1, H = g.ny + 1, out = new Uint8Array(W * H), { width: w, height: h, data: a } = acc;
  const [W0, S0, E0, N0] = acc.bounds, dl = (E0 - W0) / w, dt = (N0 - S0) / h;
  const px = (c: number) => (W0 + (c + 0.5) * dl - g.lon0) / g.dLon, py = (r: number) => (N0 - (r + 0.5) * dt - g.lat0) / g.dLat;
  const mark = (x: number, y: number) => {
    const i = Math.round(x), j = Math.round(y);
    if (i >= 0 && j >= 0 && i < W && j < H) out[j * W + i] = 1;
  };
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const v = a[r * w + c];
    if (!(v >= minKm2)) continue;
    let best = -1, bv = v;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if ((dr || dc) && rr >= 0 && cc >= 0 && rr < h && cc < w && a[rr * w + cc] > bv) { bv = a[rr * w + cc]; best = rr * w + cc; }
    }
    const x0 = px(c), y0 = py(r);
    if (best < 0) { mark(x0, y0); continue; }
    const x1 = px(best % w), y1 = py(Math.floor(best / w)), steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2));
    for (let s = 0; s <= steps; s++) mark(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
  }
  return out;
}

/** Línea táctil con borde suavizado: 1 dentro del ancho, 0 fuera (d y half en mm, cell = mm por nodo). */
const lineProfile = (d: number, half: number, cell: number) => {
  const t = Math.min(1, Math.max(0, (half + cell / 2 - d) / cell));
  return t * t * (3 - 2 * t);
};

/** Alturas de la superficie (mm) con base, exageración y relieves táctiles. */
export function buildSurface(input: PrintInput): PrintSurface {
  const { grid: g, elev, acc, muni, params: p } = input, { nx, ny } = g, W = nx + 1, H = ny + 1;
  const inside = input.inside.slice();
  // elevación de cada nodo; un nodo sin dato toma el del vecino válido más cercano (las celdas del borde lo necesitan)
  const z = new Float32Array(W * H), queue = new Int32Array(W * H);
  let qh = 0, qt = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, v = sampleLL(elev, g.lon0 + i * g.dLon, g.lat0 + j * g.dLat);
    z[k] = v;
    if (v === v) queue[qt++] = k;
  }
  if (!qt) throw new Error('No hay relieve en esa área');
  // una celda se imprime solo si sus cuatro esquinas tienen dato
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * W + i;
    if (inside[j * nx + i] && !(z[k] === z[k] && z[k + 1] === z[k + 1] && z[k + W] === z[k + W] && z[k + W + 1] === z[k + W + 1])) inside[j * nx + i] = 0;
  }
  while (qh < qt) {
    const k = queue[qh++], i = k % W, j = (k - i) / W;
    for (const n of [i > 0 ? k - 1 : -1, i < W - 1 ? k + 1 : -1, j > 0 ? k - W : -1, j < H - 1 ? k + W : -1]) {
      if (n >= 0 && z[n] !== z[n]) { z[n] = z[k]; queue[qt++] = n; }
    }
  }
  cleanMask(inside, nx, ny);
  // nodos que tocan alguna celda impresa y nodos con las cuatro celdas impresas (interiores)
  const touch = new Uint8Array(W * H), interior = new Uint8Array(W * H);
  let cells = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!inside[j * nx + i]) continue;
    cells++;
    const k = j * W + i;
    touch[k] = touch[k + 1] = touch[k + W] = touch[k + W + 1] = 1;
  }
  if (!cells) throw new Error('El área no tiene celdas que imprimir');
  for (let j = 1; j < ny; j++) for (let i = 1; i < nx; i++) {
    interior[j * W + i] = inside[j * nx + i] & inside[j * nx + i - 1] & inside[(j - 1) * nx + i] & inside[(j - 1) * nx + i - 1];
  }
  let elevMin = Infinity, elevMax = -Infinity;
  for (let k = 0; k < W * H; k++) if (touch[k]) { if (z[k] < elevMin) elevMin = z[k]; if (z[k] > elevMax) elevMax = z[k]; }
  const top = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) top[k] = p.base + (z[k] - elevMin) * p.mmPerM;

  // relieves táctiles (en mm; la distancia en nodos se pasa a mm con la celda media)
  const cell = (g.cx + g.cy) / 2, half = p.line / 2, reach = half + cell;
  if (p.rivers !== 'no' && acc) {
    const dist = distanceField(riverNodes(acc, g, p.riverKm2), W, H), sign = p.rivers === 'hundidos' ? -1 : 1;
    for (let k = 0; k < W * H; k++) { const d = dist[k] * cell; if (d < reach) top[k] += sign * p.feature * lineProfile(d, half, cell); }
  }
  if (p.borders) {
    const edge = new Uint8Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i, m = muni[k];
      if (!interior[k]) continue;
      if ((i < W - 1 && muni[k + 1] !== m && interior[k + 1]) || (j < H - 1 && muni[k + W] !== m && interior[k + W])) edge[k] = 1;
    }
    const dist = distanceField(edge, W, H);
    for (let k = 0; k < W * H; k++) { const d = dist[k] * cell; if (d < reach) top[k] += p.feature * lineProfile(d, half, cell); }
  }
  // domos de las localidades: donde se enciman cuenta el más alto (dos ciudades juntas no hacen una loma doble)
  if (p.places.length) {
    const bump = new Float32Array(W * H);
    for (const pl of p.places) {
      const ci = (pl.lon - g.lon0) / g.dLon, cj = (pl.lat - g.lat0) / g.dLat, ri = pl.r / g.cx, rj = pl.r / g.cy;
      for (let j = Math.max(0, Math.floor(cj - rj)); j <= Math.min(H - 1, Math.ceil(cj + rj)); j++) {
        for (let i = Math.max(0, Math.floor(ci - ri)); i <= Math.min(W - 1, Math.ceil(ci + ri)); i++) {
          const q = ((i - ci) * g.cx) ** 2 + ((j - cj) * g.cy) ** 2, k = j * W + i;
          if (q < pl.r * pl.r) bump[k] = Math.max(bump[k], p.feature * Math.sqrt(1 - q / (pl.r * pl.r)));
        }
      }
    }
    for (let k = 0; k < W * H; k++) top[k] += bump[k];
  }
  // un río hundido junto al punto más bajo no debe atravesar la base
  let height = 0;
  for (let k = 0; k < W * H; k++) { if (top[k] < 0.4) top[k] = 0.4; if (touch[k] && top[k] > height) height = top[k]; }
  return { top, inside, cells, elevMin, elevMax, height };
}

/** Triángulos de la malla cerrada: 2 arriba y 2 abajo por celda, y 2 por cada lado de celda en el contorno. */
export function triangleCount(inside: Uint8Array, nx: number, ny: number) {
  let n = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (!inside[k]) continue;
    n += 4;
    if (i === 0 || !inside[k - 1]) n += 2;
    if (i === nx - 1 || !inside[k + 1]) n += 2;
    if (j === 0 || !inside[k - nx]) n += 2;
    if (j === ny - 1 || !inside[k + nx]) n += 2;
  }
  return n;
}

/** Bytes del STL binario: encabezado de 80, cuenta de 4 y 50 por triángulo. */
export const stlBytes = (triangles: number) => 84 + 50 * triangles;

/**
 * STL binario de la malla cerrada (mm; normales hacia afuera y vértices en sentido antihorario vistos desde afuera).
 * La diagonal de cada celda de arriba sigue al relieve (la de menor diferencia de altura).
 */
export function writeStl(s: PrintSurface, g: PrintGrid, header = 'Relieve de Hidalgo - modelo para impresion 3D'): ArrayBuffer {
  const { nx, ny, cx, cy } = g, W = nx + 1, top = s.top, inside = s.inside;
  const n = triangleCount(inside, nx, ny), buf = new ArrayBuffer(stlBytes(n)), dv = new DataView(buf);
  for (let k = 0; k < Math.min(80, header.length); k++) dv.setUint8(k, header.charCodeAt(k) & 0x7f);
  dv.setUint32(80, n, true);
  let o = 84;
  const tri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, qx: number, qy: number, qz: number) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = qx - ax, vy = qy - ay, vz = qz - az;
    const nX = uy * vz - uz * vy, nY = uz * vx - ux * vz, nZ = ux * vy - uy * vx, l = Math.hypot(nX, nY, nZ) || 1;
    dv.setFloat32(o, nX / l, true); dv.setFloat32(o + 4, nY / l, true); dv.setFloat32(o + 8, nZ / l, true);
    dv.setFloat32(o + 12, ax, true); dv.setFloat32(o + 16, ay, true); dv.setFloat32(o + 20, az, true);
    dv.setFloat32(o + 24, bx, true); dv.setFloat32(o + 28, by, true); dv.setFloat32(o + 32, bz, true);
    dv.setFloat32(o + 36, qx, true); dv.setFloat32(o + 40, qy, true); dv.setFloat32(o + 44, qz, true);
    dv.setUint16(o + 48, 0, true);
    o += 50;
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i;
    if (!inside[c]) continue;
    const k = j * W + i, x0 = i * cx, x1 = x0 + cx, y0 = j * cy, y1 = y0 + cy;
    const z00 = top[k], z10 = top[k + 1], z01 = top[k + W], z11 = top[k + W + 1];
    // arriba
    if (Math.abs(z00 - z11) <= Math.abs(z10 - z01)) {
      tri(x0, y0, z00, x1, y0, z10, x1, y1, z11);
      tri(x0, y0, z00, x1, y1, z11, x0, y1, z01);
    } else {
      tri(x0, y0, z00, x1, y0, z10, x0, y1, z01);
      tri(x1, y0, z10, x1, y1, z11, x0, y1, z01);
    }
    // abajo (z = 0, normal hacia abajo)
    tri(x0, y0, 0, x1, y1, 0, x1, y0, 0);
    tri(x0, y0, 0, x0, y1, 0, x1, y1, 0);
    // paredes del contorno
    if (j === 0 || !inside[c - nx]) { tri(x0, y0, 0, x1, y0, 0, x1, y0, z10); tri(x0, y0, 0, x1, y0, z10, x0, y0, z00); }
    if (j === ny - 1 || !inside[c + nx]) { tri(x1, y1, 0, x0, y1, 0, x0, y1, z01); tri(x1, y1, 0, x0, y1, z01, x1, y1, z11); }
    if (i === 0 || !inside[c - 1]) { tri(x0, y1, 0, x0, y0, 0, x0, y0, z00); tri(x0, y1, 0, x0, y0, z00, x0, y1, z01); }
    if (i === nx - 1 || !inside[c + 1]) { tri(x1, y0, 0, x1, y1, 0, x1, y1, z11); tri(x1, y0, 0, x1, y1, z11, x1, y0, z10); }
  }
  return buf;
}

/**
 * Vista previa: sombreado del modelo como se vería impreso en un material claro (luz del noroeste), con lo que no se
 * imprime transparente. Fila 0 = norte. maxPx = lado mayor de la imagen.
 */
export function previewImage(s: PrintSurface, g: PrintGrid, maxPx: number) {
  const step = Math.max(1, Math.ceil(Math.max(g.nx, g.ny) / maxPx)), w = Math.max(1, Math.floor(g.nx / step)), h = Math.max(1, Math.floor(g.ny / step));
  const W = g.nx + 1, top = s.top, rgba = new Uint8ClampedArray(w * h * 4);
  const L = [-0.5, 0.5, 0.71], ll = Math.hypot(L[0], L[1], L[2]);
  const at = (i: number, j: number) => top[Math.min(g.ny, Math.max(0, j)) * W + Math.min(g.nx, Math.max(0, i))];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = x * step, j = (h - 1 - y) * step;
    if (!s.inside[Math.min(g.ny - 1, j) * g.nx + Math.min(g.nx - 1, i)]) continue;
    const dzx = (at(i + step, j) - at(i - step, j)) / (2 * step * g.cx), dzy = (at(i, j + step) - at(i, j - step)) / (2 * step * g.cy);
    const nl = Math.hypot(dzx, dzy, 1), lam = Math.max(0, (-dzx * L[0] - dzy * L[1] + L[2]) / (nl * ll));
    const v = 0.28 + 0.72 * lam, o = (y * w + x) * 4;
    rgba[o] = 236 * v; rgba[o + 1] = 230 * v; rgba[o + 2] = 218 * v; rgba[o + 3] = 255;
  }
  return { width: w, height: h, rgba };
}
