import { buildingGeometry, decodeBuildings } from '../shared/buildings';
import { makeGeo, type Geo } from '../shared/geo';
import {
  D8, EARTH_R, bilinear, downstreamPath, floodLevels, flowAccumulation, hornNormals, longestFlowPath, losLift, maskOutline, slopeGrid, snapToStream,
  upstreamMask, viewshedRays, type Flood, type FlowPath, type GridKind, type Profile, type TerrainGrid, type Tower, type Viewshed, type Watershed,
} from '../shared/terrain';
import type { DetailResult, GridMeta, TerrainMessage, TerrainRequest } from '../shared/types';
import { decodeDetail, decodeElev, fetchBin } from './decode';
import { Pack, gunzip, type PackInfo } from './pack';

/**
 * Worker de relieve, uno por visor y de larga vida:
 *   · relieve de 90 m para el sombreado fino (normales + altura), que se queda también aquí para los análisis
 *   · teselas de 30 m (altura + normal) e imagen satelital fina para el detalle al acercarse
 *   · teselas de edificios: geometría de paredes y techos lista para la GPU
 *   · consultas de los análisis: elevación, perfil, rejillas de elevación/pendiente/orientación/acumulación,
 *     cuenca y trayectoria del agua (D8 a 90 m), inundación y zona visible desde torres
 */
const ctx = self as unknown as { postMessage(msg: TerrainMessage, transfer?: Transferable[]): void; onmessage: ((ev: MessageEvent<TerrainRequest>) => void) | null };

let grid: GridMeta, geo: Geo, urls: Extract<TerrainRequest, { type: 'init' }>['urls'];
let demPack: Pack | null = null, satPack: Pack | null = null, bldPack: Pack | null = null;
interface Detail90 { w: number; h: number; f: number; z: Int16Array }
/** relieve de 90 m (m, entero; 0 = sin dato) */
let d90: Promise<Detail90> | null = null;
let flow: Promise<{ w: number; h: number; f: number; dir: Int8Array }> | null = null;
let acc: Promise<Float32Array> | null = null;
/** teselas de 30 m decodificadas (cuartos de metro con margen), las más recientes */
const demCache = new Map<number, Promise<Uint16Array | null>>();

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
/** Número a media precisión (IEEE 754 binary16), redondeado al más cercano. */
function toHalf(v: number) {
  f32[0] = v;
  const x = u32[0], sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112, m = x & 0x7fffff;
  if (e <= 0) return e < -10 ? sign : sign | ((((m | 0x800000) >> (1 - e)) + 0x1000) >> 13);
  if (e >= 31) return sign | 0x7c00;
  return sign | ((e << 10) + ((m + 0x1000) >> 13));
}

/** Relieve de 90 m; con send, además las normales (Horn, escala real) y la altura para la GPU. Aquí queda una copia entera. */
async function decode90(send: boolean): Promise<Detail90> {
  const t = performance.now();
  const d = decodeDetail(await fetchBin(urls.detail));
  const { w, h, f, data: z } = d;
  const kept: Detail90 = { w, h, f, z: Int16Array.from(z) };
  if (!send) return kept;
  const dxm = (grid.step / f) * geo.KX * 1000, dzm = (grid.step / f) * geo.KZ * 1000;
  const normal = new Uint16Array(w * h * 2), row = new Float32Array((w + 2) * 3), nr = new Float32Array(w * 2);
  for (let r = 0; r < h; r++) {
    // tres filas con margen de un nodo (repitiendo la orilla) para usar hornNormals por renglón
    for (let k = 0; k < 3; k++) {
      const rr = Math.min(h - 1, Math.max(0, r + k - 1));
      for (let c = 0; c < w + 2; c++) row[k * (w + 2) + c] = z[rr * w + Math.min(w - 1, Math.max(0, c - 1))];
    }
    hornNormals(row, w + 2, 3, dxm, dzm, nr);
    for (let c = 0; c < w; c++) { normal[(r * w + c) * 2] = toHalf(nr[c * 2]); normal[(r * w + c) * 2 + 1] = toHalf(nr[c * 2 + 1]); }
  }
  const msg: DetailResult = { type: 'detail', w, h, f, normal, elev: z, ms: Math.round(performance.now() - t) };
  ctx.postMessage(msg, [normal.buffer, z.buffer]);
  return kept;
}

const detail = () => (d90 ??= decode90(false));

