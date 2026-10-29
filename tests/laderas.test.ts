import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COBERTURA, LLUVIA, PENDIENTE, ROCAS, claseDe, clasificar, coberturaDe, desempacar, empacar, puntos } from '../src/relieve/shared/laderas';
// @ts-ignore: módulo de Node sin tipos (scripts de la cadena de datos)
import { lzwDecode } from '../scripts/pipeline/tiff.mjs';

/** Compresor LZW de TIFF para la prueba (como libtiff: Clear al inicio y al llenarse la tabla, ancho de 9 a 12 bits). */
function lzwEncode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let acc = 0, nacc = 0, width = 9, next = 258;
  const emit = (code: number) => {
    acc = (acc << width) | code; nacc += width;
    while (nacc >= 8) { out.push((acc >> (nacc - 8)) & 255); nacc -= 8; }
    acc &= (1 << nacc) - 1;
  };
  let dict = new Map<string, number>();
  const code = (s: string) => (s.length === 1 ? s.charCodeAt(0) : dict.get(s)!);
  emit(256);
  let w = '';
  for (const b of src) {
    const ch = String.fromCharCode(b), wc = w + ch;
    if (!w || dict.has(wc)) { w = wc; continue; }
    emit(code(w));
    dict.set(wc, next++);
    if (next === 4094) { emit(256); dict = new Map(); next = 258; width = 9; }
    else if (next > (1 << width) - 1) width++;
    w = ch;
  }
  if (w) emit(code(w));
  emit(257);
  if (nacc) out.push((acc << (8 - nacc)) & 255);
  return Uint8Array.from(out);
}

test('LZW de TIFF: ida y vuelta con repeticiones, cambios de ancho y tabla llena', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const n of [1, 2, 300, 5000, 60000]) {
    // mezcla de tramos repetidos (KwKwK) y bytes al azar de pocas clases
    const src = new Uint8Array(n);
    for (let i = 0; i < n; i++) src[i] = rnd() < 0.3 && i ? src[i - 1] : Math.floor(rnd() * 12) * 21;
    assert.deepEqual(lzwDecode(lzwEncode(src), n), src, `n = ${n}`);
  }
  const zeros = new Uint8Array(20000);
  assert.deepEqual(lzwDecode(lzwEncode(zeros), zeros.length), zeros);
  // float32 como en las tiras de CHIRPS
  const f = Float32Array.from({ length: 1720 }, (_, i) => (i % 40 < 20 ? -9999 : Math.round(Math.sin(i / 30) * 500) / 10));
  const bytes = new Uint8Array(f.buffer);
  assert.deepEqual(new Float32Array(lzwDecode(lzwEncode(bytes), bytes.length).buffer), f);
});

test('índice de laderas: clases, puntos y reglas de lo plano', () => {
  assert.equal(claseDe(9.99, PENDIENTE.cortes), 0);
  assert.equal(claseDe(10, PENDIENTE.cortes), 1);
  assert.equal(claseDe(45, PENDIENTE.cortes), 4);
  assert.equal(claseDe(150, LLUVIA.cortes), 3);
  const lutita = ROCAS.findIndex(r => r.tipo === 'Lutita-Arenisca'), caliza = ROCAS.findIndex(r => r.tipo === 'Caliza');
  // pendiente 30–40° (+6), lluvia 150–200 (+3), lutita (+2), pastizal (+1) = 12 → muy alta
  assert.equal(puntos(3, 3, lutita, 3), 12);
  assert.equal(clasificar(12, 35), 5);
  // misma ladera en caliza con bosque: 6 + 3 − 1 − 1 = 7 → alta
  assert.equal(clasificar(puntos(3, 3, caliza, 0), 35), 4);
  // en lo plano: < 5° siempre muy baja, < 10° a lo más baja
  assert.equal(clasificar(9, 4), 1);
  assert.equal(clasificar(9, 8), 2);
  assert.equal(puntos(1, 0, -1, 1), 2, 'roca sin dato vale 0');
  assert.equal(coberturaDe('agua', false), null);
  assert.equal(COBERTURA[coberturaDe('encino', false)!].puntos, -1);
  assert.equal(COBERTURA[coberturaDe('encino', true)!].puntos, 0);
  assert.equal(COBERTURA[coberturaDe('urbano', false)!].puntos, 0.5);
  assert.equal(COBERTURA[coberturaDe('temporal', false)!].puntos, 1);
});

test('empaque de laderas.bin: ida y vuelta', () => {
  for (const [clase, pendiente, cobertura, roca, lluvia, zona] of [[5, 4, 3, 14, 4, 1], [1, 0, 0, -1, 0, 0], [3, 2, 1, 6, 2, 1]]) {
    const d = desempacar(empacar.p0(clase, pendiente, cobertura), roca + 1, empacar.p2(lluvia, zona));
    assert.deepEqual(d, { clase, pendiente, cobertura, roca, lluvia, zona });
  }
});
