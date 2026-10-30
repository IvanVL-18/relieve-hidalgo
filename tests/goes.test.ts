import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { skyFor } from '../src/relieve/shared/clouds';
import { IR_RES, archiveRange, dayIso, dayStartOf, dayYmd, elevForBox, liveBox, liveDayStart, parseDomains, pickFrames } from '../src/relieve/shared/goes';
import { buildFields, decodePng, irCelsius, nightLowClouds, shiftBetween, type LiveMemory } from '../src/relieve/shared/goesImage';

const MIN = 60e3, HOUR = 3600e3;

/** PNG RGBA de 8 bits con un filtro distinto en cada renglón (0–4), como los que arma cualquier codificador. */
function encodePng(w: number, h: number, rgba: Uint8Array) {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const f = y % 5;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const v = rgba[y * stride + x], a = x >= 4 ? rgba[y * stride + x - 4] : 0, b = y ? rgba[(y - 1) * stride + x] : 0, c = x >= 4 && y ? rgba[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 255;
    }
  }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return png.buffer.slice(png.byteOffset, png.byteOffset + png.length) as ArrayBuffer;
}

test('recuadro alineado a la rejilla de 2 km de GIBS y que cubre lo pedido', () => {
  const b = liveBox(-99.88625, 19.57125, -97.95875, 21.42375);
  for (const v of [b.west + 180, 90 - b.north, 90 - b.south, b.east + 180]) assert.ok(Math.abs(v / IR_RES - Math.round(v / IR_RES)) < 1e-6, `${v} alineado`);
  assert.ok(b.west <= -99.88625 && b.east >= -97.95875 && b.south <= 19.57125 && b.north >= 21.42375);
  assert.equal(b.w % 2, 0);
  assert.ok(Math.abs((b.east - b.west) / b.w - IR_RES / 2) < 1e-9, 'el visible tiene medio píxel de 2 km');
});

test('horas disponibles (DescribeDomains), día que se muestra y horas que se bajan', () => {
  const xml = "<Domains><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-10-29T12:00:00Z/2026-10-29T12:30:00Z/PT10M,2026-10-29T13:00:00Z</Domain></DimensionDomain></Domains>";
  assert.deepEqual(parseDomains(xml).map(t => new Date(t).toISOString().slice(11, 16)), ['12:00', '12:10', '12:20', '12:30', '13:00']);
  assert.deepEqual(parseDomains('<Domains/>'), []);
  // 16:00 en México → ese día; 5:00 → el anterior (aún no hay imágenes de día)
  const at = (h: number) => Date.UTC(2026, 9, 29, h + 6);
  assert.deepEqual(dayYmd(liveDayStart(at(16))), [2026, 9, 29]);
  assert.deepEqual(dayYmd(liveDayStart(at(5))), [2026, 9, 28]);
  assert.equal(liveDayStart(at(16)), Date.UTC(2026, 9, 29, 6));
  // cada 10 min de 4:30 a 15:50, sin la de las 10:00: marcas cada 20 min de 5:00 a 15:40 y la última (15:50)
  const day = liveDayStart(at(16)), avail: number[] = [];
  for (let t = day + 4.5 * HOUR; t <= day + 15 * HOUR + 50 * MIN; t += 10 * MIN) if (t !== day + 10 * HOUR) avail.push(t);
  const frames = pickFrames(avail, day), hm = (t: number) => (t - day) / HOUR;
  assert.equal(hm(frames[0]), 5);
  assert.equal(hm(frames[frames.length - 1]), 15 + 50 / 60);
  assert.ok(!frames.includes(day + 10 * HOUR) && frames.some(t => Math.abs(t - day - 10 * HOUR) === 10 * MIN), 'la marca que falta se cubre con una vecina');
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i] - frames[i - 1] <= 30 * MIN && frames[i] > frames[i - 1]);
  assert.deepEqual(pickFrames([], day), []);
});