const flowDirs = () => (flow ??= fetchBin(urls.flow).then(buf => {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x31484852) throw new Error('flujo-90m.bin no tiene el formato esperado');
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true), f = dv.getUint32(12, true);
  return { w, h, f, dir: new Int8Array(buf.buffer.slice(buf.byteOffset + 16, buf.byteOffset + 16 + w * h)) };
}));
const accumulation = () => (acc ??= flowDirs().then(({ w, h, dir }) => flowAccumulation(dir, w, h)));

/** Tesela de 30 m (cuartos de metro, (px)² con margen de un nodo), con caché de las 400 más recientes. */
function demTile(index: number): Promise<Uint16Array | null> {
  let p = demCache.get(index);
  if (p) { demCache.delete(index); demCache.set(index, p); return p; }
  p = (async () => {
    const pack = demPack!, info = await pack.open(), bytes = await pack.tile(index);
    if (!bytes) return null;
    return Uint16Array.from(decodeElev(await gunzip(bytes), info.px, info.px));
  })();
  p.catch(() => demCache.delete(index));
  demCache.set(index, p);
  if (demCache.size > 400) demCache.delete(demCache.keys().next().value!);
  return p;
}

/** Tesela de 30 m para la GPU: RG16 por nodo central (altura en cuartos de metro; normal x, z en 8 + 8 bits). */
async function demRender(index: number) {
  const q = await demTile(index);
  if (!q) return null;
  const info = demPack!.info!, P = info.px, I = P - 2, f = info.f;
  const zm = new Float32Array(P * P);
  for (let k = 0; k < P * P; k++) zm[k] = q[k] * 0.25;
  const n = hornNormals(zm, P, P, (grid.step / f) * geo.KX * 1000, (grid.step / f) * geo.KZ * 1000, new Float32Array(I * I * 2));
  const out = new Uint16Array(I * I * 2);
  for (let r = 0; r < I; r++) for (let c = 0; c < I; c++) {
    const o = r * I + c, nx = Math.round((n[o * 2] * 0.5 + 0.5) * 255), nz = Math.round((n[o * 2 + 1] * 0.5 + 0.5) * 255);
    out[o * 2] = q[(r + 1) * P + c + 1];
    out[o * 2 + 1] = (nx << 8) | nz;
  }
  return out;
}

/** Edificios de una tesela: paredes y techos (shared/buildings.ts). */
async function bldRender(index: number) {
  const pack = bldPack!, info = await pack.open(), bytes = await pack.tile(index);
  if (!bytes) return null;
  return buildingGeometry(decodeBuildings(await gunzip(bytes), index % info.nx, Math.floor(index / info.nx), info.tileCells));
}

