/** Utilidades comunes de la cadena de datos (Node 22, sin dependencias de la app). */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CACHE = path.join(ROOT, 'data-src/cache');
export const OUT = path.join(ROOT, 'data-src/out');            // tablas normalizadas (para la base de datos)
export const LAYERS = path.join(ROOT, 'src/relieve/data/capas'); // archivos que carga el visor
for (const d of [CACHE, OUT, LAYERS]) fs.mkdirSync(d, { recursive: true });

/**
 * Rejilla del visor: centros de celda de 0.0025° (≈ 270 m) con 3 celdas de margen alrededor del estado.
 * Todas las capas se alinean a ella; cambiarla obliga a regenerar todo con pnpm data.
 */
export const GRID = { W: 756, H: 726, step: 0.0025, lon0: -99.86625, lat0: 21.40375 };
const metaFile = path.join(ROOT, 'src/relieve/data/meta.json');
/** meta.json lo genera build-relieve.mjs; antes de la primera corrida se usa GRID. */
export const META = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : { ...GRID };
export const { W, H, step: STEP, lon0: LON0, lat0: LAT0 } = META;
export const colOf = lon => (lon - LON0) / STEP;
export const rowOf = lat => (LAT0 - lat) / STEP;
export const LON1 = LON0 + (W - 1) * STEP, LAT1 = LAT0 - (H - 1) * STEP;
const latC = (LAT0 + LAT1) / 2;
export const KX = 111.32 * Math.cos((latC * Math.PI) / 180), KZ = 110.57;
export const kmBetween = (lon1, lat1, lon2, lat2) => Math.hypot((lon2 - lon1) * KX, (lat2 - lat1) * KZ);

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const log = (...a) => console.log('·', ...a);

/** Descarga con caché en data-src/cache/<rel>; reintenta con espera. */
export async function download(url, rel, { force = false, init, tries = 4 } = {}) {
  const file = path.join(CACHE, rel);
  if (!force && fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let k = 1; ; k++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'RelieveHidalgo/0.2 (laboratorio de datos, Hidalgo)' }, ...init });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      fs.writeFileSync(file + '.part', Buffer.from(await res.arrayBuffer()));
      fs.renameSync(file + '.part', file);
      return file;
    } catch (e) {
      if (k >= tries) throw new Error(`No se pudo descargar ${url}: ${e.message}`);
      await sleep(3000 * k);
    }
  }
}

/** Archivos de un zip como { nombre: Uint8Array }; filtro opcional por nombre. */
export function unzip(file, filter = () => true) {
  return unzipSync(new Uint8Array(fs.readFileSync(file)), { filter: f => filter(f.name) });
}

/** CSV con comillas, comas y saltos dentro de campos. Devuelve objetos por encabezado. */
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map(h => h.trim());
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** Decodifica texto en UTF-8; si trae caracteres inválidos, lo lee como Latin-1 (DENUE). */
export function decodeText(buf) {
  const utf = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  return utf.includes('�') ? new TextDecoder('latin1').decode(buf) : utf;
}

/** Renglones del ITER (CSV dentro del zip de INEGI). */
export const readIter = file => parseCSV(decodeText(Object.values(unzip(file, n => /conjunto_de_datos_iter.*\.csv$/i.test(n)))[0]));

export const writeJSON = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
export const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const writeGz = (file, buf) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, zlib.gzipSync(buf, { level: 9 })); return fs.statSync(file).size; };
export const kb = n => (n / 1024).toFixed(0) + ' KB';

/** Escritor binario por partes (little-endian). Cada arreglo se alinea a 4 bytes. */
export class BinWriter {
  constructor() { this.parts = []; this.len = 0; }
  push(buf) { this.parts.push(buf); this.len += buf.length; const pad = (4 - (this.len % 4)) % 4; if (pad) { this.parts.push(Buffer.alloc(pad)); this.len += pad; } }
  u32(a) { this.push(Buffer.from(Uint32Array.from(a).buffer)); }
  i32(a) { this.push(Buffer.from(Int32Array.from(a).buffer)); }
  f32(a) { this.push(Buffer.from(Float32Array.from(a).buffer)); }
  u16(a) { this.push(Buffer.from(Uint16Array.from(a).buffer)); }
  i16(a) { this.push(Buffer.from(Int16Array.from(a).buffer)); }
  u8(a) { this.push(Buffer.from(Uint8Array.from(a).buffer)); }
  str(list) { const b = Buffer.from(list.join('\n'), 'utf8'); this.u32([b.length]); this.push(b); }
  buffer() { return Buffer.concat(this.parts); }
}

/**
 * Paquete de teselas (RHP1): un solo archivo que el visor lee por partes con peticiones Range (si el servidor no
 * las acepta, lo descarga completo una vez). Teselas cuadradas de `tileCells` celdas de la rejilla del visor.
 *   u32 'RHP1' · u32 versión (1) · u32 tipo (1 = relieve, 2 = imagen WebP) · u32 tileCells · u32 nx · u32 ny
 *   · u32 muestras por lado · u32 factor (rejilla fina) · nx·ny × (u32 inicio, u32 largo; largo 0 = sin tesela) · datos
 * tiles: Map de índice (ty·nx + tx) → Buffer.
 */