test('días del archivo: los últimos 90 contando hoy, con la fecha y la medianoche de México', () => {
  // 29 oct 2026 a las 23:27 en México (5:27 UTC del 30)
  assert.deepEqual(archiveRange(Date.UTC(2026, 9, 30, 5, 27)), ['2026-08-01', '2026-10-29']);
  // antes de las 6:00 el día que se muestra aún es el anterior; a las 6:00 avanzan hoy y el más viejo
  assert.deepEqual(archiveRange(Date.UTC(2026, 9, 30, 11, 59)), ['2026-08-01', '2026-10-29']);
  assert.deepEqual(archiveRange(Date.UTC(2026, 9, 30, 12, 1)), ['2026-08-02', '2026-10-30']);
  const s = dayStartOf('2026-09-11')!;
  assert.equal(s, Date.UTC(2026, 8, 11, 6));
  assert.equal(dayIso(s), '2026-09-11');
  assert.deepEqual(dayYmd(s), [2026, 8, 11]);
  assert.equal(dayIso(s + 864e5), '2026-09-12');
  assert.equal(dayIso(dayStartOf('2026-08-01')! - 864e5), '2026-07-31');
  for (const bad of ['2026-02-30', '2026-13-01', '11/09/2026', '']) assert.equal(dayStartOf(bad), null, bad);
});

test('PNG: los cinco filtros de renglón y los canales', async () => {
  const w = 7, h = 6, rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + (i >> 3) * 11) & 255;
  const img = await decodePng(encodePng(w, h, rgba));
  assert.equal(img.w, w);
  assert.equal(img.h, h);
  assert.deepEqual([...img.rgba], [...rgba]);
  await assert.rejects(decodePng(new Uint8Array([1, 2, 3]).buffer), /PNG/);
});

/** Imagen infrarroja de GIBS con los colores dados por píxel. */
function irImage(w: number, h: number, color: (x: number, y: number) => [number, number, number]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([...color(x, y), 255], (y * w + x) * 4);
  return rgba;
}

test('infrarrojo: rampa gris tibia, colores fríos, grises fríos solo junto a lo muy frío y mezclas de los bordes', () => {
  // gris 120 → 10.9 °C; rojo puro → −60.6 °C; gris 129 rodeado de rojo → −75.6 °C (rampa fría); gris 129 suelto → 7.4 °C
  const w = 9, h = 5;
  const t = irCelsius(irImage(w, h, (x, y) => (x >= 5 ? (x === 7 && y === 2 ? [129, 129, 129] : [255, 0, 0]) : x === 1 && y === 2 ? [129, 129, 129] : x === 3 && y === 2 ? [70, 70, 140] : [120, 120, 120])), w, h);
  assert.ok(Math.abs(t[0] - 10.92) < 0.05, `gris tibio ${t[0]}`);
  assert.ok(Math.abs(t[2 * w + 1] - 7.44) < 0.05, `gris suelto ${t[2 * w + 1]}`);
  assert.ok(Math.abs(t[5] + 60.6) < 0.01, `rojo ${t[5]}`);
  assert.ok(Math.abs(t[2 * w + 7] + 75.6) < 0.01, `gris frío ${t[2 * w + 7]}`);
  // la mezcla gris + azul (se parece al magenta de −90 °C) toma el valor de sus vecinas
  assert.ok(Math.abs(t[2 * w + 3] - 10.92) < 0.05, `mezcla ${t[2 * w + 3]}`);
  // un píxel transparente no tiene dato
  const tr = irImage(2, 1, () => [120, 120, 120]);
  tr[3] = 0;
  assert.ok(Number.isNaN(irCelsius(tr, 2, 1)[0]));
});

