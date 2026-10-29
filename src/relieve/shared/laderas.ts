/**
 * Índice propio de susceptibilidad de laderas: las reglas que comparten la cadena de datos (build-laderas.mjs, que
 * calcula la capa) y el análisis (desglose de puntos al pasar el cursor y capas de cada factor). Sin dependencias y solo
 * sintaxis borrable: Node importa este .ts directamente.
 *
 *   puntos = 2 · clase de pendiente + clase de lluvia intensa + roca + cobertura
 *   clase  = muy baja ≤ 2 · baja 3–4 · media 5–6 · alta 7–8 · muy alta ≥ 9; con pendiente < 5° siempre muy baja y con
 *            < 10° a lo más baja (en lo plano no hay laderas que se deslicen)
 *
 * Los pesos de la roca siguen la idea del método de Mora-Vahrson (susceptibilidad litológica): lo que se intemperiza a
 * arcilla o está poco consolidado se desliza más que la roca dura y masiva. A escala 1:250 000 solo se sabe el tipo de
 * roca, no su fracturamiento ni su alteración, así que es una aproximación.
 */

export const CLASES = ['Muy baja', 'Baja', 'Media', 'Alta', 'Muy alta'];

/** Clase 0…cortes.length de un valor según sus cortes (el valor de un corte ya es de la clase siguiente). */
export function claseDe(v: number, cortes: number[]): number {
  let k = 0;
  while (k < cortes.length && v >= cortes[k]) k++;
  return k;
}

/** Pendiente media a 30 m en grados; cada clase vale 2 puntos. */
export const PENDIENTE = { cortes: [10, 20, 30, 40], etiquetas: ['< 10°', '10–20°', '20–30°', '30–40°', '> 40°'], peso: 2 };

/**
 * Lluvia intensa: el máximo de cada año de la lluvia en 5 días (pentadas de CHIRPS), promediado de 1981 a 2025, en mm.
 * Es lo que dispara los deslizamientos (varios días de lluvia fuerte), más que el total anual.
 */
export const LLUVIA = { cortes: [60, 100, 150, 200], etiquetas: ['< 60 mm', '60–100 mm', '100–150 mm', '150–200 mm', '> 200 mm'] };

/** Tipos de roca de la geología de INEGI (columna TIPO; los depósitos sin consolidar vienen como entidad «SUELO»). */
export const ROCAS: { tipo: string; puntos: number; nota: string }[] = [
  { tipo: 'Lutita', puntos: 2, nota: 'se intemperiza a arcilla y pierde resistencia al mojarse' },
  { tipo: 'Lutita-Arenisca', puntos: 2, nota: 'capas de lutita entre areniscas (formaciones de la Sierra y la Huasteca)' },
  { tipo: 'Limolita-Arenisca', puntos: 2, nota: 'roca fina que se intemperiza a arcilla' },
  { tipo: 'Caliza-Lutita', puntos: 1, nota: 'capas de lutita entre calizas: planos débiles' },
  { tipo: 'Volcanoclástico', puntos: 1, nota: 'tobas y brechas volcánicas poco consolidadas' },
  { tipo: 'Conglomerado', puntos: 1, nota: 'poco cementado' },
  { tipo: 'Arenisca-Conglomerado', puntos: 1, nota: 'poco cementado' },
  { tipo: 'Brecha sedimentaria', puntos: 1, nota: 'poco cementada' },
  { tipo: 'Suelo', puntos: 1, nota: 'depósitos sueltos (aluvión, coluvión, lacustre)' },
  { tipo: 'Arenisca', puntos: 0, nota: 'intermedia' },
  { tipo: 'Ígnea extrusiva ácida', puntos: 0, nota: 'riolitas e ignimbritas, a menudo fracturadas' },
  // sanas son duras, pero en la Sierra suelen estar alteradas: en el atlas estatal, con pendiente > 20°, tienen más
  // deslizamientos de los que tocarían por su área (razón 1.4), así que no restan
  { tipo: 'Ígnea extrusiva intermedia', puntos: 0, nota: 'andesitas, a menudo alteradas y fracturadas' },
  { tipo: 'Ígnea extrusiva básica', puntos: -1, nota: 'basaltos: roca dura' },
  { tipo: 'Ígnea intrusiva ácida', puntos: -1, nota: 'granitos: roca dura' },
  { tipo: 'Caliza', puntos: -1, nota: 'caliza masiva: más caídas de bloques que deslizamientos' },
];

/** Cobertura según el grupo de uso de suelo (id de USV_GROUPS) de la Serie VII; código 0–3 por píxel. */
export const COBERTURA: { nombre: string; puntos: number }[] = [
  { nombre: 'Bosque o selva primarios', puntos: -1 },
  { nombre: 'Matorral, vegetación secundaria u otra', puntos: 0 },
  { nombre: 'Asentamientos', puntos: 0.5 },
  { nombre: 'Agricultura, pastizal o sin vegetación', puntos: 1 },
];

const BOSQUE = new Set(['conifera', 'encino', 'mesofilo', 'selva']), ABIERTO = new Set(['temporal', 'riego', 'pastizal', 'sinveg']);

/** Código de cobertura (índice en COBERTURA) de un grupo de uso de suelo; null = agua (sin dato). */
export function coberturaDe(grupo: string, secundaria: boolean): number | null {
  if (grupo === 'agua') return null;
  if (BOSQUE.has(grupo) && !secundaria) return 0;
  if (ABIERTO.has(grupo)) return 3;
  return grupo === 'urbano' ? 2 : 1;
}

/** Puntos del índice a partir de las clases de cada factor (roca −1 = sin dato: 0 puntos). */
export function puntos(pendiente: number, lluvia: number, roca: number, cobertura: number): number {
  return PENDIENTE.peso * pendiente + lluvia + (roca >= 0 ? ROCAS[roca].puntos : 0) + COBERTURA[cobertura].puntos;
}

/** Clase 1–5 (muy baja … muy alta) según los puntos y la pendiente en grados. */
export function clasificar(pts: number, grados: number): number {
  const k = pts <= 2 ? 1 : pts <= 4 ? 2 : pts <= 6 ? 3 : pts <= 8 ? 4 : 5;
  return grados < 5 ? 1 : grados < 10 ? Math.min(k, 2) : k;
}

/**
 * Empaque de laderas.bin (3 planos de w·h bytes):
 *   0: clase (bits 0–2, 0 = sin dato) · clase de pendiente (bits 3–5) · cobertura (bits 6–7)
 *   1: roca + 1 (0 = sin dato)
 *   2: clase de lluvia + 1 (bits 0–2, 0 = sin dato) · dentro de una zona de peligro del atlas estatal (bit 3)
 */
export const empacar = {
  p0: (clase: number, pendiente: number, cobertura: number) => clase | (pendiente << 3) | (cobertura << 6),
  p2: (lluvia: number, zona: number) => (lluvia + 1) | (zona << 3),
};
export const desempacar = (p0: number, p1: number, p2: number) => ({
  clase: p0 & 7, pendiente: (p0 >> 3) & 7, cobertura: p0 >> 6, roca: p1 - 1, lluvia: (p2 & 7) - 1, zona: (p2 >> 3) & 1,
});
