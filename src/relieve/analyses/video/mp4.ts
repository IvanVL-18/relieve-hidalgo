/**
 * Empaquetador MP4 mínimo para una pista de video H.264: recibe los pedazos de VideoEncoder (formato «avc»: unidades NAL
 * con su largo de 4 bytes) y la configuración avcC, y arma ftyp + moov + mdat con el índice al principio (se puede
 * reproducir mientras baja). Todas las muestras van en un solo bloque del mdat. Sin dependencias: lo prueban las pruebas.
 */

const enc = new TextEncoder();

/** Caja MP4: tamaño (u32) + tipo (4 letras) + contenido. */
function box(type: string, ...parts: (Uint8Array | number[])[]): Uint8Array {
  const body = parts.map(p => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const size = 8 + body.reduce((s, p) => s + p.length, 0), out = new Uint8Array(size), dv = new DataView(out.buffer);
  dv.setUint32(0, size);
  out.set(enc.encode(type), 4);
  let o = 8;
  for (const p of body) { out.set(p, o); o += p.length; }
  return out;
}
/** Caja completa: versión (u8) y banderas (u24) antes del contenido. */
const fullBox = (type: string, version: number, flags: number, ...parts: (Uint8Array | number[])[]) =>
  box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);

const u16 = (v: number) => [(v >> 8) & 255, v & 255];
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const fixed16 = (v: number) => u32(Math.round(v * 65536));
/** matriz identidad de las cabeceras */
const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

export interface Mp4Options {
  width: number;
  height: number;
  /** cuadros por segundo (todas las muestras duran lo mismo) */
  fps: number;
}

export class Mp4Writer {
  private samples: Uint8Array[] = [];
  private keys: number[] = [];
  private avcC: Uint8Array | null = null;
  /** ticks por segundo de la pista */
  private readonly timescale: number;
  private readonly delta: number;

  constructor(private o: Mp4Options) {
    // 90 000 divide exacto 24, 25, 30, 50 y 60 cuadros por segundo
    this.timescale = 90000;
    this.delta = Math.round(90000 / o.fps);
  }

  get count() { return this.samples.length; }
  get bytes() { return this.samples.reduce((s, x) => s + x.length, 0); }

  /** configuración del decodificador (EncodedVideoChunkMetadata.decoderConfig.description) */
  setConfig(description: ArrayBuffer | ArrayBufferView) {
    const v = ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength) : new Uint8Array(description);
    this.avcC = v.slice();
  }

  /** una muestra (un cuadro ya codificado) */
  add(data: Uint8Array, key: boolean) {
    this.samples.push(data);
    if (key) this.keys.push(this.samples.length);
  }

  /** archivo completo */
  finish(): Blob {
    if (!this.avcC) throw new Error('Falta la configuración del video (avcC)');
    if (!this.samples.length) throw new Error('El video no tiene cuadros');
    const ftyp = box('ftyp', enc.encode('isom'), u32(0x200), enc.encode('isomiso2avc1mp41'));
    // el índice depende del lugar del mdat; su tamaño no: se arma una vez para medirlo y otra con el lugar correcto
    const first = ftyp.length + this.moov(0).length + 8;
    const moov = this.moov(first);
    const mdatSize = 8 + this.bytes;
    return new Blob([ftyp as BlobPart, moov as BlobPart, new Uint8Array([...u32(mdatSize), ...enc.encode('mdat')]) as BlobPart, ...this.samples as BlobPart[]], { type: 'video/mp4' });
  }

  private moov(dataOffset: number): Uint8Array {
    const { width: W, height: H } = this.o, n = this.samples.length, dur = n * this.delta, movieTs = 1000, movieDur = Math.round((dur / this.timescale) * movieTs);
    const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(movieTs), u32(movieDur), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(2));
    const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDur), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), MATRIX, fixed16(W), fixed16(H));
    const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(this.timescale), u32(dur), u16(0x55c4), u16(0));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), enc.encode('vide'), u32(0), u32(0), u32(0), enc.encode('VideoHandler\0'));
    const vmhd = fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const name = new Uint8Array(32);
    name.set(enc.encode('\x0fRelieve Hidalgo'));
    const avc1 = box('avc1',
      new Array(6).fill(0), u16(1),                    // reservado, índice de referencia de datos
      u16(0), u16(0), u32(0), u32(0), u32(0),          // predefinido y reservado
      u16(W), u16(H), u32(0x00480000), u32(0x00480000), u32(0), u16(1), name, u16(0x0018), u16(0xffff),
      box('avcC', this.avcC!), box('pasp', u32(1), u32(1)));
    const stsd = fullBox('stsd', 0, 0, u32(1), avc1);
    const stts = fullBox('stts', 0, 0, u32(1), u32(n), u32(this.delta));
    const stss = fullBox('stss', 0, 0, u32(this.keys.length), ...this.keys.map(u32));
    const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1));
    const sizes = new Uint8Array(n * 4), dv = new DataView(sizes.buffer);
    this.samples.forEach((s, i) => dv.setUint32(i * 4, s.length));
    const stsz = fullBox('stsz', 0, 0, u32(0), u32(n), sizes);
    const stco = fullBox('stco', 0, 0, u32(1), u32(dataOffset));
    const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
    const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', vmhd, dinf, stbl)));
    return box('moov', mvhd, trak);
  }
}

/** Códecs H.264 a probar, del perfil más alto al más compatible (nivel 4.2: 1080p a 60 cps; 5.1 para 4K). */
export function avcCodecs(width: number, height: number, fps: number) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16), level = mbs > 8704 ? '33' : fps > 30 ? '2a' : '28';
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`];
}
