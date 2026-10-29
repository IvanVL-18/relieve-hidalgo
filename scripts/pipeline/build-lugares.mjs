#!/usr/bin/env node
/**
 * Lugares extra para el buscador del visor (municipios, localidades del ITER, ríos y presas ya están en meta.json y
 * capas/localidades.bin):
 *   - localidades activas del catálogo de INEGI que no aparecen en el ITER 2020: deshabitadas o de una o dos viviendas
 *     (el censo las agrupa por municipio para proteger la confidencialidad);
 *   - asentamientos de las direcciones del DENUE (colonias, fraccionamientos, barrios, secciones…), en la mediana de la
 *     posición de sus negocios. Se omiten los que repiten el nombre de su localidad o de una localidad cercana.
 *
 * Salida:
 *   capas/lugares.bin        gzip RHN1 (formato en src/relieve/analyses/datasets.ts)
 *   data-src/out/lugares.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { BinWriter, CACHE, LAYERS, OUT, decodeText, dms, kb, kmBetween, log, parseCSV, placeKey, readIter, titleCase, unzip, writeGz, writeJSON } from './lib.mjs';
import { SOURCES } from './sources.mjs';

const GENERIC = new Set(['NINGUNO', 'NINGUNA', 'SIN NOMBRE', 'SN', 'S N', 'NO ESPECIFICADO', 'NO APLICA', 'NA', 'N A', 'SIN DATO', 'DESCONOCIDO', 'OTRO', 'OTROS', 'SIN COLONIA', 'X', 'XX', 'XXX', '0']);
/** tipos de asentamiento del DENUE que no dicen nada (el asentamiento es la localidad misma o no se sabe) */
const GENERIC_TYPES = new Set(['', 'LOCALIDAD', 'CIUDAD', 'OTRO', 'NINGUNO']);
const TIPOS = {
  COLONIA: 'Colonia', BARRIO: 'Barrio', FRACCIONAMIENTO: 'Fraccionamiento', PUEBLO: 'Pueblo', MANZANA: 'Manzana', CUARTEL: 'Cuartel',
  'CONJUNTO HABITACIONAL': 'Conjunto habitacional', 'UNIDAD HABITACIONAL': 'Unidad habitacional', AMPLIACION: 'Ampliación',
  PRIVADA: 'Privada', SECCION: 'Sección', EJIDO: 'Ejido', 'ZONA COMERCIAL': 'Zona comercial', 'PARQUE INDUSTRIAL': 'Parque industrial',
  CONDOMINIO: 'Condominio', 'CIUDAD INDUSTRIAL': 'Ciudad industrial', RESIDENCIAL: 'Residencial', CANTON: 'Cantón', FRACCION: 'Fracción',
  'ZONA INDUSTRIAL': 'Zona industrial', 'CORREDOR INDUSTRIAL': 'Corredor industrial', GRANJA: 'Granja', EXHACIENDA: 'Exhacienda',
  RANCHERIA: 'Ranchería', RANCHO: 'Rancho', HACIENDA: 'Hacienda', PARAJE: 'Paraje', SECTOR: 'Sector', PROLONGACION: 'Prolongación',
  RINCONADA: 'Rinconada', VILLA: 'Villa', UNIDAD: 'Unidad',
};

const bump = (map, k) => map.set(k, (map.get(k) || 0) + 1);
const median = a => { const s = Float64Array.from(a).sort(); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const accents = s => (s.normalize('NFD').match(/[̀-ͯ]/g) || []).length;

/* ---------- localidades: ITER 2020 y catálogo de INEGI ---------- */
const locs = new Map();                  // 'mmm|llll' → { nombre, mun, loc, lon, lat }
const byKey = new Map();                 // 'mmm|CLAVE DEL NOMBRE' → localidades con ese nombre en el municipio
const muniName = new Map();
/** claves de un nombre, con y sin lo que va entre paréntesis («Melchor Ocampo (El Salto)» también es «Melchor
 *  Ocampo») y sin el estado al final («Apan Hgo») */
const keysOf = s => [...new Set([placeKey(s), placeKey(s.replace(/\([^)]*\)/g, ' '))].map(k => k.replace(/ HGO$/, '')))].filter(Boolean);
/** ¿difieren en una letra a lo más? (erratas como «Chicavascoo» por «Chicavasco») */
const typo = (a, b) => {
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 6) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1);
};
const index = l => { for (const k of keysOf(l.nombre)) (byKey.get(`${l.mun}|${k}`) ?? byKey.set(`${l.mun}|${k}`, []).get(`${l.mun}|${k}`)).push(l); };
const near = (mun, name, lon, lat, km) => keysOf(name).some(k => (byKey.get(`${mun}|${k}`) ?? []).some(l => kmBetween(lon, lat, l.lon, l.lat) < km));
const sameName = (a, b) => keysOf(a).some(k => keysOf(b).includes(k));

