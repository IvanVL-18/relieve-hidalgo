#!/usr/bin/env node
/**
 * Población (INEGI ITER 2020), marginación (CONAPO 2020) y relieve por municipio y localidad.
 * El relieve se mide a 30 m: municipios desde out/relieve_municipios.json (build-relieve) y localidades aquí.
 *   capas/municipios.json   84 municipios: población, marginación e indicadores, relieve, uso de suelo
 *   capas/localidades.bin   gzip RHL1 (formato en src/relieve/analyses/datasets.ts)
 *   out/municipios.json · out/localidades.json   tablas completas para la base de datos
 */
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { BinWriter, CACHE, LAYERS, OUT, dms, kb, log, readIter, readJSON, unzip, writeGz, writeJSON } from './lib.mjs';
import { SOURCES } from './sources.mjs';
import { FINE, colOf, loadFine, rowOf, slopeAt } from './dem.mjs';

const GRADOS = ['', 'Muy bajo', 'Bajo', 'Medio', 'Alto', 'Muy alto'];
const num = v => (v === undefined || v === '' || v === '*' || v === 'N/D' ? null : +v);

/* ---------- relieve a 30 m ---------- */
const relieve = readJSON(path.join(OUT, 'relieve_municipios.json'));
const fine = await loadFine();
const RAD = Math.round(1000 / fine.dxm);   // ~1 km en celdas finas
/** pendiente media en un radio de ~1 km alrededor de un punto */
const slopeAround = (lon, lat) => {
  const c0 = Math.round(colOf(lon) * FINE), r0 = Math.round(rowOf(lat) * FINE);
  let s = 0, n = 0;
  for (let r = r0 - RAD; r <= r0 + RAD; r++) for (let c = c0 - RAD; c <= c0 + RAD; c++) {
    if (r < 1 || c < 1 || r >= fine.h - 1 || c >= fine.w - 1 || (r - r0) ** 2 + (c - c0) ** 2 > RAD * RAD) continue;
    s += slopeAt(fine.data, fine.w, fine.h, r * fine.w + c, fine.dxm, fine.dzm); n++;
  }
  return n ? s / n : 0;
};

/* ---------- CONAPO ---------- */
const imm = new Map();
{
  const wb = XLSX.read(fs.readFileSync(path.join(CACHE, SOURCES.imm.file)));
  for (const r of XLSX.utils.sheet_to_json(wb.Sheets.IMM_2020)) if (r.CVE_ENT === '13') imm.set(r.CVE_MUN, r);
}
const iml = new Map();
{
  const z = unzip(path.join(CACHE, SOURCES.iml.file), n => n.endsWith('.xls'));
  const wb = XLSX.read(Object.values(z)[0]);
  for (const s of wb.SheetNames) for (const r of XLSX.utils.sheet_to_json(wb.Sheets[s])) if (r.ENT === '13') iml.set(r.CVE_LOC, r);
}
log(`CONAPO: ${imm.size} municipios, ${iml.size} localidades`);

/* ---------- ITER ---------- */
const rows = readIter(path.join(CACHE, SOURCES.iter.file));
const locRows = rows.filter(r => r.MUN !== '000' && !['0000', '9998', '9999'].includes(r.LOC));
const munRows = new Map(rows.filter(r => r.MUN !== '000' && r.LOC === '0000').map(r => [+r.MUN, r]));

const locs = locRows.map(r => {
  const lon = dms(r.LONGITUD), lat = dms(r.LATITUD), cve = '13' + r.MUN + r.LOC, m = iml.get(cve);
  const pob = num(r.POBTOT) ?? 0;
  return {
    cvegeo: cve, cve_mun: '13' + r.MUN, muni: +r.MUN, loc: +r.LOC, nombre: r.NOM_LOC.trim(), lon, lat,
    altitud: num(r.ALTITUD), pob, pob_fem: num(r.POBFEM), pob_mas: num(r.POBMAS),
    pob_0_14: num(r.POB0_14), pob_15_64: num(r.POB15_64), pob_65: num(r.POB65_MAS), viviendas: num(r.TVIVHAB),
    ambito: pob >= 2500 ? 'Urbano' : 'Rural',
    im: m ? +m.IM_2020 : null, gm: m ? m.GM_2020 : null,
    pendiente_entorno: +slopeAround(lon, lat).toFixed(1),
  };
}).filter(l => Number.isFinite(l.lon) && Number.isFinite(l.lat)).sort((a, b) => b.pob - a.pob);
log(`ITER: ${locs.length} localidades, ${locs.filter(l => l.gm).length} con grado de marginación`);

