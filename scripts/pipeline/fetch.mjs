#!/usr/bin/env node
/**
 * Descarga las fuentes públicas a data-src/cache/ (se omiten las que ya están; --force para renovar).
 *   node scripts/pipeline/fetch.mjs [relieve agua iter denue catalogo conapo clues usv usv6 lluvia rocas deslizamientos chirps cenapred vias
 *                                    satelite solar atlas_solar muestra muestra_dic climas provincias topoformas]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CACHE, H, LAT0, LON0, ROOT, STEP, W, download, log } from './lib.mjs';
import { BBOX, SOURCES, tileRange } from './sources.mjs';
import { readTiffRows } from './tiff.mjs';

const force = process.argv.includes('--force');
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const want = k => !only.length || only.includes(k) || (only.includes('conapo') && (k === 'imm' || k === 'iml'));

const OVERPASS = [
  'https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.osm.jp/api/interpreter',
];
const HIGHWAYS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|track|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

/** Consulta a Overpass; los servidores públicos se saturan: se rota entre ellos con espera creciente (15 s … 5 min). */
async function overpass(query, rel, label) {
  for (let k = 0; k < 30; k++) {
    const ep = OVERPASS[k % OVERPASS.length], host = ep.split('/')[2];
    try {
      const f = await download(ep, rel, { force, tries: 1, init: { method: 'POST', body: new URLSearchParams({ data: query }) } });
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!Array.isArray(d.elements)) throw new Error('respuesta sin elementos');
      log(`  ${label}: ${d.elements.length} elementos (${host})`);
      return d;
    } catch (err) {
      fs.rmSync(path.join(CACHE, rel), { force: true });
      log(`  ${label} falló en ${host}: ${err.message.slice(0, 80)}`);
      await new Promise(r => setTimeout(r, Math.min(300000, 15000 * 2 ** Math.floor(k / OVERPASS.length))));
    }
  }
  throw new Error(`No se pudo descargar ${label}`);
}

/** La red vial completa es demasiado grande para una sola consulta: se pide en 4 × 4 cuadrantes y se une. */
async function fetchRoads() {
  const file = path.join(CACHE, SOURCES.vias.file);
  if (!force && fs.existsSync(file)) return;
  const N = 4, ways = new Map();
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const s = BBOX.s + ((BBOX.n - BBOX.s) * i) / N, n = BBOX.s + ((BBOX.n - BBOX.s) * (i + 1)) / N;
    const w = BBOX.w + ((BBOX.e - BBOX.w) * j) / N, e = BBOX.w + ((BBOX.e - BBOX.w) * (j + 1)) / N;
    const q = `[out:json][timeout:300];way["highway"~"^(${HIGHWAYS})$"](${s},${w},${n},${e});out geom qt;`;
    const d = await overpass(q, `osm/cuadrantes/${i}_${j}.json`, `cuadrante ${i},${j}`);
    for (const el of d.elements) ways.set(el.id, el);
  }
  fs.writeFileSync(file, JSON.stringify({ elements: [...ways.values()] }));
  log(`vías: ${ways.size} en total`);
}

/** Ríos (para guiar el drenaje y nombrarlos), presas y lagos. Si falla, build-relieve usa la copia de data-src/. */
async function fetchWater() {
  const file = path.join(CACHE, SOURCES.agua.file);
  if (!force && fs.existsSync(file)) return;
  const b = `${BBOX.s},${BBOX.w},${BBOX.n},${BBOX.e}`;
  const q = `[out:json][timeout:300];(way["waterway"="river"](${b});relation["waterway"="river"](${b});`
    + `way["natural"="water"](${b});relation["natural"="water"](${b});way["landuse"="reservoir"](${b});relation["landuse"="reservoir"](${b}););out geom;`;
  await overpass(q, SOURCES.agua.file, 'agua');
}

/**
 * Filtro de teselas Web Mercator: solo las que tocan Hidalgo o ~1 km alrededor (según muni.bin del visor, que viene en
 * el repositorio). Sin ese archivo, todas las de la rejilla.
 */
