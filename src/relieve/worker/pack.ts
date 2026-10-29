/**
 * Lector de paquetes de teselas RHP1 (ver writePack en scripts/pipeline/lib.mjs): pide solo la cabecera y luego cada
 * tesela con una petición Range. Si el servidor no acepta Range y devuelve el archivo completo, lo guarda y sigue de ahí.
 */
export interface PackInfo {
  /** 1 = relieve (gzip del predictor de gradiente), 2 = imagen WebP */
  kind: number;
  /** celdas de la rejilla del visor por lado de tesela */
  tileCells: number;
  nx: number;
  ny: number;
  /** muestras por lado */
  px: number;
  /** factor de la rejilla fina (relieve: 9 → 30 m) */
  f: number;
  /** 1 donde hay tesela */
  has: Uint8Array;
}

const HEAD = 32;

export class Pack {
  info: PackInfo | null = null;
  private dir: Uint32Array | null = null;
  private whole: Uint8Array | null = null;

  constructor(readonly url: string) {}

  private async get(from: number, to: number): Promise<{ bytes: Uint8Array; whole: boolean }> {
    const res = await fetch(this.url, { headers: { Range: `bytes=${from}-${to}` } });
    const name = this.url.split('/').pop()?.split('?')[0] ?? this.url;
    if (!res.ok || res.headers.get('content-type')?.includes('text/html')) throw new Error(`Falta el archivo de datos ${name} (${res.status}). Genéralo con npm run data.`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), whole: res.status !== 206 };
  }

  async open(): Promise<PackInfo> {
    if (this.info) return this.info;
    let { bytes, whole } = await this.get(0, 65535);
    if (whole) this.whole = bytes;
    const dv = () => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv().getUint32(0, true) !== 0x31504852) throw new Error('El paquete de teselas no tiene el formato esperado (RHP1)');
    const [, , kind, tileCells, nx, ny, px, f] = Array.from({ length: 8 }, (_, k) => dv().getUint32(k * 4, true));
    const need = HEAD + nx * ny * 8;
    if (bytes.length < need && !whole) bytes = (await this.get(0, need - 1)).bytes;
    this.dir = new Uint32Array(bytes.slice(HEAD, need).buffer);
    const has = new Uint8Array(nx * ny);
    for (let i = 0; i < nx * ny; i++) has[i] = this.dir[i * 2 + 1] > 0 ? 1 : 0;
    return (this.info = { kind, tileCells, nx, ny, px, f, has });
  }

  /** Bytes de la tesela i (ty·nx + tx), o null si no hay. */
  async tile(i: number): Promise<Uint8Array | null> {
    await this.open();
    const o = this.dir![i * 2], len = this.dir![i * 2 + 1];
    if (!len) return null;
    if (this.whole) return this.whole.subarray(o, o + len);
    const { bytes, whole } = await this.get(o, o + len - 1);
    if (!whole) return bytes;
    this.whole = bytes;
    return bytes.subarray(o, o + len);
  }
}

/** Descomprime gzip con la API del navegador (también en workers). */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
