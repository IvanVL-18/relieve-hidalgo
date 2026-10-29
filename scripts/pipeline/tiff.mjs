/**
 * Lectura mínima de GeoTIFF remotos por rangos (Range) sin dependencias: solo los renglones que se piden, de archivos
 * con tiras (strips) de float32 sin comprimir o con LZW. Es lo que usan las pentadas de CHIRPS (IDL, una tira por
 * renglón, directorio al final del archivo): de cada archivo de 3.5 MB se bajan ~200 KB.
 */

const UA = { 'User-Agent': 'RelieveHidalgo/0.2 (laboratorio de datos, Hidalgo)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Rango de bytes de una URL («a-b» incluidos, o «-n» = los últimos n); reintenta con espera. Devuelve el inicio real. */
async function get(url, spec, tries = 8) {
  for (let k = 1; ; k++) {
    try {
      const res = await fetch(url, { headers: { ...UA, Range: `bytes=${spec}` } });
      if (res.status !== 206) throw new Error(`${res.status} ${res.statusText} (se esperaba 206)`);
      const start = Number(/bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')?.[1] ?? NaN);
      return { buf: Buffer.from(await res.arrayBuffer()), start };
    } catch (e) {
      if (k >= tries) throw new Error(`No se pudo leer ${url} [${spec}]: ${e.message}`);
      await sleep(3000 * k);
    }
  }
}
const range = async (url, a, b) => (await get(url, `${a}-${b}`)).buf;

/** Directorio de la primera imagen dentro de un trozo del archivo: cuenta u16 seguida de la etiqueta 256 (SHORT, 1). */
function findIfd(buf) {
  for (let i = buf.indexOf(SIG); i >= 2; i = buf.indexOf(SIG, i + 1)) {
    const n = buf.readUInt16LE(i - 2);
    if (n >= 8 && n <= 64 && i - 2 + 2 + 12 * n + 4 <= buf.length && buf.readUInt16LE(i + 12) === 257) return i - 2;
  }
  return -1;
}
const SIG = Buffer.from([0x00, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00]);

/** Descompresión LZW de TIFF (códigos de 9 a 12 bits, primero el bit más significativo, cambio anticipado). */
export function lzwDecode(src, outLen) {
  const out = new Uint8Array(outLen), start = new Int32Array(4096), len = new Int32Array(4096), bits = src.length * 8;
  let op = 0, bit = 0, width = 9, next = 258, prevOp = -1, prevLen = 0;
  while (op < outLen && bit + width <= bits) {
    const p = bit >> 3, code = (((src[p] << 16) | (src[p + 1] << 8) | src[p + 2]) >> (24 - (bit & 7) - width)) & ((1 << width) - 1);
    bit += width;
    if (code === 257) break;
    if (code === 256) { width = 9; next = 258; prevOp = -1; continue; }
    let l;
    if (code < 256) { out[op] = code; l = 1; }
    else if (code < next) { l = Math.min(len[code], outLen - op); out.copyWithin(op, start[code], start[code] + l); }
    else if (code === next && prevOp >= 0) {
      // KwKwK: el anterior más su primer byte
      l = Math.min(prevLen + 1, outLen - op);
      out.copyWithin(op, prevOp, prevOp + Math.min(prevLen, l));
      if (l > prevLen) out[op + prevLen] = out[prevOp];
    } else throw new Error(`LZW: código ${code} inválido`);
    // la entrada nueva es el texto anterior más el primer byte del actual, que ya están seguidos en la salida
    if (prevOp >= 0 && next < 4096) {
      start[next] = prevOp; len[next] = prevLen + 1; next++;
      if (next >= (1 << width) - 1 && width < 12) width++;
    }
    prevOp = op; prevLen = l; op += l;
  }
  return out;
}

const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };

/**
 * Renglones r0…r1 (incluidos) de la primera imagen de un GeoTIFF remoto de float32 con una tira por renglón.
 * Devuelve { width, height, origin: [lon, lat] de la esquina superior izquierda, step, rows: Float32Array[] }.
 */
export async function readTiffRows(url, r0, r1) {
  // los archivos de IDL guardan al final el directorio, los arreglos de tiras y las etiquetas: se pide la cola y se
  // busca ahí; si no está, se lee el encabezado
  let { buf, start: base } = await get(url, '-24576'), ifd = findIfd(buf);
  if (ifd >= 0) { buf = buf.subarray(ifd); base += ifd; }
  else {
    const head = await range(url, 0, 7);
    if (head.toString('latin1', 0, 2) !== 'II' || head.readUInt16LE(2) !== 42) throw new Error(`${url}: no es un TIFF little-endian clásico`);
    base = head.readUInt32LE(4); buf = await range(url, base, base + 65535);
  }
  const at = async (off, n) => {
    if (off < base || off + n > base + buf.length) { base = off; buf = await range(url, off, off + Math.max(n, 4096) - 1); }
    return buf.subarray(off - base, off - base + n);
  };
  const dir = Buffer.from(buf.subarray(0, 2 + 12 * buf.readUInt16LE(0) + 4)), n = dir.readUInt16LE(0), tags = {};
  for (let i = 0; i < n; i++) {
    const e = 2 + i * 12, tag = dir.readUInt16LE(e), type = dir.readUInt16LE(e + 2), count = dir.readUInt32LE(e + 4);
    tags[tag] = { type, count, inline: SIZE[type] * count <= 4, value: type === 3 ? dir.readUInt16LE(e + 8) : dir.readUInt32LE(e + 8) };
  }
  const val = t => tags[t]?.value;
  const width = val(256), height = val(257), comp = val(259) ?? 1, rps = val(278) ?? height, pred = val(317) ?? 1;
  if (val(258) !== 32 || (val(339) ?? 1) !== 3) throw new Error(`${url}: se esperaba float32`);
  if (rps !== 1 || tags[322]) throw new Error(`${url}: se esperaba una tira por renglón`);
  if (comp !== 1 && comp !== 5) throw new Error(`${url}: compresión ${comp} no admitida`);
  if (pred !== 1) throw new Error(`${url}: predictor ${pred} no admitido`);
  const arr = async (t, i0, i1) => {
    const { type, count, inline, value } = tags[t], sz = SIZE[type];
    if (inline) return [value];
    if (i1 >= count) throw new Error(`${url}: renglón fuera de la imagen`);
    const b = Buffer.from(await at(value + i0 * sz, (i1 - i0 + 1) * sz));
    return Array.from({ length: i1 - i0 + 1 }, (_, k) => (sz === 2 ? b.readUInt16LE(k * 2) : b.readUInt32LE(k * 4)));
  };
  const offs = await arr(273, r0, r1), counts = await arr(279, r0, r1);
  const tie = Buffer.from(await at(tags[33922].value, 48)), scale = Buffer.from(await at(tags[33550].value, 24));
  const origin = [tie.readDoubleLE(24), tie.readDoubleLE(32)], step = scale.readDoubleLE(0);
  // las tiras de esos renglones suelen ir seguidas: una sola petición
  const a = Math.min(...offs), b = Math.max(...offs.map((o, k) => o + counts[k])) - 1;
  const data = b - a < 4 * 1048576 ? await range(url, a, b) : null;
  const rows = [];
  for (let k = 0; k < offs.length; k++) {
    const raw = data ? data.subarray(offs[k] - a, offs[k] - a + counts[k]) : await range(url, offs[k], offs[k] + counts[k] - 1);
    const bytes = comp === 5 ? lzwDecode(raw, width * 4) : Uint8Array.from(raw);
    rows.push(new Float32Array(bytes.buffer, 0, width));
  }
  return { width, height, origin, step, rows };
}