async function satRender(index: number) {
  const bytes = await satPack!.tile(index);
  if (!bytes) return null;
  return createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

/* ================= consultas de los análisis ================= */
const colOf = (lon: number) => (lon - grid.lon0) / grid.step;
const rowOf = (lat: number) => (grid.lat0 - lat) / grid.step;
const lonOf = (c: number) => grid.lon0 + c * grid.step;
const latOf = (r: number) => grid.lat0 - r * grid.step;

/** Elevación (m) de cada punto a la mejor resolución: 30 m si hay tesela, si no 90 m; NaN fuera de la zona con dato. */
async function elevation(lon: ArrayLike<number>, lat: ArrayLike<number>) {
  const out = new Float32Array(lon.length);
  const info = demPack ? await demPack.open().catch(() => null) : null;
  const d = await detail();
  const T = info ? info.tileCells * info.f : 0;
  // primero las teselas que hacen falta, en paralelo
  const need = new Set<number>();
  if (info) for (let k = 0; k < lon.length; k++) {
    const tx = Math.floor((colOf(lon[k]) * info.f) / T), ty = Math.floor((rowOf(lat[k]) * info.f) / T);
    if (tx >= 0 && ty >= 0 && tx < info.nx && ty < info.ny && info.has[ty * info.nx + tx]) need.add(ty * info.nx + tx);
  }
  const tiles = new Map<number, Uint16Array | null>();
  await Promise.all([...need].map(async i => tiles.set(i, await demTile(i))));
  for (let k = 0; k < lon.length; k++) {
    const c = colOf(lon[k]), r = rowOf(lat[k]);
    let v = NaN;
    if (info) {
      const px = c * info.f, py = r * info.f, tx = Math.floor(px / T), ty = Math.floor(py / T), q = tiles.get(ty * info.nx + tx);
      if (q) {
        const P = info.px, x = px - tx * T + 1, y = py - ty * T + 1, x0 = Math.min(P - 2, Math.floor(x)), y0 = Math.min(P - 2, Math.floor(y));
        const fx = x - x0, fy = y - y0, i = y0 * P + x0;
        if (q[i] && q[i + 1] && q[i + P] && q[i + P + 1]) v = ((q[i] * (1 - fx) + q[i + 1] * fx) * (1 - fy) + (q[i + P] * (1 - fx) + q[i + P + 1] * fx) * fy) * 0.25;
      }
    }
    if (Number.isNaN(v)) {
      const x = Math.max(0, Math.min(d.w - 1.001, c * d.f)), y = Math.max(0, Math.min(d.h - 1.001, r * d.f));
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * d.w + x0, z = d.z;
      if (z[i] && z[i + 1] && z[i + d.w] && z[i + d.w + 1]) v = (z[i] * (1 - fx) + z[i + 1] * fx) * (1 - fy) + (z[i + d.w] * (1 - fx) + z[i + d.w + 1] * fx) * fy;
    }
    out[k] = v;
  }
  return out;
}

/** Perfil a lo largo de una polilínea, con muestras cada `step` m (máximo 20 000). */
async function profile(lon: number[], lat: number[], step = 30): Promise<Profile> {
  let total = 0;
  const seg: number[] = [];
  for (let k = 1; k < lon.length; k++) { const d = Math.hypot((lon[k] - lon[k - 1]) * geo.KX, (lat[k] - lat[k - 1]) * geo.KZ); seg.push(d); total += d; }
  const n = Math.max(2, Math.min(20000, Math.ceil((total * 1000) / step) + 1));
  const sl = new Float32Array(n), sa = new Float32Array(n), km = new Float32Array(n);
  let j = 0, acc0 = 0;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (j < seg.length - 1 && acc0 + seg[j] < d) acc0 += seg[j++];
    const t = seg[j] ? Math.min(1, (d - acc0) / seg[j]) : 0;
    sl[k] = lon[j] + (lon[j + 1] - lon[j]) * t; sa[k] = lat[j] + (lat[j + 1] - lat[j]) * t; km[k] = d;
  }
  return { km, elev: await elevation(sl, sa), lon: sl, lat: sa };
}

/** Rango de nodos de una rejilla de factor f que cae en bounds [oeste, sur, este, norte], recortado a la rejilla. */
function nodeRange(bounds: number[], f: number, w: number, h: number) {
  const [W0, S0, E0, N0] = bounds;
  const c0 = Math.max(0, Math.ceil(colOf(W0) * f)), c1 = Math.min(w - 1, Math.floor(colOf(E0) * f));
  const r0 = Math.max(0, Math.ceil(rowOf(N0) * f)), r1 = Math.min(h - 1, Math.floor(rowOf(S0) * f));
  if (c1 < c0 || r1 < r0) throw new Error('La zona pedida queda fuera del mapa');
  return { c0, c1, r0, r1, w: c1 - c0 + 1, h: r1 - r0 + 1 };
}
const boundsOf = (c0: number, c1: number, r0: number, r1: number, f: number): [number, number, number, number] =>
  [lonOf((c0 - 0.5) / f), latOf((r1 + 0.5) / f), lonOf((c1 + 0.5) / f), latOf((r0 - 0.5) / f)];
type NodeRange = ReturnType<typeof nodeRange>;

/**
 * Alturas (m; 0 = sin dato) de los nodos de 30 m del rango R, con las teselas pedidas en paralelo. Con fill, lo que
 * queda fuera de las teselas se llena con el relieve de 90 m.
 */
async function window30(info: PackInfo, R: NodeRange, fill: boolean) {
  const f = info.f, T = info.tileCells * f, P = info.px, z = new Float32Array(R.w * R.h), ids: number[] = [];
  for (let ty = Math.floor(R.r0 / T); ty <= Math.floor(R.r1 / T); ty++) for (let tx = Math.floor(R.c0 / T); tx <= Math.floor(R.c1 / T); tx++) {
    if (tx < info.nx && ty < info.ny && info.has[ty * info.nx + tx]) ids.push(ty * info.nx + tx);
  }
  const tiles = await Promise.all(ids.map(demTile));
  ids.forEach((id, k) => {
    const q = tiles[k], tx = id % info.nx, ty = (id - tx) / info.nx;
    if (!q) return;
    for (let r = Math.max(R.r0, ty * T); r <= Math.min(R.r1, ty * T + T); r++) for (let c = Math.max(R.c0, tx * T); c <= Math.min(R.c1, tx * T + T); c++) {
      const v = q[(r - ty * T + 1) * P + (c - tx * T + 1)];
      if (v) z[(r - R.r0) * R.w + c - R.c0] = v * 0.25;
    }
  });
  if (fill) {
    const d = await detail(), s = d.f / f;
    for (let r = 0; r < R.h; r++) for (let c = 0; c < R.w; c++) {
      const i = r * R.w + c;
      if (z[i] > 0) continue;
      const v = bilinear(d.z, d.w, d.h, (c + R.c0) * s, (r + R.r0) * s);
      if (v > 0) z[i] = v;
    }
  }
  return z;
}

