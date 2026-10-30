#!/usr/bin/env node
/**
 * Movilidad cotidiana: traslados al trabajo y a la escuela entre municipios, de la muestra del Censo 2020 (cuestionario
 * ampliado) con su factor de expansión. Cada persona que trabajó la semana anterior (o asiste a la escuela) cuenta en
 * el flujo de su municipio de residencia al de su trabajo (o escuela).
 *   capas/movilidad.json  lugares (los 84 municipios en su localidad más poblada y los destinos de fuera: la Ciudad de
 *                         México entera, los municipios del Estado de México con más de 300 personas y cada estado en su
 *                         municipio con más traslados), flujos [origen, destino, personas, registros] de trabajo y de
 *                         escuela, y por municipio: cuántos salen, adónde, cuánto tardan y en qué van
 *   out/movilidad_flujos.json   para la base de datos
 * Los lugares de fuera se ubican con el catálogo de INEGI (wscatgeo: municipio y su localidad más poblada), en caché.
 */
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { CACHE, LAYERS, OUT, download, kb, log, readJSON, writeJSON } from './lib.mjs';
import { SOURCES } from './sources.mjs';

const t0 = Date.now(), lap = msg => log(`${msg} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
const zipFile = path.join(CACHE, SOURCES.muestra.file);
if (!fs.existsSync(zipFile)) throw new Error(`Falta ${SOURCES.muestra.file}. Corre pnpm data:fetch muestra`);
const text = new TextDecoder('latin1').decode(unzipSync(new Uint8Array(fs.readFileSync(zipFile)), { filter: f => f.name === 'Personas13.CSV' })['Personas13.CSV']);
const lines = text.split('\n'), head = lines[0].trim().split(','), col = Object.fromEntries(head.map((h, i) => [h, i]));
for (const k of ['MUN', 'FACTOR', 'ENT_PAIS_TRAB', 'MUN_TRAB', 'TIE_TRASLADO_TRAB', 'MED_TRASLADO_TRAB1', 'ENT_PAIS_ASI', 'MUN_ASI', 'TIE_TRASLADO_ESCU', 'MED_TRASLADO_ESC1']) {
  if (!(k in col)) throw new Error(`Personas13.CSV no trae la columna ${k}`);
}

/** destino: municipio de Hidalgo (13mmm), otro estado (eemmm, mmm = 999 sin especificar), extranjero o sin especificar */
const destOf = (ent, mun) => (ent >= '001' && ent <= '032' ? ent.slice(1) + mun : ent >= '100' && ent <= '535' ? 'ext' : 'ne');
const TIPOS = { trabajo: ['ENT_PAIS_TRAB', 'MUN_TRAB', 'TIE_TRASLADO_TRAB', 'MED_TRASLADO_TRAB1'], escuela: ['ENT_PAIS_ASI', 'MUN_ASI', 'TIE_TRASLADO_ESCU', 'MED_TRASLADO_ESC1'] };
const flows = { trabajo: new Map(), escuela: new Map() };
/** por municipio de residencia y tipo: total, en su municipio, otro de Hidalgo, otro estado, extranjero, sin especificar; tiempos (1–7, 9) y medios (1–12, 99) */
const res = { trabajo: [], escuela: [] };
for (const t of Object.keys(res)) for (let m = 0; m <= 84; m++) res[t].push({ total: 0, mismo: 0, hgo: 0, fuera: 0, ext: 0, ne: 0, tiempo: new Array(10).fill(0), medio: new Array(13).fill(0), n: 0 });
for (let k = 1; k < lines.length; k++) {
  const v = lines[k].split(',');
  if (v.length < head.length) continue;
  const f = +v[col.FACTOR], o = +v[col.MUN];
  for (const [t, [ce, cm, ct, cmed]] of Object.entries(TIPOS)) {
    const ent = v[col[ce]];
    if (!ent) continue;
    const d = destOf(ent, v[col[cm]] || '999'), R = res[t][o];
    R.total += f; R.n++;
    if (d === '13' + v[col.MUN]) R.mismo += f;
    else if (d.startsWith('13')) R[d.endsWith('999') ? 'ne' : 'hgo'] += f;
    else if (d === 'ext') R.ext += f;
    else if (d === 'ne') R.ne += f;
    else R.fuera += f;
    const tm = +v[col[ct]] || 0, md = +v[col[cmed]] || 0;
    R.tiempo[tm <= 7 ? tm : 9] += f;
    R.medio[md >= 1 && md <= 12 ? md : 0] += f;
    if (d === '13' + v[col.MUN] || d === 'ne' || d === 'ext' || d.endsWith('999') && d.startsWith('13')) continue;
    const key = `${o}|${d}`, x = flows[t].get(key) ?? [0, 0];
    x[0] += f; x[1]++;
    flows[t].set(key, x);
  }
}
lap(`muestra: ${lines.length - 1} personas`);

/* lugares de Hidalgo: localidad más poblada de cada municipio (ITER) */
const locs = readJSON(path.join(OUT, 'localidades.json')), munis = readJSON(path.join(OUT, 'municipios.json'));
const nameOf = new Map(munis.map(m => [m.id, m.nombre]));
const lugares = [], placeIdx = new Map();
for (let m = 1; m <= 84; m++) {
  const top = locs.filter(l => Number(l.muni ?? l.cve_mun) === m).sort((a, b) => b.pob - a.pob)[0];
  placeIdx.set('13' + String(m).padStart(3, '0'), lugares.length);
  lugares.push({ clave: '13' + String(m).padStart(3, '0'), nombre: nameOf.get(m) ?? `Municipio ${m}`, lon: +top.lon.toFixed(4), lat: +top.lat.toFixed(4), ent: 13 });
}

/* destinos de fuera: total por clave (trabajo + escuela) para decidir cuáles se dibujan */
const ext = new Map();
for (const t of Object.keys(flows)) for (const [key, [f]] of flows[t]) { const d = key.split('|')[1]; if (!d.startsWith('13')) ext.set(d, (ext.get(d) ?? 0) + f); }
const cat = async (kind, cve) => readJSON(await download(`https://gaia.inegi.org.mx/wscatgeo/v2/${kind}/${cve}`, `inegi/${kind}/${cve || 'todos'}.json`)).datos;
const estados = await cat('mgee', '');
const CORTO = { 'Veracruz de Ignacio de la Llave': 'Veracruz', 'Michoacán de Ocampo': 'Michoacán', 'Coahuila de Zaragoza': 'Coahuila' };
const estadoNombre = e => { const n = estados.find(x => x.cve_ent === e)?.nomgeo ?? `Estado ${e}`; return CORTO[n] ?? n; };
async function placeOf(cve) {
  const [mun] = await cat('mgem', cve), ls = await cat('localidades', cve);
  const top = ls.find(l => l.cve_loc === mun.cve_cab) ?? [...ls].sort((a, b) => +b.pob_total - +a.pob_total)[0];
  return { nombre: mun.nomgeo, lon: +(+top.longitud).toFixed(4), lat: +(+top.latitud).toFixed(4) };
}
const MIN_EDOMEX = 300;
const destPlace = new Map();
// Ciudad de México: un solo lugar (la mitad de los registros no dice la alcaldía), en el Centro
destPlace.set('09', lugares.length);
lugares.push({ clave: '09', nombre: 'Ciudad de México', lon: -99.1332, lat: 19.4326, ent: 9 });
for (const [d, f] of [...ext].sort((a, b) => b[1] - a[1])) {
  const e = d.slice(0, 2), m = d.slice(2);
  if (e === '09' || m === '999') continue;
  if (e === '15' && f >= MIN_EDOMEX) {
    const p = await placeOf(d);
    destPlace.set(d, lugares.length);
    lugares.push({ clave: d, nombre: `${p.nombre}, Edomex`, lon: p.lon, lat: p.lat, ent: 15 });
  } else if (e !== '15' && !destPlace.has(e)) {
    // cada estado, en su municipio con más traslados desde Hidalgo
    const p = await placeOf(d);
    destPlace.set(e, lugares.length);
    lugares.push({ clave: e, nombre: estadoNombre(e), lon: p.lon, lat: p.lat, ent: +e, en: p.nombre });
  }
}
lap(`${lugares.length - 84} destinos de fuera ubicados`);

/* flujos con índice de lugar; lo que no tiene lugar (alcaldía o municipio sin especificar, Edomex pequeño) se suma aparte */
const out = {}, sinLugar = {};
for (const t of Object.keys(flows)) {
  const agg = new Map();
  sinLugar[t] = { edomex: 0, otros: 0 };
  for (const [key, [f, n]] of flows[t]) {
    const [o, d] = key.split('|'), e = d.slice(0, 2);
    // Hidalgo por municipio; la CDMX entera; del Estado de México solo los municipios grandes; los demás estados enteros
    const p = d.startsWith('13') ? placeIdx.get(d) : e === '09' ? destPlace.get('09') : e === '15' ? destPlace.get(d) : destPlace.get(e);
    if (p === undefined) { sinLugar[t][e === '15' ? 'edomex' : 'otros'] += f; continue; }
    const k2 = `${o}|${p}`, x = agg.get(k2) ?? [0, 0];
    x[0] += f; x[1] += n;
    agg.set(k2, x);
  }
  out[t] = [...agg].map(([k2, [f, n]]) => { const [o, p] = k2.split('|').map(Number); return [o - 1, p, Math.round(f), n]; }).sort((a, b) => b[2] - a[2]);
}
const resumen = t => res[t].slice(1).map(R => ({
  total: Math.round(R.total), mismo: Math.round(R.mismo), hgo: Math.round(R.hgo), fuera: Math.round(R.fuera), ext: Math.round(R.ext), ne: Math.round(R.ne), n: R.n,
  tiempo: R.tiempo.map(Math.round), medio: R.medio.map(Math.round),
}));
writeJSON(path.join(LAYERS, 'movilidad.json'), {
  fuente: SOURCES.muestra.fuente, lugares, flujos: out, sinLugar: Object.fromEntries(Object.entries(sinLugar).map(([t, v]) => [t, { edomex: Math.round(v.edomex), otros: Math.round(v.otros) }])),
  municipios: { trabajo: resumen('trabajo'), escuela: resumen('escuela') },
});
writeJSON(path.join(OUT, 'movilidad_flujos.json'), Object.entries(out).flatMap(([t, list]) => list.map(([o, p, f, n]) => ({
  tipo: t, cve_mun_origen: o + 1, destino_clave: lugares[p].clave, destino: lugares[p].nombre, personas: f, registros: n,
}))));
for (const t of Object.keys(out)) {
  const tot = res[t].reduce((s, R) => s + R.total, 0), fuera = res[t].reduce((s, R) => s + R.fuera, 0), hgo = res[t].reduce((s, R) => s + R.hgo, 0);
  log(`${t}: ${Math.round(tot).toLocaleString('es-MX')} personas; a otro municipio de Hidalgo ${Math.round(hgo).toLocaleString('es-MX')}, a otro estado ${Math.round(fuera).toLocaleString('es-MX')}; ${out[t].length} flujos con lugar (${out[t].filter(x => x[3] >= 20).length} con 20 registros o más)`);
}
log(`capas/movilidad.json ${kb(fs.statSync(path.join(LAYERS, 'movilidad.json')).size)}`);
