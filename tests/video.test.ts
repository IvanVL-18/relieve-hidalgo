import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mp4Writer, avcCodecs } from '../src/relieve/analyses/video/mp4';

interface Box { type: string; start: number; size: number; body: number; kids?: Box[] }
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf']);

/** Recorre las cajas de un MP4 (y las de los contenedores conocidos). */
function parse(b: Uint8Array, start: number, end: number): Box[] {
  const dv = new DataView(b.buffer, b.byteOffset), out: Box[] = [];
  for (let o = start; o < end;) {
    const size = dv.getUint32(o), type = String.fromCharCode(...b.subarray(o + 4, o + 8));
    assert.ok(size >= 8 && o + size <= end, `caja ${type} fuera de su contenedor`);
    const bx: Box = { type, start: o, size, body: o + 8 };
    if (CONTAINERS.has(type)) bx.kids = parse(b, o + 8, o + size);
    out.push(bx);
    o += size;
  }
  return out;
}
const find = (bs: Box[], path: string[]): Box => {
  const [h, ...rest] = path, b = bs.find(x => x.type === h);
  assert.ok(b, `falta ${h}`);
  return rest.length ? find(b.kids!, rest) : b;
};

test('MP4: cajas bien anidadas, índice al principio y muestras donde dice el índice', async () => {
  const w = new Mp4Writer({ width: 1080, height: 1920, fps: 30 });
  w.setConfig(Uint8Array.of(1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80));
  const samples = Array.from({ length: 75 }, (_, i) => Uint8Array.from({ length: 50 + ((i * 37) % 200) }, (_, k) => (i * 7 + k) & 255));
  samples.forEach((s, i) => w.add(s, i % 30 === 0));
  const file = new Uint8Array(await w.finish().arrayBuffer()), dv = new DataView(file.buffer);
  const top = parse(file, 0, file.length);
  assert.deepEqual(top.map(b => b.type), ['ftyp', 'moov', 'mdat']);
  // duración: 75 cuadros a 30 cps = 2.5 s
  const mvhd = find(top, ['moov', 'mvhd']);
  // (cuerpo de mvhd: versión y banderas, creación, modificación, escala de tiempo, duración)
  assert.equal(dv.getUint32(mvhd.body + 16) / dv.getUint32(mvhd.body + 12), 2.5);
  const tkhd = find(top, ['moov', 'trak', 'tkhd']);
  assert.equal(dv.getUint32(tkhd.body + 76) / 65536, 1080);
  assert.equal(dv.getUint32(tkhd.body + 80) / 65536, 1920);
  const stbl = ['moov', 'trak', 'mdia', 'minf', 'stbl'];
  const stsz = find(top, [...stbl, 'stsz']);
  assert.equal(dv.getUint32(stsz.body + 8), 75);
  samples.forEach((s, i) => assert.equal(dv.getUint32(stsz.body + 12 + i * 4), s.length));
  const stss = find(top, [...stbl, 'stss']);
  assert.deepEqual([0, 1, 2].map(i => dv.getUint32(stss.body + 8 + i * 4)), [1, 31, 61]);
  // el bloque del índice apunta al primer byte de la primera muestra, y las demás siguen en orden
  const stco = find(top, [...stbl, 'stco']), off = dv.getUint32(stco.body + 8);
  let o = off;
  for (const s of samples) { assert.deepEqual(file.subarray(o, o + s.length), s); o += s.length; }
  assert.equal(o, file.length);
  const avc1 = find(top, [...stbl, 'stsd']);
  assert.equal(String.fromCharCode(...file.subarray(avc1.body + 12, avc1.body + 16)), 'avc1');
});

test('MP4: códecs H.264 según tamaño y cuadros por segundo', () => {
  assert.equal(avcCodecs(1920, 1080, 30)[0], 'avc1.640028');
  assert.equal(avcCodecs(1080, 1920, 60)[0], 'avc1.64002a');
  assert.equal(avcCodecs(3840, 2160, 30)[0], 'avc1.640033');
});