async function gridQuery(kind: GridKind, bounds: number[], res: number): Promise<TerrainGrid> {
  const info = demPack ? await demPack.open().catch(() => null) : null;
  // 30 m solo para zonas de hasta ~4 millones de nodos (≈ 60 × 60 km) y sin acumulación (que es de 90 m)
  if (res <= 30 && info && kind !== 'acumulacion') {
    const f = info.f, w = (grid.W - 1) * f + 1, h = (grid.H - 1) * f + 1, R = nodeRange(bounds, f, w, h);
    if (R.w * R.h <= 4e6) {
      const z = await window30(info, R, false);
      const dxm = (grid.step / f) * geo.KX * 1000, dzm = (grid.step / f) * geo.KZ * 1000;
      const data = kind === 'elevacion' ? z.map(v => (v > 0 ? v : NaN)) : slopeGrid(z, R.w, R.h, dxm, dzm, kind);
      return { width: R.w, height: R.h, bounds: boundsOf(R.c0, R.c1, R.r0, R.r1, f), res: Math.round(dxm), data };
    }
  }
  const d = await detail(), R = nodeRange(bounds, d.f, d.w, d.h);
  const dxm = (grid.step / d.f) * geo.KX * 1000, dzm = (grid.step / d.f) * geo.KZ * 1000;
  const data = new Float32Array(R.w * R.h);
  if (kind === 'acumulacion') {
    const a = await accumulation(), cellKm2 = (dxm * dzm) / 1e6;
    for (let r = 0; r < R.h; r++) for (let c = 0; c < R.w; c++) data[r * R.w + c] = a[(r + R.r0) * d.w + c + R.c0] * cellKm2;
  } else {
    for (let r = 0; r < R.h; r++) for (let c = 0; c < R.w; c++) data[r * R.w + c] = d.z[(r + R.r0) * d.w + c + R.c0];
    if (kind === 'elevacion') for (let k = 0; k < data.length; k++) { if (!(data[k] > 0)) data[k] = NaN; }
    else return { width: R.w, height: R.h, bounds: boundsOf(R.c0, R.c1, R.r0, R.r1, d.f), res: Math.round(dxm), data: slopeGrid(data, R.w, R.h, dxm, dzm, kind) };
  }
  return { width: R.w, height: R.h, bounds: boundsOf(R.c0, R.c1, R.r0, R.r1, d.f), res: Math.round(dxm), data };
}

async function watershed(lon: number, lat: number, snapM = 300): Promise<Watershed> {
  const { w, h, f, dir } = await flowDirs(), a = await accumulation(), d = await detail();
  const c = Math.round(colOf(lon) * f), r = Math.round(rowOf(lat) * f);
  if (c < 0 || r < 0 || c >= w || r >= h) throw new Error('El punto queda fuera del mapa');
  const cellM = (grid.step / f) * geo.KX * 1000;
  const i = snapToStream(a, w, h, r * w + c, Math.max(0, Math.round(snapM / cellM)));
  const { mask, cells, edge } = upstreamMask(dir, w, h, i);
  let c0 = w, c1 = -1, r0 = h, r1 = -1;
  for (let k = 0; k < w * h; k++) if (mask[k]) { const rr = (k / w) | 0, cc = k - rr * w; c0 = Math.min(c0, cc); c1 = Math.max(c1, cc); r0 = Math.min(r0, rr); r1 = Math.max(r1, rr); }
  const gw = c1 - c0 + 1, gh = r1 - r0 + 1, data = new Uint8Array(gw * gh);
  for (let rr = 0; rr < gh; rr++) for (let cc = 0; cc < gw; cc++) data[rr * gw + cc] = mask[(rr + r0) * w + cc + c0];
  const kx = (grid.step / f) * geo.KX, kz = (grid.step / f) * geo.KZ;
  // contorno en lon/lat (el de la máscara recortada, desplazado a la rejilla entera)
  const rings = maskOutline(data, gw, gh), nv = rings.reduce((s, g) => s + g.length, 0);
  const outline = { lon: new Float32Array(nv), lat: new Float32Array(nv), start: new Uint32Array(rings.length), len: new Uint32Array(rings.length) };
  let o = 0;
  rings.forEach((g, k) => {
    outline.start[k] = o; outline.len[k] = g.length;
    for (const [x, y] of g) { outline.lon[o] = lonOf((c0 + x) / f); outline.lat[o] = latOf((r0 + y) / f); o++; }
  });
  const main = longestFlowPath(dir, w, h, i, kx, kz);
  // altitudes con el relieve de 90 m (misma rejilla que el flujo)
  let zmin = Infinity, zmax = -Infinity, zsum = 0, zn = 0;
  if (d.w === w && d.h === h) for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) {
    const k = rr * w + cc, z = d.z[k];
    if (!mask[k] || !(z > 0)) continue;
    if (z < zmin) zmin = z;
    if (z > zmax) zmax = z;
    zsum += z; zn++;
  }
  return {
    grid: { width: gw, height: gh, bounds: boundsOf(c0, c1, r0, r1, f), res: Math.round(cellM), data },
    areaKm2: cells * kx * kz,
    outlet: [lonOf((i % w) / f), latOf(Math.floor(i / w) / f)],
    truncated: edge,
    outline,
    mainChannel: { lon: Float32Array.from(main.path, j => lonOf((j % w) / f)), lat: Float32Array.from(main.path, j => latOf(Math.floor(j / w) / f)), km: main.km },
    elev: zn ? { min: zmin, max: zmax, mean: zsum / zn } : { min: NaN, max: NaN, mean: NaN },
  };
}

