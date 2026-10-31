import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoTier, gpuKind, gpuName, pixelRatio, qualityParams, tierRank } from '../src/relieve/shared/quality';

/** Nombres tal como los da WebGL (ANGLE en Windows, Metal en Mac, Mesa en Linux, Firefox «or similar»). */
const GPUS: [string, string, string][] = [
  ['ANGLE (AMD, AMD Radeon(TM) Graphics (0x0000164C) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated', 'AMD Radeon Graphics'],
  ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Laptop GPU (0x00002520) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete', 'NVIDIA GeForce RTX 3060 Laptop GPU'],
  ['ANGLE (NVIDIA, NVIDIA GeForce MX450 (0x00001F97) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated', 'NVIDIA GeForce MX450'],
  ['ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated', 'Intel UHD Graphics 620'],
  ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete', 'Intel Arc A770 Graphics'],
  ['ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated', 'Intel Arc Graphics'],
  ['ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete', 'AMD Radeon RX 6700 XT'],
  ['ANGLE (AMD, AMD Radeon 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated', 'AMD Radeon 780M Graphics'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)', 'discrete', 'Apple M1 Pro'],
  ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'integrated', 'Apple M2'],
  ['ANGLE (Qualcomm, Qualcomm(R) Adreno(TM) X1-85 GPU (0x36334330) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated', 'Qualcomm Adreno X1-85 GPU'],
  ['Mali-G78', 'mobile', 'Mali-G78'],
  ['Apple A15 GPU', 'mobile', 'Apple A15 GPU'],
  ['Mesa Intel(R) UHD Graphics 620 (KBL GT2)', 'integrated', 'Mesa Intel UHD Graphics 620 (KBL GT2)'],
  ['llvmpipe (LLVM 15.0.7, 256 bits)', 'software', 'llvmpipe (LLVM 15.0.7, 256 bits)'],
  ['NVIDIA GeForce GTX 980, or similar', 'discrete', 'NVIDIA GeForce GTX 980'],
  ['WebKit WebGL', 'unknown', 'WebKit WebGL'],
];

test('calidad: tipo y nombre legible de la tarjeta gráfica', () => {
  for (const [raw, kind, name] of GPUS) {
    assert.equal(gpuKind(raw), kind, raw);
    assert.equal(gpuName(raw), name, raw);
  }
});

test('calidad: nivel automático', () => {
  assert.equal(autoTier(GPUS[0][0], { small: false }), 'medium');   // el equipo de pruebas (Radeon integrada)
  assert.equal(autoTier(GPUS[1][0], { small: false }), 'high');
  assert.equal(autoTier(GPUS[1][0], { small: true }), 'low');       // celular: siempre Básica
  assert.equal(autoTier('llvmpipe (LLVM 15.0.7, 256 bits)', { small: false }), 'low');
  assert.equal(autoTier(GPUS[1][0], { small: false, memoryGb: 2 }), 'low');
  assert.equal(autoTier('WebKit WebGL', { small: false }), 'medium');
  // Máxima nunca se elige sola
  for (const [raw] of GPUS) assert.ok(tierRank(autoTier(raw, { small: false })) <= tierRank('high'));
});

test('calidad: Normal y Básica conservan la densidad de píxeles de siempre', () => {
  for (const d of [1, 1.25, 1.5, 2, 3]) {
    assert.equal(pixelRatio(qualityParams('medium'), d, 1440 * 900), Math.min(d, 2));
    assert.equal(pixelRatio(qualityParams('low', true), d, 390 * 844), Math.min(d, 1.6));
    assert.equal(pixelRatio(qualityParams('high'), d, 1440 * 900), Math.min(d, 2));
  }
});

test('calidad: Máxima supermuestrea dentro del presupuesto de píxeles', () => {
  const q = qualityParams('ultra');
  assert.equal(pixelRatio(q, 1, 1440 * 900), 1.5);
  assert.equal(pixelRatio(q, 2, 1440 * 900), 2);
  // monitor 4K al 100 %: 1.5 pasaría de 10 MP; baja hasta caber, nunca debajo de la pantalla
  const r = pixelRatio(q, 1, 3840 * 2160);
  assert.ok(r >= 1 && 3840 * 2160 * r * r <= 10e6 + 1, String(r));
  assert.equal(pixelRatio(q, 1.5, 2560 * 1440), 1.5);
  // celular: el tope de 1.6 manda
  assert.equal(pixelRatio(qualityParams('ultra', true), 3, 390 * 844), 1.6);
});

test('calidad: cada nivel pide al menos lo del anterior', () => {
  const tiers = ['low', 'medium', 'high', 'ultra'] as const;
  for (let i = 1; i < tiers.length; i++) {
    const a = qualityParams(tiers[i - 1]), b = qualityParams(tiers[i]);
    assert.ok(b.clouds.steps >= a.clouds.steps && b.clouds.res >= a.clouds.res && b.clouds.noise >= a.clouds.noise);
    assert.ok(b.tiles.dem >= a.tiles.dem && b.tiles.sat >= a.tiles.sat && b.tiles.satKm >= a.tiles.satKm);
    assert.ok(b.blend[3] >= a.blend[3] && b.blend[1] >= a.blend[1]);
    assert.ok(b.accumulate >= a.accumulate);
    // las distancias de la mezcla van en orden: 90 m entero < sin 90 m; 30 m entero < sin 30 m
    assert.ok(b.blend[0] < b.blend[1] && b.blend[2] < b.blend[3]);
  }
  // los rayos de la sombra llegan a ≥ 60 km (sombras largas al atardecer)
  for (const t of ['high', 'ultra'] as const) {
    const { steps, grow } = qualityParams(t).rayShadows;
    assert.ok((0.04 * (grow ** steps - 1)) / (grow - 1) >= 60, t);
  }
});
