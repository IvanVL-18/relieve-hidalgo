import type { FineGrid } from '../shared/types';

/** Descarga un .bin y lo descomprime si viene en gzip (si el servidor ya lo descomprimió, lo usa tal cual). */
export async function fetchBin(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  const name = url.split('/').pop()?.split('?')[0] ?? url;
  // un servidor de desarrollo o una SPA devuelven index.html cuando el archivo no existe
  if (!res.ok || res.headers.get('content-type')?.includes('text/html')) throw new Error(`Falta el archivo de datos ${name} (${res.status}). Genéralo con pnpm data.`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf;
  const stream = new Blob([buf as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Elevación: residuos del predictor de gradiente, bytes bajos y luego altos (ver scripts/pipeline/dem.mjs). */
export function decodeElev(planes: Uint8Array, W: number, H: number): Float32Array {
  const n = W * H;
  if (planes.length < n * 2) throw new Error('elev.bin no coincide con la rejilla');
  const e = new Int32Array(n);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const res = ((planes[i] | (planes[n + i] << 8)) << 16) >> 16;
      const L = c > 0 ? e[i - 1] : 0, U = r > 0 ? e[i - W] : 0, UL = r > 0 && c > 0 ? e[i - W - 1] : 0;
      e[i] = res + L + U - UL;
    }
  }
  return Float32Array.from(e);
}

/** Cabecera de los rásteres finos: u32 firma · u32 w · u32 h · u32 factor. */
function fineHeader(buf: Uint8Array, magic: number, name: string) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== magic) throw new Error(`${name} no tiene el formato esperado`);
  return { w: dv.getUint32(4, true), h: dv.getUint32(8, true), f: dv.getUint32(12, true) };
}

/**
 * muni-50m.bin: municipio por nodo de una rejilla f veces más fina que la del visor. RHM2 trae además la línea donde se
 * recorta el terreno (rings, en celdas del visor): de ella salen la distancia con signo al contorno y las paredes.
 */
export function decodeMuniFine(buf: Uint8Array): FineGrid<Uint8Array> & { rings: Lines | null } {
  const v2 = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true) === 0x324d4852;
  const g = fineHeader(buf, v2 ? 0x324d4852 : 0x314d4852, 'muni-50m.bin'), n = g.w * g.h;
  const data = buf.slice(16, 16 + n);
  if (!v2) return { ...g, data, rings: null };
  // anillos: u32 n · u32 len[n] · i32 dx, dy intercalados (nodos × 32, el primero absoluto); alineado a 4 bytes
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 16 + n + ((4 - (n % 4)) % 4);
  const nr = dv.getUint32(o, true), len = new Uint32Array(nr), start = new Uint32Array(nr);
  o += 4;
  let N = 0;
  for (let k = 0; k < nr; k++, o += 4) { len[k] = dv.getUint32(o, true); start[k] = N; N += len[k]; }
  const x = new Float32Array(N), y = new Float32Array(N), s = 1 / (32 * g.f);
  for (let k = 0; k < nr; k++) {
    let px = 0, py = 0;
    for (let j = start[k]; j < start[k] + len[k]; j++, o += 8) { px += dv.getInt32(o, true); py += dv.getInt32(o + 4, true); x[j] = px * s; y[j] = py * s; }
  }
  return { ...g, data, rings: { start, len, x, y } };
}

/** relieve-90m.bin (RHD1): elevación en metros, codificada como elev.bin (0 = sin dato). */
export function decodeDetail(buf: Uint8Array): FineGrid<Float32Array> {
  const g = fineHeader(buf, 0x31444852, 'relieve-90m.bin');
  return { ...g, data: decodeElev(buf.subarray(16), g.w, g.h) };
}

/** Polilíneas en coordenadas de celda (fraccionarias). */
export interface Lines {
  start: Uint32Array;
  len: Uint32Array;
  x: Float32Array;
  y: Float32Array;
}

export interface VecData {
  rivers: Lines & { acc: Uint8Array };
  lakes: { outer: Uint32Array; inner: Uint32Array; rings: Lines };
  borders: Lines;
  /** contorno del estado (versión 3 del archivo) */
  outline: Lines | null;
  /** localidades del censo para las luces nocturnas, en coordenadas de celda (versión 3) */
  lights: { x: Float32Array; y: Float32Array; pop: Uint32Array } | null;
}

export function decodeVec(buf: Uint8Array): VecData {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const u32 = (n: number) => { const a = new Uint32Array(n); for (let k = 0; k < n; k++, o += 4) a[k] = dv.getUint32(o, true); return a; };
  const lines = (): Lines => {
    const n = u32(1)[0], len = u32(n), start = new Uint32Array(n);
    let N = 0;
    for (let k = 0; k < n; k++) { start[k] = N; N += len[k]; }
    const x = new Float32Array(N), y = new Float32Array(N);
    for (let k = 0; k < N; k++, o += 2) x[k] = dv.getInt16(o, true);
    for (let k = 0; k < N; k++, o += 2) y[k] = dv.getInt16(o, true);
    for (let l = 0; l < n; l++) {
      for (let k = start[l] + 1; k < start[l] + len[l]; k++) { x[k] += x[k - 1]; y[k] += y[k - 1]; }
    }
    for (let k = 0; k < N; k++) { x[k] /= 8; y[k] /= 8; }
    return { start, len, x, y };
  };
  if (u32(1)[0] !== 0x31564852) throw new Error('vec.bin no es un archivo RHV1');
  const rv = lines();
  const acc = buf.slice(o, o + rv.x.length);
  o += acc.length + (o + acc.length) % 2;
  const nl = u32(1)[0];
  const outer = u32(nl), inner = u32(nl);
  const rings = lines();
  const borders = lines();
  // bloques agregados en la versión 3: los archivos anteriores terminan aquí
  const outline = o < buf.length ? lines() : null;
  let lights: VecData['lights'] = null;
  if (o < buf.length) {
    const n = u32(1)[0], x = new Float32Array(n), y = new Float32Array(n), pop = new Uint32Array(n);
    for (let k = 0; k < n; k++, o += 2) x[k] = dv.getInt16(o, true) / 8;
    for (let k = 0; k < n; k++, o += 2) y[k] = dv.getInt16(o, true) / 8;
    for (let k = 0; k < n; k++, o += 4) pop[k] = dv.getUint32(o, true);
    lights = { x, y, pop };
  }
  return { rivers: { ...rv, acc }, lakes: { outer, inner, rings }, borders, outline, lights };
}
