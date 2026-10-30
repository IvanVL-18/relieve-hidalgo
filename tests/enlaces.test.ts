import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeViewState, encodeViewState, fmtPoints, parsePoints, viewStateUrl, type ViewState } from '../src/relieve/shared/enlaces';

test('enlaces: el estado sobrevive a la URL', () => {
  const s: ViewState = {
    view: { lon: -98.763712, lat: 20.042934, dist: 0.8523, polar: 52.04, az: -30.06 },
    baseMap: 'satelite', hour: 17.5, exaggeration: 3, clouds: 'niebla', analysis: 'inundacion',
    params: { punto: '-99.3409,20.0524', h: '3.5', modo: 'valle' },
  };
  const q = encodeViewState(s);
  // legible: comas sin escapar, la distancia en km y los parámetros del análisis con «a.»
  assert.match(q, /^vista=-98\.76371,20\.04293,85\.2,52,-30\.1&mapa=satelite&hora=17\.5&exag=3&nubes=niebla&analisis=inundacion&a\.punto=-99\.3409,20\.0524&a\.h=3\.5&a\.modo=valle$/);
  const d = decodeViewState('?' + q);
  assert.equal(d.baseMap, 'satelite');
  assert.equal(d.hour, 17.5);
  assert.equal(d.exaggeration, 3);
  assert.equal(d.clouds, 'niebla');
  assert.equal(d.analysis, 'inundacion');
  assert.deepEqual(d.params, s.params);
  assert.ok(Math.abs(d.view!.lon - s.view!.lon) < 1e-5 && Math.abs(d.view!.dist - 0.852) < 1e-9 && d.view!.az === -30.1);
  // los valores por omisión no se escriben; el municipio solo sin análisis
  assert.equal(encodeViewState({ baseMap: 'usodesuelo', exaggeration: 2.5, clouds: 'auto', municipio: '13048' }), 'mun=13048');
});

test('enlaces: lo inválido se ignora y los enlaces viejos siguen sirviendo', () => {
  const d = decodeViewState('?vista=1,2,abc,3,4&mapa=google&hora=31&exag=9&nubes=lluvia&mun=13099&analisis=../x&a.punto=1,2');
  assert.deepEqual(d, {});
  // ?analisis= y ?mapa= de antes de los enlaces; claves de municipio de 1 a 3 cifras
  assert.deepEqual(decodeViewState('?analisis=accesibilidad&mapa=altitud&mun=48'), { analysis: 'accesibilidad', baseMap: 'altitud', municipio: '13048' });
  assert.equal(decodeViewState('mun=013').municipio, '13013');
  assert.equal(decodeViewState('vista=-98.7,20.1,5,120,10').view!.polar, 90);
});

test('enlaces: nubes del satélite de otro día', () => {
  assert.equal(encodeViewState({ clouds: 'hoy', cloudDay: '2026-09-11' }), 'nubes=hoy&dia=2026-09-11');
  // el día solo va con las nubes del satélite
  assert.equal(encodeViewState({ clouds: 'niebla', cloudDay: '2026-09-11' }), 'nubes=niebla');
  assert.deepEqual(decodeViewState('?nubes=hoy&dia=2026-09-11'), { clouds: 'hoy', cloudDay: '2026-09-11' });
  for (const bad of ['2026-02-30', '2026-13-01', '0000-01-01', '11/09/2026', 'ayer']) assert.deepEqual(decodeViewState('?nubes=hoy&dia=' + bad), { clouds: 'hoy' }, bad);
});

test('enlaces: la dirección conserva los parámetros del anfitrión', () => {
  const s: ViewState = { baseMap: 'altitud', analysis: 'cuencas', params: { punto: '-98.7654,21.2387' } };
  const url = viewStateUrl('https://lab.hidalgo.gob.mx/mapas/relieve?tab=2&mapa=satelite&a.viejo=1&quieto#ficha', s);
  assert.equal(url, 'https://lab.hidalgo.gob.mx/mapas/relieve?tab=2&quieto&mapa=altitud&analisis=cuencas&a.punto=-98.7654,21.2387#ficha');
  assert.equal(viewStateUrl('http://localhost:5173/', {}), 'http://localhost:5173/');
  // textos con espacios y acentos
  const q = encodeViewState({ analysis: 'x', params: { q: 'San Agustín Tlaxiaca' } });
  assert.deepEqual(decodeViewState(q).params, { q: 'San Agustín Tlaxiaca' });
});

test('enlaces: listas de puntos', () => {
  const p: [number, number][] = [[-98.419412, 21.140433], [-99.2163, 20.4836]];
  assert.equal(fmtPoints(p), '-98.41941,21.14043;-99.2163,20.4836');
  assert.deepEqual(parsePoints(fmtPoints(p)), [[-98.41941, 21.14043], [-99.2163, 20.4836]]);
  assert.equal(parsePoints(''), undefined);
  assert.equal(parsePoints('-98.4,21.1;x'), undefined);
  assert.equal(parsePoints('-98.4,95'), undefined);
  assert.equal(parsePoints('1,2;3,4;5,6', 2)!.length, 2);
});