async function flowPath(lon: number, lat: number, maxKm = 500): Promise<FlowPath> {
  const { w, h, f, dir } = await flowDirs();
  const c = Math.round(colOf(lon) * f), r = Math.round(rowOf(lat) * f);
  if (c < 0 || r < 0 || c >= w || r >= h) throw new Error('El punto queda fuera del mapa');
  const cellKm = (grid.step / f) * geo.KX;
  const path = downstreamPath(dir, w, h, r * w + c, Math.ceil(maxKm / cellKm));
  const lo = new Float32Array(path.length), la = new Float32Array(path.length);
  let km = 0;
  path.forEach((i, k) => {
    lo[k] = lonOf((i % w) / f); la[k] = latOf(Math.floor(i / w) / f);
    if (k) km += Math.hypot((lo[k] - lo[k - 1]) * geo.KX, (la[k] - la[k - 1]) * geo.KZ);
  });
  return { lon: lo, lat: la, km };
}

/**
 * Inundación ilustrativa sobre el relieve de 30 m de una ventana alrededor del punto (ver Flood): «río» con la altura
 * sobre el tramo de cauce elegido, «valle» con un relleno por prioridad desde el punto.
 */
async function flood(lon: number, lat: number, mode: 'rio' | 'valle' = 'rio', radiusKm = 20, maxRise = 30): Promise<Flood> {
  const R = Math.min(30, Math.max(2, radiusKm)), rise = Math.min(60, Math.max(1, maxRise));
  const g = await gridQuery('elevacion', [lon - R / geo.KX, lat - R / geo.KZ, lon + R / geo.KX, lat + R / geo.KZ], 30);
  const { width: w, height: h } = g, z = g.data as Float32Array, [W0, S0, E0, N0] = g.bounds, dx = (E0 - W0) / w, dy = (N0 - S0) / h;
  const need = new Float32Array(w * h).fill(NaN), ground = new Float32Array(w * h).fill(NaN);
  let seedLon: number, seedLat: number, seedZ: number, edgeRise = NaN;

  if (mode === 'valle') {
    // el punto baja al lugar más bajo a ≤ 150 m: un clic junto al agua empieza en el fondo
    const cx = Math.floor((lon - W0) / dx), cy = Math.floor((N0 - lat) / dy), rad = Math.max(1, Math.round(150 / g.res));
    let seed = -1;
    for (let r = Math.max(0, cy - rad); r <= Math.min(h - 1, cy + rad); r++) for (let c = Math.max(0, cx - rad); c <= Math.min(w - 1, cx + rad); c++) {
      if ((r - cy) ** 2 + (c - cx) ** 2 > rad * rad) continue;
      const i = r * w + c;
      if (z[i] > 0 && (seed < 0 || z[i] < z[seed])) seed = i;
    }
    if (seed < 0) throw new Error('El punto queda fuera del relieve');
    const f = floodLevels(z, w, h, seed, rise), base = z[seed];
    for (let i = 0; i < w * h; i++) if (f.level[i] >= base) { need[i] = f.level[i] - base; ground[i] = z[i] - base; }
    seedLon = W0 + ((seed % w) + 0.5) * dx; seedLat = N0 - (Math.floor(seed / w) + 0.5) * dy; seedZ = base;
    edgeRise = f.edgeLevel - base;
  } else {
    // tramo de río: desde el cauce más cercano al clic (flujo de 90 m), río abajo y río arriba por el brazo principal
    // (el de más área drenada) mientras siga dentro de la ventana y con al menos 10 % del área del punto
    const { w: fw, h: fh, f, dir } = await flowDirs(), a = await accumulation();
    const cellM = (grid.step / f) * geo.KX * 1000;
    const s = snapToStream(a, fw, fh, Math.round(rowOf(lat) * f) * fw + Math.round(colOf(lon) * f), Math.round(300 / cellM));
    const gc0 = Math.ceil(colOf(W0) * f), gc1 = Math.floor(colOf(E0) * f), gr0 = Math.ceil(rowOf(N0) * f), gr1 = Math.floor(rowOf(S0) * f);
    const ww = gc1 - gc0 + 1, wh = gr1 - gr0 + 1, local = (i: number) => {
      const rr = ((i / fw) | 0) - gr0, cc = (i % fw) - gc0;
      return rr >= 0 && cc >= 0 && rr < wh && cc < ww ? rr * ww + cc : -1;
    };
    // nodo de 30 m de la ventana que coincide con cada nodo de 90 m (factor 9 / 3 = 3)
    const n30c0 = Math.round(((W0 - grid.lon0) / grid.step) * 9 + 0.5), n30r0 = Math.round(((grid.lat0 - N0) / grid.step) * 9 + 0.5);
    const zAt90 = (i: number) => {
      // fondo del cauce: el más bajo de los nodos de 30 m dentro de la celda de 90 m
      const r9 = ((i / fw) | 0) * 3 - n30r0, c9 = (i % fw) * 3 - n30c0;
      let m = Infinity;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r9 + dr, cc = c9 + dc;
        if (rr >= 0 && cc >= 0 && rr < h && cc < w && z[rr * w + cc] > 0) m = Math.min(m, z[rr * w + cc]);
      }
      return m;
    };
    const reachZ = new Float32Array(ww * wh).fill(NaN);
    for (let i = s, k = 0; k < 4000 && local(i) >= 0; k++) {
      reachZ[local(i)] = zAt90(i);
      const d = dir[i];
      if (d < 0) break;
      i = (((i / fw) | 0) + D8[d][0]) * fw + (i % fw) + D8[d][1];
    }
    for (let i = s, k = 0; k < 4000; k++) {
      const r = (i / fw) | 0, c = i % fw;
      let up = -1;
      for (let q = 0; q < 8; q++) {
        const rr = r - D8[q][0], cc = c - D8[q][1], n = rr * fw + cc;
        if (rr >= 0 && cc >= 0 && rr < fh && cc < fw && dir[n] === q && (up < 0 || a[n] > a[up])) up = n;
      }
      if (up < 0 || a[up] < a[s] * 0.1 || local(up) < 0) break;
      reachZ[local(up)] = zAt90(up);
      i = up;
    }
    // cada celda de 90 m de la ventana → altura del cauce del tramo al que drena (o NaN si drena a otro lado)
    const drain = new Float32Array(ww * wh), state = new Uint8Array(ww * wh), path: number[] = [];
    for (let k = 0; k < ww * wh; k++) {
      if (state[k]) continue;
      path.length = 0;
      let i = (gr0 + Math.floor(k / ww)) * fw + gc0 + (k % ww), v = NaN;
      for (;;) {
        const L = local(i);
        if (L < 0) break;
        if (state[L]) { v = drain[L]; break; }
        if (!Number.isNaN(reachZ[L])) { v = reachZ[L]; state[L] = 1; drain[L] = v; break; }
        state[L] = 2; path.push(L);
        const d = dir[i];
        if (d < 0) break;
        i = (((i / fw) | 0) + D8[d][0]) * fw + (i % fw) + D8[d][1];
      }
      for (const L of path) { drain[L] = v; state[L] = 1; }
    }
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (!(z[i] > 0)) continue;
      const L = local(Math.round((r + n30r0) / 3) * fw + Math.round((c + n30c0) / 3)), zr = L >= 0 ? drain[L] : NaN;
      if (!(zr > 0)) continue;
      const hand = Math.max(0, z[i] - zr);
      if (hand <= rise) { need[i] = hand; ground[i] = hand; }
    }
    seedLon = lonOf((s % fw) / f); seedLat = latOf(Math.floor(s / fw) / f); seedZ = zAt90(s);
  }
  // se devuelve solo el rectángulo que alcanza el agua (más una celda), no la ventana entera
  let r0 = h, r1 = -1, c0 = w, c1 = -1;
  for (let i = 0; i < w * h; i++) if (!Number.isNaN(need[i])) { const r = (i / w) | 0, c = i - r * w; if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c; }
  if (r1 < 0) throw new Error('No hay terreno inundable alrededor del punto');
  const a0 = Math.max(0, r0 - 1), a1 = Math.min(h - 1, r1 + 1), b0 = Math.max(0, c0 - 1), b1 = Math.min(w - 1, c1 + 1);
  const cw = b1 - b0 + 1, ch = a1 - a0 + 1, needC = new Float32Array(cw * ch), groundC = new Float32Array(cw * ch);
  for (let r = 0; r < ch; r++) {
    needC.set(need.subarray((r + a0) * w + b0, (r + a0) * w + b1 + 1), r * cw);
    groundC.set(ground.subarray((r + a0) * w + b0, (r + a0) * w + b1 + 1), r * cw);
  }
  return {
    mode,
    need: { width: cw, height: ch, bounds: [W0 + b0 * dx, N0 - (a1 + 1) * dy, W0 + (b1 + 1) * dx, N0 - a0 * dy], res: g.res, data: needC },
    ground: groundC,
    seed: [seedLon, seedLat, seedZ],
    edgeRise,
    maxRise: rise,
  };
}

