import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSurface, cleanMask, distanceField, previewImage, sampleLL, stlBytes, triangleCount, writeStl,
  type PrintGrid, type PrintInput, type PrintSurface, type SourceGrid,
} from '../src/relieve/analyses/impresion/model';

/** Triángulos del STL binario: vértices como texto (para comparar aristas) y volumen con signo. */
function readStl(buf: ArrayBuffer) {
  const dv = new DataView(buf), n = dv.getUint32(80, true), tris: number[][] = [];
  assert.equal(buf.byteLength, stlBytes(n));
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50, v: number[] = [];
    for (let k = 0; k < 9; k++) v.push(dv.getFloat32(o + 12 + k * 4, true));
    tris.push(v);
  }
  return tris;
}

/** Cada arista dirigida aparece una vez y su inversa también: malla cerrada y con orientación consistente. */
function assertClosed(tris: number[][]) {
  const key = (v: number[], i: number) => `${v[i * 3].toFixed(3)},${v[i * 3 + 1].toFixed(3)},${v[i * 3 + 2].toFixed(3)}`;
  const edges = new Map<string, number>();
  for (const v of tris) for (let i = 0; i < 3; i++) {
    const e = key(v, i) + '>' + key(v, (i + 1) % 3);
    edges.set(e, (edges.get(e) ?? 0) + 1);
  }
  for (const [e, c] of edges) {
    assert.equal(c, 1, `arista repetida ${e}`);
    const [a, b] = e.split('>');
    assert.equal(edges.get(b + '>' + a), 1, `arista sin pareja ${e}`);
  }
}

/** Volumen con signo (positivo si las normales miran hacia afuera). */
function volume(tris: number[][]) {
  let s = 0;
  for (const v of tris) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = v;
    s += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return s / 6;
}

const grid = (nx: number, ny: number, cx = 1, cy = 1): PrintGrid => ({ nx, ny, cx, cy, lon0: 0, lat0: 0, dLon: 1, dLat: 1 });
const flat = (nx: number, ny: number, inside: number[], h: number): PrintSurface => ({
  top: new Float32Array((nx + 1) * (ny + 1)).fill(h), inside: Uint8Array.from(inside), cells: inside.filter(Boolean).length, elevMin: 0, elevMax: 0, height: h,
});

test('STL: un bloque plano es una malla cerrada con el volumen exacto', () => {
  const s = flat(4, 3, new Array(12).fill(1), 5), g = grid(4, 3, 2, 1.5);
  // 4 por celda + 2 por cada lado del contorno (2 · (4 + 3) lados)
  assert.equal(triangleCount(s.inside, 4, 3), 4 * 12 + 2 * 14);
  const tris = readStl(writeStl(s, g));
  assertClosed(tris);
  assert.ok(Math.abs(volume(tris) - 4 * 2 * 3 * 1.5 * 5) < 1e-3);
});

test('STL: contorno irregular con hueco y cruce en diagonal sigue cerrado', () => {
  // anillo de 5 × 5 con hueco al centro y una celda suelta que toca por la esquina
  const nx = 7, ny = 6, inside = new Array(nx * ny).fill(0);
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) if (!(i === 2 && j === 2)) inside[j * nx + i] = 1;
  inside[5 * nx + 5] = 1;
  const s = flat(nx, ny, inside, 3);
  cleanMask(s.inside, nx, ny);
  // la limpieza agregó una celda junto al cruce
  assert.equal(s.inside.reduce((a, b) => a + b, 0), 24 + 1 + 1);
  const tris = readStl(writeStl(s, grid(nx, ny)));
  assertClosed(tris);
  assert.ok(Math.abs(volume(tris) - 26 * 3) < 1e-3);
  // con relieve también (alturas distintas por nodo)
  const r = { ...s, top: s.top.map((_, k) => 2 + ((k * 7919) % 13) / 4) };
  const t2 = readStl(writeStl(r, grid(nx, ny)));
  assertClosed(t2);
  assert.ok(volume(t2) > 0);
});

test('distancia euclidiana igual a la búsqueda exhaustiva', () => {
  const w = 23, h = 17, mask = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) mask[k] = (k * 2654435761) % 97 < 4 ? 1 : 0;
  const d = distanceField(mask, w, h);
  for (let k = 0; k < w * h; k++) {
    let best = Infinity;
    for (let q = 0; q < w * h; q++) if (mask[q]) best = Math.min(best, Math.hypot((k % w) - (q % w), Math.floor(k / w) - Math.floor(q / w)));
    assert.ok(Math.abs(d[k] - best) < 1e-4, `nodo ${k}: ${d[k]} vs ${best}`);
  }
});

test('muestreo bilineal en lon/lat respeta los bordes de los píxeles', () => {
  // 2 × 2 nodos; bounds = bordes de píxel: los centros quedan en ±0.5
  const g: SourceGrid = { width: 2, height: 2, bounds: [0, 0, 2, 2], data: Float32Array.from([10, 20, 30, 40]) };
  assert.equal(sampleLL(g, 0.5, 1.5), 10);
  assert.equal(sampleLL(g, 1.5, 0.5), 40);
  assert.equal(sampleLL(g, 1, 1), 25);
  assert.ok(Number.isNaN(sampleLL(g, 3, 1)));
});

test('superficie: base bajo el punto más bajo, exageración y río hundido', () => {
  // ladera que sube hacia el este: 1 000 m + 10 m por cada 0.01°; río norte-sur en lon 0.1
  const n = 41, elev: SourceGrid = { width: n, height: n, bounds: [-0.005, -0.005, 0.405, 0.405], data: new Float32Array(n * n) };
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) elev.data[r * n + c] = 1000 + c * 10;
  const acc: SourceGrid = { ...elev, data: new Float32Array(n * n) };
  for (let r = 0; r < n; r++) acc.data[r * n + 10] = 500 + (n - r) * 10;
  const nx = 40, ny = 40, g: PrintGrid = { nx, ny, cx: 0.5, cy: 0.5, lon0: 0, lat0: 0, dLon: 0.01, dLat: 0.01 };
  const base: PrintInput = {
    grid: g, elev, acc, muni: new Uint8Array(41 * 41).fill(1), inside: new Uint8Array(nx * ny).fill(1),
    params: { mmPerM: 0.01, base: 3, rivers: 'no', riverKm2: 100, borders: false, feature: 1, line: 1.2, places: [] },
  };
  const plain = buildSurface(base);
  assert.equal(plain.elevMin, 1000);
  assert.equal(plain.elevMax, 1400);
  assert.ok(Math.abs(plain.top[0] - 3) < 1e-4);
  assert.ok(Math.abs(plain.height - (3 + 400 * 0.01)) < 1e-4);
  const river = buildSurface({ ...base, params: { ...base.params, rivers: 'hundidos' } });
  const W = nx + 1, at = (s: PrintSurface, i: number) => s.top[20 * W + i];
  // sobre el río baja todo el hondo, lejos no cambia
  assert.ok(Math.abs(at(plain, 10) - at(river, 10) - 1) < 1e-3);
  assert.ok(Math.abs(at(plain, 20) - at(river, 20)) < 1e-6);
  // y el STL sigue cerrado
  assertClosed(readStl(writeStl(river, g)));
  const img = previewImage(river, g, 20);
  assert.equal(img.width, 20);
  assert.equal(img.rgba.length, 20 * 20 * 4);
});
