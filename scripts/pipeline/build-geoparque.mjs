#!/usr/bin/env node
/**
 * Geoparque Comarca Minera y Pueblos Mágicos: los 31 geositios del geoparque (Canet et al., 2017, Terra Digitalis, en
 * UTM 14N) y los 9 Pueblos Mágicos del estado, con su texto (data-src/geoparque.json, escrito a mano) y una foto de
 * Wikimedia Commons con su autor y licencia.
 *   capas/geoparque.json       sitios (lon/lat, tipo, interés, municipio, texto, foto con créditos) y municipios del geoparque
 *   capas/geoparque/<id>.webp  fotos de 560 px de ancho (las miniaturas de Commons, recomprimidas)
 * Commons limita las consultas sin cuenta: se respeta Retry-After y las respuestas y miniaturas quedan en caché
 * (data-src/cache/commons/).
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { CACHE, LAYERS, OUT, ROOT, kb, log, readJSON, writeJSON } from './lib.mjs';

const UA = 'RelieveHidalgo/0.2 (laboratorio de datos, Hidalgo)';
const API = 'https://commons.wikimedia.org/w/api.php';
const cacheDir = path.join(CACHE, 'commons'), photoDir = path.join(LAYERS, 'geoparque');
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(photoDir, { recursive: true });
const src = readJSON(path.join(ROOT, 'data-src/geoparque.json'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** UTM (WGS84, hemisferio norte) → [lon, lat] */
function utmToLonLat(zone, x, y) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const X = x - 500000, mu = y / k0 / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + (1.5 * e1 - (27 / 32) * e1 ** 3) * Math.sin(2 * mu) + ((21 / 16) * e1 ** 2 - (55 / 32) * e1 ** 4) * Math.sin(4 * mu)
    + ((151 / 96) * e1 ** 3) * Math.sin(6 * mu) + ((1097 / 512) * e1 ** 4) * Math.sin(8 * mu);
  const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1), N1 = a / Math.sqrt(1 - e2 * s * s), T1 = t * t, C1 = ep2 * c * c;
  const R1 = (a * (1 - e2)) / (1 - e2 * s * s) ** 1.5, D = X / (N1 * k0);
  const lat = p1 - ((N1 * t) / R1) * (D * D / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / c;
  return [(zone - 1) * 6 - 177 + (lon * 180) / Math.PI, (lat * 180) / Math.PI];
}

async function get(url) {
  for (let k = 0; k < 8; k++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) return r;
    const wait = (Number(r.headers.get('retry-after')) || 10) * 1000 + 500;
    log(`Commons respondió ${r.status}; espero ${wait / 1000} s`);
    await sleep(wait);
  }
  throw new Error('Commons no respondió: ' + url);
}
const strip = s => (s ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// metadatos de las fotos (autor, licencia, miniatura), en caché
const metaFile = path.join(cacheDir, 'meta.json'), meta = fs.existsSync(metaFile) ? readJSON(metaFile) : {};
const sites = [...src.geositios.map(s => ({ ...s, tipo: 'geositio' })), ...src.pueblos.map(s => ({ ...s, tipo: 'pueblo' }))];
const want = [...new Set(sites.map(s => s.foto).filter(Boolean))].filter(t => !meta[t]);
for (let i = 0; i < want.length; i += 20) {
  const part = want.slice(i, i + 20);
  const u = API + '?' + new URLSearchParams({ action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '800', titles: part.map(t => 'File:' + t).join('|') });
  const j = await (await get(u)).json();
  const back = new Map((j.query.normalized ?? []).map(x => [x.to, x.from]));
  for (const p of Object.values(j.query.pages)) {
    const ii = p.imageinfo?.[0], m = ii?.extmetadata ?? {}, key = (back.get(p.title) ?? p.title).replace(/^File:/, '');
    if (!ii) { log('sin datos en Commons:', p.title); continue; }
    meta[key] = { thumb: ii.thumburl, page: ii.descriptionurl, autor: strip(m.Artist?.value) || 'Autor en Commons', licencia: strip(m.LicenseShortName?.value), licenciaUrl: m.LicenseUrl?.value ?? '' };
  }
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
  await sleep(1500);
}

// fotos: miniatura de 800 px de Commons → WebP de 560 px
let bytes = 0;
const out = [];
for (const s of sites) {
  let foto = null;
  const m = s.foto && meta[s.foto];
  if (m) {
    const jpg = path.join(cacheDir, s.id + path.extname(new URL(m.thumb).pathname).toLowerCase());
    if (!fs.existsSync(jpg)) { fs.writeFileSync(jpg, Buffer.from(await (await get(m.thumb)).arrayBuffer())); await sleep(500); }
    const file = path.join(photoDir, s.id + '.webp');
    await sharp(jpg).rotate().resize({ width: 560, withoutEnlargement: true }).webp({ quality: 72 }).toFile(file);
    bytes += fs.statSync(file).size;
    foto = { archivo: `geoparque/${s.id}.webp`, autor: m.autor, licencia: m.licencia, licenciaUrl: m.licenciaUrl, pagina: m.page };
  } else if (s.foto) log('foto sin metadatos:', s.foto);
  const [lon, lat] = s.utm ? utmToLonLat(14, s.utm[0], s.utm[1]) : [s.lon, s.lat];
  out.push({
    id: s.id, tipo: s.tipo, n: s.n, nombre: s.nombre, interes: s.interes, grupo: s.grupo ?? 'pueblo', municipio: s.municipio, anio: s.anio,
    lon: +lon.toFixed(5), lat: +lat.toFixed(5), texto: s.texto, foto,
  });
}
writeJSON(path.join(LAYERS, 'geoparque.json'), { fuentes: src.fuentes, geoparque: src.geoparque, sitios: out });
writeJSON(path.join(OUT, 'geoparque_sitios.json'), out.map(s => ({
  id: s.id, tipo: s.tipo, numero: s.n ?? null, nombre: s.nombre, interes: s.interes ?? null, grupo: s.grupo, municipio: s.municipio ?? null, anio: s.anio ?? null,
  lon: s.lon, lat: s.lat, texto: s.texto, foto_autor: s.foto?.autor ?? null, foto_licencia: s.foto?.licencia ?? null, foto_pagina: s.foto?.pagina ?? null,
})));
// URL de cada foto escrita tal cual (new URL con texto fijo): así cualquier empaquetador (Vite o webpack) las incluye
const withPhoto = out.filter(s => s.foto);
fs.writeFileSync(path.join(ROOT, 'src/relieve/analyses/geoparque/fotos.ts'), [
  '// Generado por scripts/pipeline/build-geoparque.mjs: no editar a mano.',
  '/** URL empaquetada de la foto de cada sitio (data/capas/geoparque/<id>.webp). */',
  'export const FOTOS: Record<string, string> = {',
  ...withPhoto.map(s => `  '${s.id}': new URL('../../data/capas/geoparque/${s.id}.webp', import.meta.url).href,`),
  '};',
  '',
].join('\n'));
log(`geoparque.json: ${out.filter(s => s.tipo === 'geositio').length} geositios y ${out.filter(s => s.tipo === 'pueblo').length} pueblos; ${out.filter(s => s.foto).length} fotos (${kb(bytes)})`);