/**
 * Zona visible desde las torres (ver Viewshed) en el rectángulo que encierra sus radios: a 30 m (con el relieve de 90 m
 * donde no hay teselas) si cabe en ≈ 8 millones de nodos y 4096 por lado, si no a 90 m. Los puntos se revisan uno por
 * uno con la línea de vista exacta a cada torre que los tiene en su radio.
 */
async function viewshed(towers: Tower[], receiver = 1.5, radiusKm = 20, k = 4 / 3, points?: { lon: Float32Array; lat: Float32Array }): Promise<Viewshed> {
  const ts = towers.slice(0, 6), Rk = Math.min(60, Math.max(0.5, radiusKm)), hRx = Math.max(0, receiver), kR = k * EARTH_R;
  if (!ts.length) throw new Error('Falta al menos una torre');
  const ground = await elevation(ts.map(t => t.lon), ts.map(t => t.lat));
  ts.forEach((_, i) => { if (!(ground[i] > 0)) throw new Error('la torre ' + 'ABCDEF'[i] + ' queda fuera de la zona con relieve'); });
  const bounds = [
    Math.min(...ts.map(t => t.lon)) - Rk / geo.KX, Math.min(...ts.map(t => t.lat)) - Rk / geo.KZ,
    Math.max(...ts.map(t => t.lon)) + Rk / geo.KX, Math.max(...ts.map(t => t.lat)) + Rk / geo.KZ,
  ];
  const info = demPack ? await demPack.open().catch(() => null) : null;
  let f = 0, R: NodeRange | null = null, z: Float32Array;
  if (info) {
    const Ri = nodeRange(bounds, info.f, (grid.W - 1) * info.f + 1, (grid.H - 1) * info.f + 1);
    if (Ri.w <= 4096 && Ri.h <= 4096 && Ri.w * Ri.h <= 8e6) { f = info.f; R = Ri; }
  }
  if (R && info) z = await window30(info, R, true);
  else {
    const d = await detail();
    f = d.f; R = nodeRange(bounds, f, d.w, d.h);
    z = new Float32Array(R.w * R.h);
    for (let r = 0; r < R.h; r++) for (let c = 0; c < R.w; c++) z[r * R.w + c] = d.z[(r + R.r0) * d.w + c + R.c0];
  }
  const G = R, dxm = (grid.step / f) * geo.KX * 1000, dzm = (grid.step / f) * geo.KZ * 1000, out = new Uint8Array(G.w * G.h);
  const nodes = ts.map(t => [Math.round(colOf(t.lon) * f) - G.c0, Math.round(rowOf(t.lat) * f) - G.r0]);
  const zObs = ts.map((t, i) => ground[i] + Math.max(0, t.height));
  ts.forEach((_, i) => viewshedRays(z, G.w, G.h, nodes[i][0], nodes[i][1], zObs[i], hRx, dxm, dzm, Rk * 1000, kR, out, 1 << i));
  let pts: Viewshed['points'];
  if (points) {
    const n = points.lon.length, bits = new Uint8Array(n), lift = new Float32Array(n).fill(NaN), R2 = (Rk * 1000) ** 2;
    for (let p = 0; p < n; p++) {
      const px = colOf(points.lon[p]) * f - G.c0, py = rowOf(points.lat[p]) * f - G.r0;
      if (px < 0 || py < 0 || px > G.w - 1 || py > G.h - 1) continue;
      for (let i = 0; i < ts.length; i++) {
        const [ox, oy] = nodes[i];
        if (((px - ox) * dxm) ** 2 + ((py - oy) * dzm) ** 2 > R2) continue;
        const l = losLift(z, G.w, G.h, ox, oy, zObs[i], px, py, hRx, dxm, dzm, kR);
        if (Number.isNaN(l)) continue;
        if (l <= 0) bits[p] |= 1 << i;
        if (!(lift[p] <= l)) lift[p] = l;
      }
    }
    pts = { bits, lift };
  }
  return {
    grid: { width: G.w, height: G.h, bounds: boundsOf(G.c0, G.c1, G.r0, G.r1, f), res: Math.round(dxm), data: out },
    sites: ts.map((_, i) => [lonOf((nodes[i][0] + G.c0) / f), latOf((nodes[i][1] + G.r0) / f), ground[i]]),
    radiusKm: Rk,
    points: pts,
  };
}

