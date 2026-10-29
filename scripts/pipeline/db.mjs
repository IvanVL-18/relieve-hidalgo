#!/usr/bin/env node
/**
 * Carga las tablas normalizadas (data-src/out) en PostgreSQL, esquema «relieve». Idempotente: rehace el esquema.
 * Conexión en .env (ver .env.example). El visor no usa la base: es para consultas, la API de Laravel y análisis.
 *   node scripts/pipeline/db.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { CACHE, OUT, ROOT, log, readJSON } from './lib.mjs';
import { USV_GROUPS, usvGroupOf } from '../../src/relieve/shared/usv.ts';
import { SERVICE_TYPES } from '../../src/relieve/shared/servicios.ts';

const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).filter(l => /^\w+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const conn = { host: env.DB_HOST, port: +env.DB_PORT || 5432, user: env.DB_USERNAME, password: env.DB_PASSWORD };
const DB = env.DB_DATABASE || 'relieve_hidalgo';
if (!/^[a-z_][a-z0-9_]*$/.test(DB)) throw new Error('DB_DATABASE debe ser un nombre simple (minúsculas, números y _)');

// crear la base si no existe
{
  const c = new pg.Client({ ...conn, database: 'postgres' });
  await c.connect();
  const { rowCount } = await c.query('select 1 from pg_database where datname = $1', [DB]);
  if (!rowCount) { await c.query(`create database ${DB} encoding 'UTF8' template template0`); log(`base de datos ${DB} creada`); }
  await c.end();
}

const db = new pg.Client({ ...conn, database: DB });
await db.connect();
const exists = f => fs.existsSync(path.join(OUT, f));

/** Inserta filas por lotes con parámetros. */
async function insert(table, cols, rows, batch = 500) {
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch), vals = [];
    const tuples = chunk.map((r, k) => `(${cols.map((_, j) => `$${k * cols.length + j + 1}`).join(',')})`);
    for (const r of chunk) for (const c of cols) vals.push(r[c] ?? null);
    await db.query(`insert into relieve.${table} (${cols.join(',')}) values ${tuples.join(',')}`, vals);
  }
  log(`${table}: ${rows.length} filas`);
}

await db.query('begin');
await db.query('drop schema if exists relieve cascade; create schema relieve');
await db.query(`comment on schema relieve is 'Relieve de Hidalgo: población, marginación, servicios, red vial, ríos y uso de suelo. Generado por scripts/pipeline/db.mjs'`);

await db.query(`create table relieve.fuentes (clave text primary key, fuente text, licencia text, url text, descargado date)`);
const fuentes = fs.existsSync(path.join(CACHE, 'fuentes.json')) ? readJSON(path.join(CACHE, 'fuentes.json')) : {};
await insert('fuentes', ['clave', 'fuente', 'licencia', 'url', 'descargado'], Object.entries(fuentes).map(([k, s]) => ({ clave: k, fuente: s.fuente, licencia: s.licencia, url: s.url === 'overpass' ? 'https://overpass-api.de' : s.url, descargado: s.descargado })));

/* municipios */
await db.query(`create table relieve.municipios (
  cve char(5) primary key, id smallint unique not null, nombre text not null,
  pob integer, pob_fem integer, pob_mas integer, pob_0_14 integer, pob_15_64 integer, pob_65 integer, viviendas integer,
  area_km2 real, densidad real, localidades integer, pob_urbana integer,
  im real, gm text, imn real, analf real, sbasc real, ovsde real, ovsee real, ovsae real, ovpt real, vhac real, pl5000 real, po2sm real,
  pendiente real, pct_pend_15 real, pct_pend_30 real, rugosidad real, alt_media integer, alt_min integer, alt_max integer, uso jsonb)`);
await db.query(`comment on table relieve.municipios is 'Población (INEGI ITER 2020), marginación (CONAPO 2020: im = índice, gm = grado; a menor índice, mayor marginación), relieve medido a 30 m (INEGI vía Terrain Tiles; área del polígono INEGI) y uso de suelo (% por grupo, INEGI Serie VII)'`);
const mun = readJSON(path.join(OUT, 'municipios.json'));
await insert('municipios', Object.keys(mun[0]).map(k => (k === 'uso' ? 'uso' : k)), mun.map(m => ({ ...m, uso: JSON.stringify(m.uso) })));

/* localidades + tiempos */
const acceso = exists('acceso_localidades.json') ? new Map(readJSON(path.join(OUT, 'acceso_localidades.json')).map(a => [a.cvegeo, a])) : new Map();
const minCols = SERVICE_TYPES.map(t => `min_${t.id}`);
await db.query(`create table relieve.localidades (
  cvegeo char(9) primary key, cve_mun char(5) references relieve.municipios(cve), nombre text not null,
  lon double precision, lat double precision, altitud integer,
  pob integer, pob_fem integer, pob_mas integer, pob_0_14 integer, pob_15_64 integer, pob_65 integer, viviendas integer,
  ambito text, im real, gm text, pendiente_entorno real, ${minCols.map(c => `${c} integer`).join(', ')})`);
await db.query(`comment on table relieve.localidades is 'Localidades del ITER 2020 con marginación CONAPO 2020 y minutos estimados por carretera al servicio público más cercano de cada tipo (min_*)'`);
const locs = readJSON(path.join(OUT, 'localidades.json')).map(l => {
  const a = acceso.get(l.cvegeo) ?? {};
  return { ...l, ...Object.fromEntries(SERVICE_TYPES.map(t => [`min_${t.id}`, a[t.id] ?? null])) };
});
await insert('localidades', ['cvegeo', 'cve_mun', 'nombre', 'lon', 'lat', 'altitud', 'pob', 'pob_fem', 'pob_mas', 'pob_0_14', 'pob_15_64', 'pob_65', 'viviendas', 'ambito', 'im', 'gm', 'pendiente_entorno', ...minCols], locs);
await db.query('create index on relieve.localidades (cve_mun)');

