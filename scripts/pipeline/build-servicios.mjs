#!/usr/bin/env node
/**
 * Servicios: unidades médicas (CLUES, en operación y con ubicación fija) y escuelas (DENUE).
 *   capas/servicios.bin  gzip RHS1 (formato en src/relieve/analyses/datasets.ts)
 *   out/servicios.json   tabla para la base de datos
 */
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { BinWriter, CACHE, LAT0, LAT1, LAYERS, LON0, LON1, OUT, decodeText, kb, log, parseCSV, unzip, writeGz, writeJSON } from './lib.mjs';
import { SOURCES } from './sources.mjs';
import { SERVICE_TYPES, schoolTypeOf } from '../../src/relieve/shared/servicios.ts';

const T = id => SERVICE_TYPES.findIndex(t => t.id === id);
const inside = (lon, lat) => lon >= LON0 && lon <= LON1 && lat <= LAT0 && lat >= LAT1;
// siglas que deben seguir en mayúsculas: sin vocales (HGZ, UMF) o conocidas
const ACRONYM = /^(?:[B-DF-HJ-NP-TV-ZÑ]{2,6}|IMSS|ISSSTE|SSA|DIF|UNEME|UNEMES|CESSA|CAAPS|CRIT|CAPASITS)$/;
const titleWord = (w, k) => (ACRONYM.test(w) ? w : k === 0 ? w.charAt(0) + w.slice(1).toLowerCase()
  : /^(DE|DEL|LA|LAS|LOS|Y|EN|EL|PARA|CON|A)$/.test(w) ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase());
const title = s => s.trim().toUpperCase().split(/\s+/).map(titleWord).join(' ')
  .replace(/([.(/-])([a-záéíóúñü])/g, (m, a, b) => a + b.toUpperCase());
const INST = {
  'SECRETARIA DE SALUD': 'SSA', 'SERVICIOS DE SALUD IMSS BIENESTAR ': 'IMSS-Bienestar', 'SERVICIOS DE SALUD IMSS BIENESTAR': 'IMSS-Bienestar',
  'INSTITUTO MEXICANO DEL SEGURO SOCIAL': 'IMSS', 'INSTITUTO MEXICANO DEL SEGURO SOCIAL REGIMEN BIENESTAR': 'IMSS-Bienestar',
  'INSTITUTO DE SEGURIDAD Y SERVICIOS SOCIALES DE LOS TRABAJADORES DEL ESTADO': 'ISSSTE', 'SERVICIOS MEDICOS PRIVADOS': 'Privado',
  'PETROLEOS MEXICANOS': 'Pemex', 'SISTEMA NACIONAL PARA EL DESARROLLO INTEGRAL DE LA FAMILIA': 'DIF', 'SECRETARIA DE LA DEFENSA NACIONAL': 'Sedena', 'CRUZ ROJA MEXICANA': 'Cruz Roja',
};

const items = [];

/* ---------- CLUES ---------- */
{
  const wb = XLSX.read(fs.readFileSync(path.join(CACHE, SOURCES.clues.file)), { dense: true });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  for (const r of rows) {
    if (r['CLAVE DE LA ENTIDAD'] !== '13' || r['ESTATUS DE OPERACION'] !== 'EN OPERACION') continue;
    const tipo = r['NOMBRE TIPO ESTABLECIMIENTO'], tip = r['NOMBRE DE TIPOLOGIA'] || '';
    if (/M[ÓO]VIL|BRIGADA|ADYACENTE A FARMACIA/i.test(tip)) continue;
    const t = tipo === 'DE HOSPITALIZACIÓN' ? T('hospital') : tipo === 'DE CONSULTA EXTERNA' ? T('salud') : -1;
    const lon = +r.LONGITUD, lat = +r.LATITUD;
    if (t < 0 || !inside(lon, lat)) continue;
    const inst = INST[r['NOMBRE DE LA INSTITUCION']] ?? title(r['NOMBRE DE LA INSTITUCION']);
    items.push({
      // Cruz Roja es asistencia privada: no cuenta como servicio público
      fuente: 'CLUES', clave: r.CLUES, tipo: SERVICE_TYPES[t].id, t, publico: inst !== 'Privado' && inst !== 'Cruz Roja', lon, lat,
      nombre: title(r['NOMBRE DE LA UNIDAD']), detalle: `${inst} · ${tip && !/NO ESPECIFICADO/i.test(tip) ? title(tip) : t === T('hospital') ? 'Hospitalización' : 'Consulta externa'}`, cve_mun: '13' + r['CLAVE DEL MUNICIPIO'],
    });
  }
}

/* ---------- DENUE (escuelas) ---------- */
{
  const z = unzip(path.join(CACHE, SOURCES.denue.file), n => n.endsWith('.csv') && n.includes('conjunto_de_datos'));
  for (const r of parseCSV(decodeText(Object.values(z)[0]))) {
    const t = schoolTypeOf(r.codigo_act || '');
    const lon = +r.longitud, lat = +r.latitud;
    if (t < 0 || !inside(lon, lat)) continue;
    items.push({
      fuente: 'DENUE', clave: r.clee, tipo: SERVICE_TYPES[t].id, t, publico: r.codigo_act.endsWith('2'), lon, lat,
      nombre: title(r.nom_estab), detalle: `${r.codigo_act.endsWith('2') ? 'Pública' : 'Privada'} · ${r.localidad ? title(r.localidad) : ''}`.replace(/ · $/, ''),
      cve_mun: '13' + r.cve_mun,
    });
  }
}

for (const t of SERVICE_TYPES) {
  const list = items.filter(i => i.tipo === t.id);
  log(`${t.plural.padEnd(16)} ${String(list.length).padStart(5)}  (${list.filter(i => i.publico).length} públicos)`);
}
writeJSON(path.join(OUT, 'servicios.json'), items);
const b = new BinWriter();
b.u32([0x31534852, items.length]);
b.f32(items.map(i => i.lon)); b.f32(items.map(i => i.lat));
b.u8(items.map(i => i.t)); b.u8(items.map(i => (i.publico ? 1 : 0)));
b.str(items.map(i => i.nombre)); b.str(items.map(i => i.detalle));
log(`servicios.bin ${kb(writeGz(path.join(LAYERS, 'servicios.bin'), b.buffer()))}`);