function nearHidalgo(z) {
  const file = path.join(ROOT, 'src/relieve/data/muni.bin');
  if (!fs.existsSync(file)) return () => true;
  const muni = zlib.gunzipSync(fs.readFileSync(file)), R = 4;
  const n = 2 ** z, lonOf = x => (x / n) * 360 - 180, latOf = y => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return (x, y) => {
    const c0 = Math.floor((lonOf(x) - LON0) / STEP) - R, c1 = Math.ceil((lonOf(x + 1) - LON0) / STEP) + R;
    const r0 = Math.floor((LAT0 - latOf(y)) / STEP) - R, r1 = Math.ceil((LAT0 - latOf(y + 1)) / STEP) + R;
    for (let r = Math.max(0, r0); r <= Math.min(H - 1, r1); r++) for (let c = Math.max(0, c0); c <= Math.min(W - 1, c1); c++) if (muni[r * W + c]) return true;
    return false;
  };
}

/** Teselas de una plantilla {z}/{x}/{y} que cubren la rejilla (y pasan el filtro), con 4 descargas en paralelo. */
async function fetchTiles(src, z, ext, keep = () => true) {
  const t = tileRange(z), jobs = [];
  for (let y = t.y0; y <= t.y1; y++) for (let x = t.x0; x <= t.x1; x++) if (keep(x, y)) jobs.push([x, y]);
  log(`${src.file} ${jobs.length} teselas z${z}`);
  let done = 0;
  const worker = async () => {
    for (let j; (j = jobs.shift()); ) {
      const [x, y] = j;
      await download(src.url.replace('{z}', z).replace('{y}', y).replace('{x}', x), `${src.file}${z}/${y}_${x}.${ext}`, { force });
      if (++done % 100 === 0) log(`  ${done}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

/**
 * Pentadas de CHIRPS: la ventana de la rejilla de 0.05° que cubre el rectángulo del mapa (con un píxel de margen), un
 * archivo por año con 72 × renglones × columnas float32 (mm en 5 días; −9999 sin dato) y ventana.json. El servidor
 * tarda 1–4 s en responder cada petición: 8 archivos a la vez; si se corta, sigue desde el último año completo.
 */
async function fetchChirps() {
  const src = SOURCES.chirps, dir = path.join(CACHE, src.file), STEP = 0.05, LON = -120, LAT = 35;
  const r0 = Math.floor((LAT - BBOX.n) / STEP) - 1, r1 = Math.floor((LAT - BBOX.s) / STEP) + 1;
  const c0 = Math.floor((BBOX.w - LON) / STEP) - 1, c1 = Math.floor((BBOX.e - LON) / STEP) + 1, rows = r1 - r0 + 1, cols = c1 - c0 + 1;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ventana.json'), JSON.stringify({ lon0: LON + c0 * STEP, lat0: LAT - r0 * STEP, step: STEP, cols, rows, pentadas: 72 }));
  for (let y = src.anios[0]; y <= src.anios[1]; y++) {
    const file = path.join(dir, `${y}.f32`);
    if (!force && fs.existsSync(file)) continue;
    const out = new Float32Array(72 * rows * cols), jobs = Array.from({ length: 72 }, (_, k) => k), t0 = Date.now();
    const worker = async () => {
      for (let k; (k = jobs.shift()) !== undefined; ) {
        const url = src.url.replace('{y}', y).replace('{m}', String(Math.floor(k / 6) + 1).padStart(2, '0')).replace('{p}', (k % 6) + 1);
        const t = await readTiffRows(url, r0, r1);
        if (Math.abs(t.origin[0] - LON) > 1e-6 || Math.abs(t.origin[1] - LAT) > 1e-6 || Math.abs(t.step - STEP) > 1e-6) throw new Error(`${url}: otra rejilla`);
        t.rows.forEach((row, r) => out.set(row.subarray(c0, c1 + 1), (k * rows + r) * cols));
      }
    };
    try { await Promise.all(Array.from({ length: 8 }, worker)); } catch (e) {
      // un año incompleto no se guarda; build-laderas usa los años que haya (al menos 30)
      log(`  chirps ${y}: falló (${e.message.slice(0, 120)}); vuelve a correr data:fetch -- chirps para completarlo`);
      jobs.length = 0;
      continue;
    }
    fs.writeFileSync(file + '.part', Buffer.from(out.buffer));
    fs.renameSync(file + '.part', file);
    log(`  chirps ${y}: 72 pentadas (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
}

/** CENAPRED (ArcGIS 10.2): capas vectoriales del atlas de Hidalgo con query (JSON de Esri, coordenadas geográficas). */
async function fetchCenapred() {
  const src = SOURCES.cenapred, q = '/query?where=1%3D1&outFields=*&outSR=4326&returnGeometry=true&f=json';
  for (const capa of [...src.historicos, src.zonas]) {
    const file = await download(src.url + '/' + capa + q, `${src.file}${capa.split('/').slice(1).join('_')}.json`, { force });
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(d.features)) { fs.rmSync(file); throw new Error(`CENAPRED ${capa}: respuesta sin elementos`); }
    log(`  cenapred ${capa}: ${d.features.length} elementos`);
  }
}

if (want('relieve')) await fetchTiles(SOURCES.relieve, 12, 'png');
if (want('agua')) await fetchWater().catch(e => log(`agua: ${e.message}; se usará la copia de data-src/osm_agua.json.gz`));
for (const k of ['iter', 'denue', 'imm', 'iml', 'clues', 'usv', 'usv6', 'lluvia', 'rocas', 'climas', 'provincias', 'topoformas', 'deslizamientos', 'atlas_solar', 'muestra', 'muestra_dic']) {
  if (!want(k)) continue;
  log(k, '…');
  const f = await download(SOURCES[k].url, SOURCES[k].file, { force });
  log('  ', path.relative(CACHE, f), (fs.statSync(f).size / 1048576).toFixed(1), 'MB');
}
if (want('catalogo')) {
  log('catalogo …');
  for (let m = 1; m <= 84; m++) {
    const k = String(m).padStart(3, '0');
    await download(SOURCES.catalogo.url.replace('{mun}', k), SOURCES.catalogo.file.replace('{mun}', k), { force });
  }
  log('   catálogo de localidades de los 84 municipios');
}
if (want('satelite')) {
  // z12 (≈ 36 m) para la imagen de todo el estado; z13 (≈ 18 m) solo sobre Hidalgo, para el detalle al acercarse
  await fetchTiles(SOURCES.satelite, 12, 'jpg');
  await fetchTiles(SOURCES.satelite, 13, 'jpg', nearHidalgo(13));
}
if (want('solar')) {
  for (const p of SOURCES.solar.parametros) {
    const f = await download(SOURCES.solar.url.replace('{p}', p), SOURCES.solar.file.replace('{p}', p), { force });
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(d.features) || !d.features.length) { fs.rmSync(f); throw new Error('NASA POWER ' + p + ': respuesta sin puntos'); }
    log('  solar ' + p + ': ' + d.features.length + ' celdas');
  }
}
if (want('cenapred')) await fetchCenapred();
if (want('chirps')) await fetchChirps();
if (want('vias')) await fetchRoads();
// fecha de descarga de cada fuente: la del archivo en la caché (no la de esta corrida, que puede no haber bajado nada)
const fetchedOn = s => { const f = path.join(CACHE, s.file.replace('{mun}', '001').replace('{p}', s.parametros?.[0] ?? '')); return fs.existsSync(f) ? fs.statSync(f).mtime.toISOString().slice(0, 10) : null; };
fs.writeFileSync(path.join(CACHE, 'fuentes.json'), JSON.stringify(Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, { ...s, descargado: fetchedOn(s) }])), null, 2));
log('listo');
