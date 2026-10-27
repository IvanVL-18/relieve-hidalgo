/** Descarga un .bin y lo descomprime si viene en gzip (si el servidor ya lo descomprimió, lo usa tal cual). */
export async function fetchBin(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  const name = url.split('/').pop()?.split('?')[0] ?? url;
  // un servidor de desarrollo o una SPA devuelven index.html cuando el archivo no existe
  if (!res.ok || res.headers.get('content-type')?.includes('text/html')) throw new Error(`Falta el archivo de datos ${name} (${res.status}). Genéralo con npm run data.`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf;
  const stream = new Blob([buf as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Elevación: residuos del predictor de gradiente, bytes bajos y luego altos (ver scripts/pack-data.mjs). */
export function decodeElev(planes: Uint8Array, W: number, H: number): Float32Array {
  const n = W * H;
  if (planes.length !== n * 2) throw new Error('elev.bin no coincide con la rejilla');
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
  return { rivers: { ...rv, acc }, lakes: { outer, inner, rings }, borders };
}
