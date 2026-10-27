#!/usr/bin/env node
/**
 * Descarga las fuentes públicas a data-src/cache/ (se omiten las que ya están; --force para renovar).
 *   node scripts/pipeline/fetch.mjs [iter denue conapo clues usv vias satelite]
 */
import fs from 'node:fs';
import path from 'node:path';
import { CACHE, download, log } from './lib.mjs';
import { BBOX, SOURCES, tileRange } from './sources.mjs';

const force = process.argv.includes('--force');
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const want = k => !only.length || only.includes(k) || (only.includes('conapo') && (k === 'imm' || k === 'iml'));

const OVERPASS = [
  'https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.osm.jp/api/interpreter',
];
const HIGHWAYS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|track|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

/** La red vial completa es demasiado grande para una sola consulta: se pide en 4 × 4 cuadrantes y se une. */
async function fetchRoads() {
  const file = path.join(CACHE, SOURCES.vias.file);
  if (!force && fs.existsSync(file)) return;
  const N = 4, ways = new Map();
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const s = BBOX.s + ((BBOX.n - BBOX.s) * i) / N, n = BBOX.s + ((BBOX.n - BBOX.s) * (i + 1)) / N;
    const w = BBOX.w + ((BBOX.e - BBOX.w) * j) / N, e = BBOX.w + ((BBOX.e - BBOX.w) * (j + 1)) / N;
    const q = `[out:json][timeout:300];way["highway"~"^(${HIGHWAYS})$"](${s},${w},${n},${e});out geom qt;`;
    const rel = `osm/cuadrantes/${i}_${j}.json`;
    let ok = false;
    // los servidores públicos se saturan: se rota entre ellos con espera creciente (15 s … 5 min)
    for (let k = 0; k < 30 && !ok; k++) {
      const ep = OVERPASS[k % OVERPASS.length], host = ep.split('/')[2];
      try {
        const f = await download(ep, rel, { force, tries: 1, init: { method: 'POST', body: new URLSearchParams({ data: q }) } });
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!Array.isArray(d.elements)) throw new Error('respuesta sin elementos');
        for (const el of d.elements) ways.set(el.id, el);
        log(`  cuadrante ${i},${j}: ${d.elements.length} vías (${host})`);
        ok = true;
      } catch (err) {
        fs.rmSync(path.join(CACHE, rel), { force: true });
        log(`  cuadrante ${i},${j} falló en ${host}: ${err.message.slice(0, 80)}`);
        await new Promise(r => setTimeout(r, Math.min(300000, 15000 * 2 ** Math.floor(k / OVERPASS.length))));
      }
    }
    if (!ok) throw new Error(`No se pudo descargar el cuadrante ${i},${j}`);
  }
  fs.writeFileSync(file, JSON.stringify({ elements: [...ways.values()] }));
  log(`vías: ${ways.size} en total`);
}

async function fetchTiles(z = 12) {
  const t = tileRange(z), jobs = [];
  for (let y = t.y0; y <= t.y1; y++) for (let x = t.x0; x <= t.x1; x++) jobs.push([x, y]);
  log(`satélite: ${jobs.length} teselas z${z}`);
  let done = 0;
  const worker = async () => {
    for (let j; (j = jobs.shift()); ) {
      const [x, y] = j;
      await download(SOURCES.satelite.url.replace('{z}', z).replace('{y}', y).replace('{x}', x), `s2/${z}/${y}_${x}.jpg`, { force });
      if (++done % 100 === 0) log(`  ${done}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

for (const k of ['iter', 'denue', 'imm', 'iml', 'clues', 'usv']) {
  if (!want(k)) continue;
  log(k, '…');
  const f = await download(SOURCES[k].url, SOURCES[k].file, { force });
  log('  ', path.relative(CACHE, f), (fs.statSync(f).size / 1048576).toFixed(1), 'MB');
}
if (want('satelite')) await fetchTiles();
if (want('vias')) await fetchRoads();
fs.writeFileSync(path.join(CACHE, 'fuentes.json'), JSON.stringify(Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, { ...s, descargado: new Date().toISOString().slice(0, 10) }])), null, 2));
log('listo');
