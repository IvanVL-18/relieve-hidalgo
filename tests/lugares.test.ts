import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { placeKey, titleCase } from '../scripts/pipeline/lib.mjs';
import { decodeLocalidades, decodeLugares } from '../src/relieve/analyses/datasets';
import meta from '../src/relieve/data/meta.json' with { type: 'json' };
import { buildIndex, extraIndex, search } from '../src/relieve/engine/search';
import type { Meta } from '../src/relieve/shared/types';

/**
 * Buscador completo: las localidades del ITER sin etiqueta, las del catálogo de INEGI que el ITER no trae y las
 * colonias del DENUE, que el visor suma después del arranque (capas/localidades.bin y capas/lugares.bin).
 */
const M = meta as unknown as Meta;
const bin = (name: string) => new Uint8Array(zlib.gunzipSync(fs.readFileSync(new URL(`../src/relieve/data/capas/${name}`, import.meta.url))));
const loc = decodeLocalidades(bin('localidades.bin')), lug = decodeLugares(bin('lugares.bin'));
const base = buildIndex(M), full = [...base, ...extraIndex(base, M, loc, lug)];

test('nombres del DENUE escritos como nombre propio', () => {
  assert.equal(titleCase('INFONAVIT VENTA PRIETA'), 'INFONAVIT Venta Prieta');
  assert.equal(titleCase('LOMAS DE LA PLATA'), 'Lomas de la Plata');
  assert.equal(titleCase('AMPLIACIÓN LA CUCHILLA'), 'Ampliación La Cuchilla');
  assert.equal(titleCase('EL LLANO 2DA SECCIÓN'), 'El Llano 2da Sección');
  assert.equal(titleCase('SECTOR II'), 'Sector II');
  assert.equal(titleCase('SAN MIGUEL CEREZO (EL CEREZO)'), 'San Miguel Cerezo (El Cerezo)');
});

test('clave para comparar nombres: sin acentos, signos ni «Colonia» al inicio', () => {
  assert.equal(placeKey('Col. Venta Prieta'), placeKey('VENTA PRIETA'));
  assert.equal(placeKey('Fracc. Los Álamos'), 'LOS ALAMOS');
  assert.equal(placeKey('Colonia 28'), 'COLONIA 28');
});

test('todas las localidades: las 4 690 del ITER y las del catálogo de INEGI que el ITER agrupa', () => {
  const locs = full.filter(x => x.kind === 'Ciudad' || x.kind === 'Pueblo' || x.kind === 'Localidad');
  assert.equal(loc.n, 4690);
  assert.equal(locs.length, loc.n + Array.from(lug.tipo).filter(t => t === 0).length);
  assert.ok(lug.tipo.some(t => t > 0), 'sin colonias');
});

test('La Cuchilla (cuatro localidades) y la colonia Venta Prieta de Pachuca', () => {
  const lc = search(full, 'la cuchilla', 20).filter(x => x.n === 'La Cuchilla');
  // Nopala de Villagrán, San Felipe Orizatlán, Singuilucan (solo en el catálogo) y Zempoala
  assert.deepEqual(lc.map(x => x.m).sort((a, b) => a! - b!), [44, 46, 57, 83]);
  const vp = search(full, 'venta prieta');
  assert.equal(vp[0].n, 'Venta Prieta');
  assert.equal(vp[0].kind, 'Colonia');
  assert.equal(vp[0].sub, 'Pachuca de Soto');
  assert.ok(vp.some(x => x.n === 'INFONAVIT Venta Prieta' && x.tipo === 'Fraccionamiento'));
});