test('campos: una nube fría sobre suelo tibio, de noche y de día, con su cima y su densidad', () => {
  const w = 40, h = 40, w2 = 20, h2 = 20, elev = new Float32Array(w * h).fill(2);
  const ir = new Float32Array(w2 * h2);
  // suelo a 2 km: 13 °C; la nube, a −26 °C (39 K más fría: cima a ~6 km de altitud)
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) ir[y * w2 + x] = Math.hypot(x - 10, y - 10) < 4 ? -26 : 13;
  const night = buildFields(ir, null, new Float32Array(w * h).fill(-0.3), elev, w, h, { rMin: new Float32Array(w * h).fill(1) });
  const at = (f: typeof night, x: number, y: number, k: number) => f.data[(y * w + x) * 4 + k] / 255;
  assert.ok(at(night, 20, 20, 0) > 0.95, 'nube');
  assert.ok(at(night, 2, 2, 0) < 0.02, 'despejado');
  const top = at(night, 20, 20, 1) * 16;
  assert.ok(top > 7 && top < 9, `cima ${top.toFixed(2)} km`);
  assert.ok(Math.abs(night.maxTop - top) < 0.2);
  // fuera de la nube, la cima es la del borde vecino (al filtrar la textura el borde no se hunde hasta el suelo)
  assert.ok(at(night, 20, 31, 1) * 16 > 4.5, `cima rellenada ${at(night, 20, 31, 1) * 16}`);
  // de día: la nube brilla en el visible; el suelo, oscuro
  const refl = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) refl[y * w + x] = Math.hypot(x - 20, y - 20) < 8 ? 0.7 : 0.08;
  const mem: LiveMemory = { rMin: new Float32Array(w * h).fill(1) };
  const day = buildFields(ir, refl, new Float32Array(w * h).fill(0.8), elev, w, h, mem);
  assert.ok(at(day, 20, 20, 0) > 0.95 && at(day, 2, 2, 0) < 0.02);
  assert.ok(at(day, 20, 20, 2) > 0.8, 'nube densa');
  assert.ok(mem.clearDay !== undefined && Math.abs(mem.clearDay - (13 + 6.5 * 2)) < 0.5, `suelo despejado ${mem.clearDay}`);
  // núcleo de tormenta: cima muy fría, más que lo de alrededor
  const storm = new Float32Array(w2 * h2).fill(-45);
  for (const k of [10 * w2 + 10, 10 * w2 + 11, 11 * w2 + 10, 11 * w2 + 11]) storm[k] = -70;
  const s = buildFields(storm, null, new Float32Array(w * h).fill(-0.3), elev, w, h, { rMin: new Float32Array(w * h).fill(1) });
  assert.ok(s.cores.length >= 3 && Math.abs(s.cores[0] - 22) <= 2 && Math.abs(s.cores[1] - 22) <= 2, `núcleo ${s.cores.slice(0, 3)}`);
  assert.ok(at(s, 22, 22, 3) > 0.6 && at(s, 4, 4, 3) < 0.4, 'convección en el núcleo y no alrededor');
});

test('nubes bajas de noche (GeoColor): azul claro sí; suelo y luces de las ciudades no', () => {
  const px = new Uint8Array([115, 147, 192, 255, 26, 20, 46, 255, 97, 65, 48, 255]);
  const f = nightLowClouds(px);
  assert.ok(f[0] > 0.9 && f[1] === 0 && f[2] === 0);
});

test('movimiento: recupera el desplazamiento de un campo de nubes', () => {
  const w = 60, h = 50, a = new Float32Array(w * h), b = new Float32Array(w * h);
  const field = (x: number, y: number) => Math.max(0, 25 * Math.sin(x * 0.31) * Math.cos(y * 0.23) + 10 * Math.sin((x + y) * 0.17));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { a[y * w + x] = field(x, y); b[y * w + x] = field(x - 3, y + 2); }
  const s = shiftBetween(a, b, w, h);
  assert.ok(s.ok);
  assert.ok(Math.abs(s.dx - 3) < 0.5 && Math.abs(s.dy + 2) < 0.5, `${s.dx}, ${s.dy}`);
  assert.equal(shiftBetween(new Float32Array(w * h), new Float32Array(w * h), w, h).ok, false, 'sin nubes no hay medida');
});

test('altitud del terreno bajo cada píxel de la imagen y el tipo «hoy» sin satélite', () => {
  const W = 40, H = 30, elev = new Float32Array(W * H).fill(1500);
  const b = liveBox(-99.9, 20, -99.82, 20.07);
  const e = elevForBox(elev, W, H, -99.9, 20.07, 0.0025, b);
  assert.equal(e.length, b.w * b.h);
  assert.ok(e.every(v => Math.abs(v - 1.5) < 1e-6));
  assert.deepEqual(skyFor('hoy', 13), skyFor('auto', 13));
});