/** Arreglos tipados del resultado (se transfieren en vez de copiarse). */
function buffersOf(v: unknown, out: Transferable[] = []): Transferable[] {
  if (ArrayBuffer.isView(v)) out.push(v.buffer as ArrayBuffer);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) buffersOf(x, out);
  return out;
}

ctx.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') {
      grid = m.grid; geo = makeGeo(grid); urls = m.urls;
      if (m.tiles) {
        demPack = new Pack(urls.dem); satPack = new Pack(urls.sat); bldPack = urls.bld ? new Pack(urls.bld) : null;
        // (los edificios son opcionales: sin el archivo el visor sigue sin ellos)
        const [dem, sat, bld] = await Promise.all([demPack.open().catch(() => null), satPack.open().catch(() => null), bldPack?.open().catch(() => null) ?? null]);
        if (!dem) demPack = null;
        if (!sat) satPack = null;
        if (!bld) bldPack = null;
        ctx.postMessage({ type: 'packs', dem, sat, bld });
      } else {
        // sin detalle en pantalla: el relieve de 30 m se usa igual en las consultas, si está
        demPack = new Pack(urls.dem);
        demPack.open().catch(() => { demPack = null; });
      }
      if (m.detail) { d90 = decode90(true); await d90; }
    } else if (m.type === 'tile') {
      if (m.layer === 'dem') {
        const data = demPack ? await demRender(m.index) : null;
        ctx.postMessage({ type: 'tile', id: m.id, layer: 'dem', data }, data ? [data.buffer] : []);
      } else if (m.layer === 'bld') {
        const geom = bldPack ? await bldRender(m.index) : null;
        ctx.postMessage({ type: 'tile', id: m.id, layer: 'bld', geom }, geom ? [geom.pos.buffer, geom.center.buffer, geom.info.buffer, geom.index.buffer] : []);
      } else {
        const bitmap = satPack ? await satRender(m.index) : null;
        ctx.postMessage({ type: 'tile', id: m.id, layer: 'sat', bitmap }, bitmap ? [bitmap] : []);
      }
    } else {
      const a = m.args as Record<string, never>;
      const value = m.op === 'elevation' ? await elevation(a.lon, a.lat)
        : m.op === 'profile' ? await profile(a.lon, a.lat, a.step)
        : m.op === 'grid' ? await gridQuery(a.kind, a.bounds, a.res ?? 90)
        : m.op === 'watershed' ? await watershed(a.lon, a.lat, a.snapM)
        : m.op === 'flood' ? await flood(a.lon, a.lat, a.mode, a.radiusKm, a.maxRise)
        : m.op === 'viewshed' ? await viewshed(a.towers, a.receiver, a.radiusKm, a.k, a.points)
        : await flowPath(a.lon, a.lat, a.maxKm);
      ctx.postMessage({ type: 'result', id: m.id, value }, buffersOf(value));
    }
  } catch (e) {
    const id = m.type === 'init' ? null : m.id;
    ctx.postMessage({ type: 'error', id, message: e instanceof Error ? e.message : String(e) });
  }
};