const usvShare = readJSON(path.join(OUT, 'usv_municipios.json'));
const municipios = Array.from({ length: 84 }, (_, k) => {
  const id = k + 1, cve = `13${String(id).padStart(3, '0')}`, r = munRows.get(id), c = imm.get(cve), t = relieve[k];
  const ls = locs.filter(l => l.muni === id);
  const area = t.area_km2, pob = num(r.POBTOT);
  const uso = usvShare[k];
  return {
    id, cve, nombre: r.NOM_MUN, pob, pob_fem: num(r.POBFEM), pob_mas: num(r.POBMAS),
    pob_0_14: num(r.POB0_14), pob_15_64: num(r.POB15_64), pob_65: num(r.POB65_MAS), viviendas: num(r.TVIVHAB),
    area_km2: +area.toFixed(1), densidad: +(pob / area).toFixed(1),
    localidades: ls.length, pob_urbana: ls.filter(l => l.pob >= 2500).reduce((s, l) => s + l.pob, 0),
    im: c ? +c.IM_2020.toFixed(3) : null, gm: c?.GM_2020 ?? null, imn: c ? +c.IMN_2020.toFixed(4) : null,
    // indicadores de CONAPO (porcentajes)
    analf: c ? +c.ANALF.toFixed(1) : null, sbasc: c ? +c.SBASC.toFixed(1) : null, ovsde: c ? +c.OVSDE.toFixed(1) : null,
    ovsee: c ? +c.OVSEE.toFixed(1) : null, ovsae: c ? +c.OVSAE.toFixed(1) : null, ovpt: c ? +c.OVPT.toFixed(1) : null,
    vhac: c ? +c.VHAC.toFixed(1) : null, pl5000: c ? +c['PL.5000'].toFixed(1) : null, po2sm: c ? +c.PO2SM.toFixed(1) : null,
    pendiente: t.pendiente, pct_pend_15: t.pct_pend_15, pct_pend_30: t.pct_pend_30, rugosidad: t.rugosidad,
    alt_media: t.alt_media, alt_min: t.alt_min, alt_max: t.alt_max,
    uso: Object.fromEntries(Object.entries(uso).filter(([k2, v]) => k2 !== 'id' && v >= 0.5)),
  };
});
const total = municipios.reduce((s, m) => s + m.pob, 0);
log(`población estatal ${total.toLocaleString('es-MX')} (ITER), ${municipios.filter(m => m.gm).length} municipios con marginación`);

/* ---------- salida ---------- */
writeJSON(path.join(LAYERS, 'municipios.json'), municipios);
writeJSON(path.join(OUT, 'municipios.json'), municipios);
writeJSON(path.join(OUT, 'localidades.json'), locs);

const b = new BinWriter(), n = locs.length, col = k => locs.map(l => l[k] ?? 0);
b.u32([0x314c4852, n]);
b.f32(col('lon')); b.f32(col('lat'));
b.u32(col('pob')); b.u32(col('pob_fem')); b.u32(col('pob_mas')); b.u32(col('pob_0_14')); b.u32(col('pob_65')); b.u32(col('viviendas'));
b.f32(locs.map(l => l.im ?? NaN));
b.i16(col('altitud')); b.u16(col('loc'));
b.u8(col('muni')); b.u8(locs.map(l => Math.max(0, GRADOS.indexOf(l.gm ?? '')))); b.u8(locs.map(l => Math.min(255, Math.round(l.pendiente_entorno))));
b.str(locs.map(l => l.nombre));
const size = writeGz(path.join(LAYERS, 'localidades.bin'), b.buffer());
log(`localidades.bin ${kb(size)} · municipios.json ${kb(fs.statSync(path.join(LAYERS, 'municipios.json')).size)}`);