export const PACK_MAGIC = 0x31504852;

/** Clave para comparar nombres de lugares: sin acentos ni signos, en mayúsculas y sin «Colonia» o «Fracc.» al inicio. */
export function placeKey(s) {
  const k = (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  const m = /^(?:COLONIA|COL|FRACCIONAMIENTO|FRACC|UNIDAD HABITACIONAL|U H|UH) (.+)$/.exec(k);
  return m && !/^\d+$/.test(m[1]) ? m[1] : k;
}

const LOWER = new Set(['de', 'del', 'y', 'e', 'o', 'u', 'en', 'a', 'al', 'con', 'por', 'sin', 'para']);
const ARTICLES = new Set(['el', 'la', 'los', 'las', 'lo']);
const ACRONYMS = new Set(['INFONAVIT', 'FOVISSSTE', 'ISSSTE', 'IMSS', 'CTM', 'CROC', 'CROM', 'CNOP', 'CNC', 'FSTSE', 'SNTE', 'CFE', 'PEMEX', 'UAEH', 'SEP', 'SCT', 'SAHOP', 'INDECO', 'FOVI', 'FONHAPO', 'ISSFAM', 'PRI', 'PRD', 'UNAM', 'IPN', 'DIF', 'SEDENA', 'CONALEP']);

/**
 * Nombre en mayúsculas (como viene en el DENUE) escrito como nombre propio: «INFONAVIT VENTA PRIETA» → «INFONAVIT
 * Venta Prieta», «LOMAS DE LA PLATA» → «Lomas de la Plata», «2DA SECCIÓN» → «2da Sección». Siglas y números romanos
 * quedan en mayúsculas; «de», «y»… en minúsculas, y los artículos también si siguen a una de esas palabras.
 */
export function titleCase(s) {
  let prev = '';
  return s.trim().split(/\s+/).map((w, i) => {
    const bare = w.toUpperCase().replace(/[^A-ZÁÉÍÓÚÜÑ0-9]/g, ''), low = w.toLowerCase();
    const word = low.replace(/[^a-záéíóúüñ]/g, '');
    let out;
    if (ACRONYMS.has(bare) || (bare && /^X{0,3}(IX|IV|V?I{0,3})$/.test(bare))) out = w.toUpperCase();
    else if (/^\d+[A-ZÁÉÍÓÚÑ]+$/.test(bare)) out = low;
    else if (i > 0 && (LOWER.has(word) || (ARTICLES.has(word) && LOWER.has(prev)))) out = low;
    else out = low.replace(/(^|[(\-"'.])([a-záéíóúüñ])/g, (_, a, b) => a + b.toUpperCase());
    prev = word;
    return out;
  }).join(' ');
}
export function writePack(file, { kind, tileCells, nx, ny, px, f = 1 }, tiles) {
  const head = Buffer.alloc(32 + nx * ny * 8);
  [PACK_MAGIC, 1, kind, tileCells, nx, ny, px, f].forEach((v, k) => head.writeUInt32LE(v, k * 4));
  const parts = [head];
  let o = head.length, bytes = 0;
  for (let i = 0; i < nx * ny; i++) {
    const b = tiles.get(i);
    if (!b?.length) continue;
    head.writeUInt32LE(o, 32 + i * 8); head.writeUInt32LE(b.length, 36 + i * 8);
    parts.push(b); o += b.length; bytes += b.length;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(parts));
  return { size: o, tiles: tiles.size, mean: tiles.size ? bytes / tiles.size : 0 };
}

/** Grados, minutos y segundos de INEGI («98°43'50.123" W») a decimal. */
export function dms(s) {
  const m = /(\d+)°\s*(\d+)'\s*([\d.]+)"\s*([NSEWO])/i.exec(s || '');
  if (!m) return NaN;
  const v = +m[1] + +m[2] / 60 + +m[3] / 3600;
  return /[SWO]/i.test(m[4]) ? -v : v;
}

/** Rasterizador par-impar de polígonos sobre una rejilla (centros de celda). */
export function fillPolygon(rings, w, h, toPx, set) {
  const edges = [];
  let yMin = Infinity, yMax = -Infinity;
  for (const ring of rings) {
    for (let k = 0; k < ring.length; k++) {
      const [x0, y0] = toPx(ring[k]), [x1, y1] = toPx(ring[(k + 1) % ring.length]);
      if (y0 === y1) continue;
      edges.push(y0 < y1 ? [x0, y0, x1, y1] : [x1, y1, x0, y0]);
      yMin = Math.min(yMin, y0, y1); yMax = Math.max(yMax, y0, y1);
    }
  }
  const r0 = Math.max(0, Math.ceil(yMin - 0.5)), r1 = Math.min(h - 1, Math.floor(yMax - 0.5));
  const xs = [];
  for (let r = r0; r <= r1; r++) {
    const y = r + 0.5;
    xs.length = 0;
    for (const [x0, y0, x1, y1] of edges) if (y >= y0 && y < y1) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5)), c1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let c = c0; c <= c1; c++) set(r * w + c);
    }
  }
}