/* servicios */
await db.query(`create table relieve.servicios (id serial primary key, fuente text, clave text, tipo text, publico boolean, nombre text, detalle text, cve_mun char(5), lon double precision, lat double precision)`);
await db.query(`comment on table relieve.servicios is 'Unidades médicas en operación (Secretaría de Salud, CLUES) y escuelas (INEGI, DENUE). tipo: ${SERVICE_TYPES.map(t => t.id).join(', ')}'`);
await insert('servicios', ['fuente', 'clave', 'tipo', 'publico', 'nombre', 'detalle', 'cve_mun', 'lon', 'lat'], readJSON(path.join(OUT, 'servicios.json')));
await db.query('create index on relieve.servicios (tipo, publico)');

/* uso de suelo */
await db.query(`create table relieve.uso_suelo_grupos (id text primary key, nombre text, color text)`);
await insert('uso_suelo_grupos', ['id', 'nombre', 'color'], USV_GROUPS);
await db.query(`create table relieve.uso_suelo (id serial primary key, clave text, descripcion text, grupo text references relieve.uso_suelo_grupos(id), secundaria boolean, geom jsonb)`);
await db.query(`comment on table relieve.uso_suelo is 'Polígonos INEGI Serie VII 1:250 000 que tocan Hidalgo (geom en GeoJSON, WGS84)'`);
await insert('uso_suelo', ['clave', 'descripcion', 'grupo', 'secundaria', 'geom'], readJSON(path.join(OUT, 'usv_poligonos.json')).map(p => {
  const g = usvGroupOf(p.clave);
  return { clave: p.clave, descripcion: p.descripcion, grupo: USV_GROUPS[g.group].id, secundaria: g.secondary, geom: JSON.stringify(p.geom) };
}), 200);

/* ríos (drenaje calculado a 90 m) */
if (exists('rios.json')) {
  await db.query(`create table relieve.rios (id serial primary key, orden smallint, area_km2 real, km real, geom jsonb)`);
  await db.query(`comment on table relieve.rios is 'Red de drenaje calculada del relieve a 90 m y guiada por los ríos de OpenStreetMap: tramos entre confluencias con orden de Strahler y área drenada al final del tramo. geom: GeoJSON LineString (WGS84)'`);
  await insert('rios', ['orden', 'area_km2', 'km', 'geom'], readJSON(path.join(OUT, 'rios.json')).map(r => ({ ...r, geom: JSON.stringify({ type: 'LineString', coordinates: r.geom }) })), 500);
}

/* red vial */
if (exists('vias_nodos.json')) {
  await db.query(`create table relieve.red_vial_nodos (id integer primary key, lon double precision, lat double precision)`);
  await db.query(`create table relieve.red_vial (id integer primary key, nodo_a integer references relieve.red_vial_nodos(id), nodo_b integer references relieve.red_vial_nodos(id), clase text, nombre text, largo_m real, tiempo_s real)`);
  await db.query(`comment on table relieve.red_vial is 'Red vial de OpenStreetMap (ODbL) como grafo; tiempo_s = estimado en flujo libre (tipo de vía, pavimento, pendiente y curvas). Lista para pgRouting.'`);
  const nodos = readJSON(path.join(OUT, 'vias_nodos.json'));
  await insert('red_vial_nodos', ['id', 'lon', 'lat'], nodos.map((n, i) => ({ id: i, lon: n[0], lat: n[1] })), 2000);
  const aristas = readJSON(path.join(OUT, 'vias_aristas.json'));
  await insert('red_vial', ['id', 'nodo_a', 'nodo_b', 'clase', 'nombre', 'largo_m', 'tiempo_s'], aristas.map((a, i) => ({ id: i, nodo_a: a[0], nodo_b: a[1], clase: a[2], nombre: a[3] || null, largo_m: a[4], tiempo_s: a[5] })), 2000);
}

/* vistas para consultas frecuentes */
await db.query(`create view relieve.v_localidades_aisladas as
  select l.cvegeo, l.nombre, m.nombre as municipio, l.pob, l.gm, l.min_hospital, l.min_salud, l.min_secundaria
  from relieve.localidades l join relieve.municipios m on m.cve = l.cve_mun
  where l.min_hospital > 60 order by l.min_hospital desc`);
await db.query(`create view relieve.v_poblacion_por_tiempo_hospital as
  select case when min_hospital is null then 'sin camino' when min_hospital <= 15 then '0-15' when min_hospital <= 30 then '15-30'
    when min_hospital <= 60 then '30-60' when min_hospital <= 90 then '60-90' when min_hospital <= 120 then '90-120' else '120+' end as minutos,
    count(*) as localidades, sum(pob) as habitantes
  from relieve.localidades group by 1 order by min(coalesce(min_hospital, 99999))`);
await db.query(`create view relieve.v_relieve_marginacion as
  select cve, nombre, pob, gm, im, pendiente, pct_pend_15,
    ntile(3) over (order by pendiente) as tercil_pendiente, ntile(3) over (order by -im) as tercil_marginacion
  from relieve.municipios where im is not null`);
await db.query('commit');

const q = await db.query('select count(*)::int as n, sum(pob)::int as pob from relieve.localidades');
log(`listo: ${DB}.relieve · ${q.rows[0].n} localidades, ${q.rows[0].pob.toLocaleString('es-MX')} habitantes`);
await db.end();
