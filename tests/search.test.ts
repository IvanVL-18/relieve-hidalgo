import assert from 'node:assert/strict';
import { test } from 'node:test';
import meta from '../src/relieve/data/meta.json' with { type: 'json' };
import { buildIndex, fold, prettyRiver, search } from '../src/relieve/engine/search';
import type { Meta } from '../src/relieve/shared/types';

const M = meta as unknown as Meta;
const index = buildIndex(M);

test('fold quita acentos y mayúsculas', () => {
  assert.equal(fold('Metztitlán'), 'metztitlan');
  assert.equal(fold('ÑÚÉ'), 'nue');
});

test('el municipio va primero y se encuentra sin acentos', () => {
  const r = search(index, 'pachuca');
  assert.equal(r[0].kind, 'Municipio');
  assert.equal(r[0].n, 'Pachuca de Soto');
  assert.equal(search(index, 'metztitlan')[0].n, 'Metztitlán');
});

test('inicio de palabra antes que coincidencia interna', () => {
  const r = search(index, 'real', 20);
  const starts = (n: string) => fold(n).split(' ').some(w => w.startsWith('real'));
  const firstInner = r.findIndex(x => !starts(x.n));
  if (firstInner >= 0) assert.ok(r.slice(firstInner).every(x => !starts(x.n)));
});

test('nombres de ríos', () => {
  assert.equal(prettyRiver('Tula'), 'Río Tula');
  assert.equal(prettyRiver('rio Amajac'), 'Río Amajac');
});

test('índice: 84 municipios y todas las localidades de etiqueta', () => {
  assert.equal(index.filter(x => x.kind === 'Municipio').length, 84);
  assert.equal(index.filter(x => ['Ciudad', 'Pueblo', 'Localidad'].includes(x.kind)).length, M.places.length);
});
