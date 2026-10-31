/**
 * Edificios: lectura de una tesela de capas/edificios.bin (ver scripts/pipeline/build-edificios.mjs) y su geometría para
 * la GPU. Sin dependencias: lo usan el worker de relieve y las pruebas.
 *
 * Cada edificio es un prisma: anillo de arriba y de abajo (la altura la pone el sombreador sobre el relieve), paredes
 * hacia afuera y techo plano triangulado (orejas: las huellas pueden ser cóncavas). El anillo viene en sentido horario
 * en (x este, z sur), así las caras de las paredes miran hacia afuera y las del techo hacia arriba.
 */

/** unidades por celda de la rejilla del visor en las coordenadas de la tesela */
export const BLD_Q = 3600;

export interface BuildingTile {
  /** edificios */
  n: number;
  /** por vértice: x, z en celdas de la rejilla del visor; 1 = anillo de arriba, 0 = de abajo */
  pos: Float32Array;
  /** por vértice: centro del edificio (celdas), donde se mide el relieve para apoyarlo */
  center: Float32Array;
  /** por vértice: altura (m × 4), número al azar del edificio (colores), 0, 0 */
  info: Uint8Array;
  index: Uint32Array;
}

export interface DecodedBuildings {
  n: number;
  /** vértices de cada edificio */
  nv: Uint8Array;
  /** altura estimada (m × 4) */
  h: Uint8Array;
  /** x, z de todos los vértices, en celdas de la rejilla del visor */
  xz: Float32Array;
}

/** Edificios de la tesela (tx, ty) de tileCells celdas por lado (bytes ya descomprimidos). */
export function decodeBuildings(bytes: Uint8Array, tx: number, ty: number, tileCells: number): DecodedBuildings {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0, true);
  const nv = bytes.slice(4, 4 + n), h = bytes.slice(4 + n, 4 + 2 * n);
  let o = 4 + 2 * n;
  o += o & 1;
  let total = 0;
  for (let b = 0; b < n; b++) total += nv[b];
  const xz = new Float32Array(total * 2), ox = tx * tileCells - 1, oz = ty * tileCells - 1;
  let r = o + n * 4, k = 0;
  for (let b = 0; b < n; b++) {
    let x = dv.getUint16(o + b * 4, true), z = dv.getUint16(o + b * 4 + 2, true);
    xz[k++] = ox + x / BLD_Q; xz[k++] = oz + z / BLD_Q;
    for (let v = 1; v < nv[b]; v++) {
      x += dv.getInt16(r, true); z += dv.getInt16(r + 2, true); r += 4;
      xz[k++] = ox + x / BLD_Q; xz[k++] = oz + z / BLD_Q;
    }
  }
  return { n, nv, h, xz };
}

/**
 * Triangula un anillo simple (n vértices desde el vértice first de xz) por orejas; los triángulos conservan el sentido
 * del anillo. Escribe índices base + i en out.
 */
export function triangulate(xz: ArrayLike<number>, first: number, n: number, base: number, out: number[]) {
  const X = (i: number) => xz[(first + i) * 2], Z = (i: number) => xz[(first + i) * 2 + 1];
  if (n === 3) { out.push(base, base + 1, base + 2); return; }
  let a = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += X(i) * Z(j) - X(j) * Z(i); }
  const s = a < 0 ? -1 : 1;
  const cross = (i: number, j: number, k: number) => (X(j) - X(i)) * (Z(k) - Z(i)) - (Z(j) - Z(i)) * (X(k) - X(i));
  const idx = Array.from({ length: n }, (_, i) => i);
  while (idx.length > 3) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      if (cross(i0, i1, i2) * s <= 0) continue;   // vértice entrante (o alineado): no es oreja
      let inside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (cross(i0, i1, j) * s >= 0 && cross(i1, i2, j) * s >= 0 && cross(i2, i0, j) * s >= 0) { inside = true; break; }
      }
      if (inside) continue;
      out.push(base + i0, base + i1, base + i2);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    // anillo que se cruza a sí mismo (la detección a veces los deja): lo que queda, en abanico
    if (!cut) { for (let k = 1; k + 1 < idx.length; k++) out.push(base + idx[0], base + idx[k], base + idx[k + 1]); return; }
  }
  out.push(base + idx[0], base + idx[1], base + idx[2]);
}

/** Número al azar fijo (0–255) a partir de un vértice. */
function rnd(x: number, z: number) {
  let h = Math.imul(Math.round(x * BLD_Q) ^ 0x27d4eb2d, 0x85ebca6b) ^ Math.imul(Math.round(z * BLD_Q), 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) & 255;
}

/** Geometría de una tesela: vértices de arriba y de abajo de cada edificio, paredes y techo. */
export function buildingGeometry(d: DecodedBuildings): BuildingTile {
  // por edificio de m vértices: 2m vértices, 2m triángulos de pared y m − 2 de techo
  let verts = 0, tris = 0;
  for (let b = 0; b < d.n; b++) { verts += d.nv[b] * 2; tris += 3 * d.nv[b] - 2; }
  const pos = new Float32Array(verts * 3), center = new Float32Array(verts * 2), info = new Uint8Array(verts * 4);
  const index = new Uint32Array(tris * 3), roof: number[] = [];
  let v = 0, first = 0, t = 0;
  for (let b = 0; b < d.n; b++) {
    const m = d.nv[b];
    let cx = 0, cz = 0;
    for (let k = 0; k < m; k++) { cx += d.xz[(first + k) * 2]; cz += d.xz[(first + k) * 2 + 1]; }
    cx /= m; cz /= m;
    const r = rnd(d.xz[first * 2], d.xz[first * 2 + 1]);
    for (let top = 1; top >= 0; top--) for (let k = 0; k < m; k++) {
      const i = v + (1 - top) * m + k;
      pos[i * 3] = d.xz[(first + k) * 2]; pos[i * 3 + 1] = d.xz[(first + k) * 2 + 1]; pos[i * 3 + 2] = top;
      center[i * 2] = cx; center[i * 2 + 1] = cz;
      info[i * 4] = d.h[b]; info[i * 4 + 1] = r;
    }
    // paredes: (abajo k, abajo k+1, arriba k+1) y (abajo k, arriba k+1, arriba k)
    for (let k = 0; k < m; k++) {
      const t0 = v + k, t1 = v + ((k + 1) % m), b0 = v + m + k, b1 = v + m + ((k + 1) % m);
      index[t++] = b0; index[t++] = b1; index[t++] = t1;
      index[t++] = b0; index[t++] = t1; index[t++] = t0;
    }
    roof.length = 0;
    triangulate(d.xz, first, m, v, roof);
    index.set(roof, t);
    t += roof.length;
    v += 2 * m;
    first += m;
  }
  return { n: d.n, pos, center, info, index };
}