for (const r of readIter(path.join(CACHE, SOURCES.iter.file))) {
  if (r.MUN === '000') continue;
  if (r.LOC === '0000') { muniName.set(r.MUN, r.NOM_MUN); continue; }
  if (r.LOC === '9998' || r.LOC === '9999') continue;
  const l = { nombre: r.NOM_LOC.trim(), mun: r.MUN, loc: r.LOC, lon: dms(r.LONGITUD), lat: dms(r.LATITUD) };
  locs.set(`${l.mun}|${l.loc}`, l); index(l);
}
const iterCount = locs.size;

const extra = [];
for (let m = 1; m <= 84; m++) {
  const file = path.join(CACHE, SOURCES.catalogo.file.replace('{mun}', String(m).padStart(3, '0')));
  for (const d of JSON.parse(fs.readFileSync(file, 'utf8')).datos) {
    const lon = +d.longitud, lat = +d.latitud;
    if (+d.estatus !== 1 || locs.has(`${d.cve_mun}|${d.cve_loc}`) || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const l = { nombre: d.nomgeo.trim(), mun: d.cve_mun, loc: d.cve_loc, lon, lat };
    locs.set(`${l.mun}|${l.loc}`, l);
    // la misma localidad con otra clave (mismo nombre en el municipio a menos de 1 km) no se repite
    if (!near(l.mun, l.nombre, lon, lat, 1)) extra.push(l);
    index(l);
  }
}
log(`localidades: ${iterCount} del ITER y ${extra.length} más del catálogo de INEGI`);

/* ---------- asentamientos del DENUE ---------- */
const groups = new Map();
const z = unzip(path.join(CACHE, SOURCES.denue.file), n => n.endsWith('.csv') && n.includes('conjunto_de_datos'));
for (const r of parseCSV(decodeText(Object.values(z)[0]))) {
  const name = (r.nomb_asent ?? '').replace(/\s+/g, ' ').trim(), lk = placeKey(r.localidad);
  // «Centro Apan Hgo» o «Apan Centro» en la localidad Apan son el «Centro» de Apan
  let key = placeKey(name).replace(/ HGO$/, '');
  if (lk && key.endsWith(' ' + lk)) key = key.slice(0, -lk.length - 1);
  else if (lk && key.startsWith(lk + ' ')) key = key.slice(lk.length + 1);
  const lon = +r.longitud, lat = +r.latitud;
  if (!key || GENERIC.has(key) || !lon || !lat || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
  const k = `${r.cve_mun}|${r.cve_loc}|${key}`;
  let g = groups.get(k);
  if (!g) groups.set(k, (g = { mun: r.cve_mun, loc: r.cve_loc, key, names: new Map(), tipos: new Map(), lon: [], lat: [] }));
  bump(g.names, name); bump(g.tipos, (r.tipo_asent ?? '').trim());
  g.lon.push(lon); g.lat.push(lat);
}

let asent = [], repeated = 0;
for (const g of groups.values()) {
  // variantes raras del centro («Centro Frente Servicio Hermanos Luna», «Centro del Tulancingo»): direcciones mal escritas
  if (g.key.startsWith('CENTRO ') && g.lon.length < 3) continue;
  // posición: mediana de los negocios, sin los que quedan a más de 2 km de ella (direcciones mal ubicadas)
  let lon = median(g.lon), lat = median(g.lat);
  const keep = g.lon.map((_, i) => i).filter(i => kmBetween(lon, lat, g.lon[i], g.lat[i]) < 2);
  if (keep.length && keep.length < g.lon.length) { lon = median(keep.map(i => g.lon[i])); lat = median(keep.map(i => g.lat[i])); }
  // la variante con acentos y, entre iguales, la más usada
  const raw = [...g.names].sort((a, b) => accents(b[0]) - accents(a[0]) || b[1] - a[1])[0][0];
  const own = locs.get(`${g.mun}|${g.loc}`);
  if ((own && (sameName(own.nombre, raw) || typo(placeKey(own.nombre), g.key))) || sameName(muniName.get(g.mun), raw) || near(g.mun, raw, lon, lat, 3)) { repeated++; continue; }
  // tipo: el más frecuente que diga algo; si no hay, el que trae el nombre («Barrio Alto», «Tercera Manzana»)
  const tipoRaw = [...g.tipos].filter(([t]) => !GENERIC_TYPES.has(t)).sort((a, b) => b[1] - a[1])[0]?.[0]
    ?? (g.key === 'CENTRO' ? 'COLONIA' : Object.keys(TIPOS).find(t => new RegExp(`\\b${t}\\b`).test(g.key)));
  const tipo = tipoRaw ? TIPOS[tipoRaw] ?? titleCase(tipoRaw) : 'Asentamiento';
  let nombre = titleCase(raw);
  if (/^(\d+|[IVX]+)$/.test(g.key)) {             // «3» en una manzana o sección → «Manzana 3»
    if (!tipoRaw) continue;
    nombre = `${tipo} ${raw}`;
  }
  asent.push({ nombre, tipo, mun: g.mun, loc: g.loc, localidad: own?.nombre ?? '', lon, lat, negocios: g.lon.length, key: g.key });
}
// un mismo asentamiento repartido entre dos claves de localidad (negocios mal asignados): se queda el de más negocios
asent.sort((a, b) => b.negocios - a.negocios);
const kept = new Map();
asent = asent.filter(a => {
  const k = `${a.mun}|${a.key}`, same = (kept.get(k) ?? []).find(b => kmBetween(a.lon, a.lat, b.lon, b.lat) < 1.5);
  if (same) { same.negocios += a.negocios; return false; }
  (kept.get(k) ?? kept.set(k, []).get(k)).push(a);
  return true;
});
const byTipo = {};
for (const a of asent) byTipo[a.tipo] = (byTipo[a.tipo] || 0) + 1;
log(`asentamientos del DENUE: ${asent.length} (${repeated} omitidos por repetir una localidad) ·`, Object.entries(byTipo).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => `${t} ${n}`).join(', '));

/* ---------- salida ---------- */
const all = [
  ...extra.map(l => ({ nombre: l.nombre, tipo: 'Localidad', mun: l.mun, loc: l.loc, localidad: '', lon: l.lon, lat: l.lat, negocios: 0, fuente: 'catalogo' })),
  ...asent.map(({ key: _, ...a }) => ({ ...a, fuente: 'denue' })),
].sort((a, b) => a.mun.localeCompare(b.mun) || a.nombre.localeCompare(b.nombre, 'es'));
const tipos = ['Localidad', ...[...new Set(asent.map(a => a.tipo))].sort((a, b) => a.localeCompare(b, 'es'))];
// localidad a la que pertenece el asentamiento, cuando no es la cabecera del mismo nombre que el municipio
const subs = [''], subIndex = new Map();
const subOf = p => {
  if (!p.localidad || placeKey(p.localidad) === placeKey(muniName.get(p.mun))) return 0;
  if (!subIndex.has(p.localidad)) { subIndex.set(p.localidad, subs.length); subs.push(p.localidad); }
  return subIndex.get(p.localidad);
};

writeJSON(path.join(OUT, 'lugares.json'), all.map(p => ({ nombre: p.nombre, tipo: p.tipo, cve_mun: '13' + p.mun, cve_loc: p.loc, localidad: p.localidad || null, lon: +p.lon.toFixed(6), lat: +p.lat.toFixed(6), negocios: p.negocios, fuente: p.fuente })));
const b = new BinWriter();
b.u32([0x314e4852, all.length]);
b.f32(all.map(p => p.lon)); b.f32(all.map(p => p.lat));
b.u16(all.map(p => +p.loc)); b.u16(all.map(p => Math.min(65535, p.negocios))); b.u16(all.map(subOf));
b.u8(all.map(p => +p.mun)); b.u8(all.map(p => tipos.indexOf(p.tipo)));
b.str(all.map(p => p.nombre)); b.str(tipos); b.str(subs);
const size = writeGz(path.join(LAYERS, 'lugares.bin'), b.buffer());
log(`lugares.bin ${kb(size)}: ${all.length} lugares (${extra.length} localidades y ${asent.length} asentamientos)`);
