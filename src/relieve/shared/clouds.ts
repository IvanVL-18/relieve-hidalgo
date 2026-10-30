/**
 * Cielo del visor: tipos de nubes, parámetros y su ciclo a lo largo del día. Sin three (lo importa la interfaz).
 * Las nubes son una simulación ilustrativa, no un pronóstico: se forman más donde llueve más (lluvia media anual de
 * INEGI), siguen al relieve (la base de los cúmulos va ~1.2 km sobre el terreno de la región) y el viento las arrastra.
 */

/** «hoy» = las nubes que ve el satélite GOES (shared/goes.ts); las demás son simuladas */
export type CloudKind = 'auto' | 'cumulos' | 'nublado' | 'niebla' | 'tormenta' | 'hoy';

export interface CloudSettings {
  kind: CloudKind;
  /** cantidad relativa, 0–1 (0.5 = la típica del tipo de cielo) */
  amount: number;
  /** de dónde viene el viento, en grados desde el norte (70 = del este-noreste: los alisios del Golfo) */
  wind: number;
  /** lapso de tiempo: las nubes avanzan, crecen y se deshacen solas (con «hoy», repite el día del satélite) */
  play: boolean;
  /** con «hoy»: otro día de los últimos ~3 meses que guarda GIBS («2026-09-11», hora de México); por omisión, hoy */
  day?: string;
}

export const CLOUD_DEFAULTS: CloudSettings = { kind: 'auto', amount: 0.5, wind: 70, play: false };

/** Tipos simulados. hint = descripción para la ayuda emergente; note = una línea para el panel */
export const CLOUD_KINDS: { id: Exclude<CloudKind, 'hoy'>; label: string; hint: string; note: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Cambian con la hora: niebla al amanecer, cúmulos de día y tormentas por la tarde', note: '' },
  { id: 'cumulos', label: 'Cúmulos', hint: 'Buen tiempo: cúmulos sueltos, más sobre la sierra y la Huasteca', note: 'Buen tiempo, más sobre la sierra' },
  { id: 'nublado', label: 'Nublado', hint: 'Capa de estratocúmulos con algunos claros', note: 'Estratocúmulos con algunos claros' },
  { id: 'niebla', label: 'Niebla', hint: 'Mar de nubes en la Huasteca y la sierra, niebla en el fondo de los valles', note: 'Mar de nubes y niebla en los valles' },
  { id: 'tormenta', label: 'Tormenta', hint: 'Cumulonimbos con yunque y lluvia, como las tormentas de la tarde en temporada de lluvias', note: 'Cumulonimbos de la tarde, con lluvia' },
];

/**
 * Parámetros de las dos capas: la de cúmulos, estratos y tormentas (sobre el relieve suavizado de la región) y la de
 * niebla (pegada al suelo). Alturas en km: base y niebla en km reales sobre el nivel del mar o el terreno (se exageran
 * con el relieve); los espesores, en km tal como se ven (no se exageran, para que las nubes conserven su forma).
 */
export interface SkyParams {
  /** cobertura de cúmulos o estratos, 0–1 */
  cover: number;
  /** base sobre el relieve suavizado (km reales) */
  base: number;
  /** espesor de cúmulos o estratos (km) */
  thick: number;
  /** 0 = cúmulos (cimas redondas), 1 = estratos (capa plana) */
  stratus: number;
  /** fracción de celdas de tormenta activas, 0–1 */
  storm: number;
  /** altura de las torres de tormenta sobre su base (km) */
  stormTop: number;
  /** cantidad de niebla, 0–1 */
  fog: number;
  /** cima del mar de nubes donde el clima es húmedo (km sobre el nivel del mar) */
  fogTop: number;
  /** espesor de la niebla de valle sobre el fondo del valle (km) */
  fogValley: number;
}

const P = (cover: number, base: number, thick: number, stratus: number, storm: number, stormTop: number, fog: number, fogTop: number, fogValley: number): SkyParams =>
  ({ cover, base, thick, stratus, storm, stormTop, fog, fogTop, fogValley });

export const SKY_PRESETS: Record<Exclude<CloudKind, 'auto' | 'hoy'>, SkyParams> = {
  cumulos: P(0.42, 1.25, 2.0, 0, 0, 9, 0, 1.4, 0),
  nublado: P(0.62, 0.9, 1.2, 0.85, 0, 9, 0.25, 1.3, 0.12),
  niebla: P(0.1, 1.5, 1.0, 0.4, 0, 9, 1, 1.95, 0.22),
  tormenta: P(0.32, 1.0, 2.4, 0, 0.6, 11, 0, 1.4, 0),
};

/** Ciclo de un día de temporada de lluvias: [hora, parámetros, descripción]. */
const DAY: [number, SkyParams, string][] = [
  [5, P(0.06, 1.5, 0.8, 0.5, 0, 9, 1, 2.0, 0.22), 'Madrugada: mar de nubes en la Huasteca'],
  [7.5, P(0.08, 1.5, 0.8, 0.4, 0, 9, 1, 2.0, 0.22), 'Amanecer: mar de nubes y niebla en valles'],
  [10.5, P(0.3, 1.2, 1.2, 0, 0, 9, 0, 1.5, 0.05), 'Mañana: la niebla se disipa'],
  [13.5, P(0.38, 1.25, 1.8, 0, 0, 9, 0, 1.4, 0), 'Mediodía: cúmulos sobre la sierra'],
  [16, P(0.44, 1.25, 2.6, 0, 0.3, 9.5, 0, 1.4, 0), 'Tarde: los cúmulos crecen'],
  [18.5, P(0.48, 1.1, 2.6, 0, 0.8, 11, 0, 1.4, 0), 'Tarde: tormentas sobre la sierra'],
  [20.5, P(0.6, 1.0, 1.6, 0.6, 0.3, 10, 0.35, 1.4, 0.1), 'Noche: las tormentas se deshacen'],
];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
function mix(a: SkyParams, b: SkyParams, t: number): SkyParams {
  const o = {} as SkyParams;
  for (const k of Object.keys(a) as (keyof SkyParams)[]) o[k] = lerp(a[k], b[k], t);
  return o;
}

/** Parámetros y descripción corta del cielo para un tipo y una hora (5–20.5); «hoy» sin satélite se ve como «auto». */
export function skyFor(kind: CloudKind, hour: number): { params: SkyParams; text: string } {
  if (kind !== 'auto' && kind !== 'hoy') return { params: { ...SKY_PRESETS[kind] }, text: CLOUD_KINDS.find(k => k.id === kind)!.note };
  const h = Math.min(DAY[DAY.length - 1][0], Math.max(DAY[0][0], hour));
  let i = 1;
  while (i < DAY.length - 1 && h > DAY[i][0]) i++;
  const [h0, a] = DAY[i - 1], [h1, b, text] = DAY[i];
  const t = smooth(Math.min(1, Math.max(0, (h - h0) / (h1 - h0))));
  return { params: mix(a, b, t), text: t < 0.5 ? DAY[i - 1][2] : text };
}

/**
 * Aplica la cantidad elegida (0–1; 0.5 deja el tipo como está): las coberturas crecen como 1 − (1 − c)^(2·cantidad),
 * así que 0 quita las nubes y 1 casi las duplica sin pasar de 1; la niebla también sube su cima.
 */
export function withAmount(p: SkyParams, amount: number): SkyParams {
  const k = 2 * Math.min(1, Math.max(0, amount));
  const more = (c: number) => (k === 0 ? 0 : c >= 1 ? 1 : 1 - Math.pow(1 - c, k));
  return { ...p, cover: more(p.cover), storm: more(p.storm), fog: more(p.fog), fogTop: p.fogTop + (k - 1) * 0.35, fogValley: p.fogValley * Math.min(1.6, k) };
}

const WIND_NAMES = ['del norte', 'del noreste', 'del este', 'del sureste', 'del sur', 'del suroeste', 'del oeste', 'del noroeste'];
/** «del noreste» para 45°. */
export const windName = (deg: number) => WIND_NAMES[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** Hacia dónde avanzan las nubes, en km del modelo (x al este, z al sur), para un viento que viene de `deg`. */
export function windVector(deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [-Math.sin(a), Math.cos(a)];
}

/** Clima para las nubes, en una rejilla gruesa alineada a la del visor (un texel cada f nodos, con m texeles de margen). */
export interface WeatherGrid {
  /** RGBA8 por texel: estado (máscara suave), humedad (0–1), relieve suavizado y fondo de los valles (m / 3500) */
  data: Uint8Array;
  w: number;
  h: number;
  f: number;
  m: number;
  /** pendiente máxima del relieve suavizado y del fondo de los valles (km por km) */
  slope: number;
  /** relieve suavizado máximo dentro del estado (km) */
  maxSmooth: number;
}

/** Humedad 0–1 desde la lluvia media anual: 450 mm (Mezquital) → 0; 2 300 mm (Huasteca y sierra) → 1. */
export const humidityOf = (mm: number) => { const t = Math.min(1, Math.max(0, (mm - 450) / 1850)); return t * t * (3 - 2 * t); };

/** Promedio móvil separable con bordes repetidos (passes veces ≈ gaussiana). */
function boxBlur(a: Float32Array, w: number, h: number, r: number, passes: number) {
  const b = new Float32Array(w * h), k = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let s = 0;
      for (let x = -r; x <= r; x++) s += a[o + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) { b[o + x] = s * k; s += a[o + Math.min(w - 1, x + r + 1)] - a[o + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) { a[y * w + x] = s * k; s += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x]; }
    }
  }
  return a;
}

/** Mínimo en una ventana de (2r + 1)² texeles (separable). */
function minFilter(a: Float32Array, w: number, h: number, r: number) {
  const b = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = Infinity;
    for (let d = -r; d <= r; d++) v = Math.min(v, a[y * w + Math.min(w - 1, Math.max(0, x + d))]);
    b[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = Infinity;
    for (let d = -r; d <= r; d++) v = Math.min(v, b[Math.min(h - 1, Math.max(0, y + d)) * w + x]);
    out[y * w + x] = v;
  }
  return out;
}

/**
 * Clima de las nubes desde el relieve de 270 m (m), los municipios (0 = fuera del estado) y la lluvia media anual
 * (mm / 20 por nodo, 0 = sin dato; null = humedad pareja). cellKm = km por celda del visor.
 */
export function buildWeather(elev: ArrayLike<number>, muni: ArrayLike<number>, W: number, H: number, cellKm: number, rain: ArrayLike<number> | null, f = 4, m = 12): WeatherGrid {
  const w = Math.ceil((W - 1) / f) + 1 + 2 * m, h = Math.ceil((H - 1) / f) + 1 + 2 * m, n = w * h, half = f / 2;
  const mask = new Float32Array(n), el = new Float32Array(n), lo = new Float32Array(n), mm = new Float32Array(n).fill(NaN);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const r0 = (j - m) * f, c0 = (i - m) * f;
    let cnt = 0, inside = 0, sum = 0, low = Infinity, rs = 0, rn = 0;
    for (let dr = -half; dr < half; dr++) for (let dc = -half; dc < half; dc++) {
      const r = r0 + dr, c = c0 + dc, out = r < 0 || c < 0 || r >= H || c >= W;
      const k = Math.min(H - 1, Math.max(0, r)) * W + Math.min(W - 1, Math.max(0, c));
      cnt++;
      if (!out && muni[k]) inside++;
      sum += elev[k];
      low = Math.min(low, elev[k]);
      if (!out && rain && rain[k]) { rs += rain[k] * 20; rn++; }
    }
    const t = j * w + i;
    mask[t] = inside / cnt; el[t] = sum / cnt; lo[t] = low;
    if (rn) mm[t] = rs / rn;
  }
  boxBlur(mask, w, h, 4, 3);
  // base de los cúmulos: relieve de la región (σ ≈ 8 km); niebla de valle: mínimo en ~3 km, suavizado
  boxBlur(el, w, h, 7, 3);
  const floor = boxBlur(minFilter(lo, w, h, 3), w, h, 2, 2);
  // lluvia: los texeles sin dato toman el promedio de sus vecinos (crece hacia afuera desde los que tienen)
  const prev = new Float32Array(n);
  for (let it = 0, missing = true; missing && it < 400; it++) {
    missing = false;
    prev.set(mm);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (prev[i] === prev[i]) continue;
      let s = 0, c = 0;
      if (x > 0 && prev[i - 1] === prev[i - 1]) { s += prev[i - 1]; c++; }
      if (x < w - 1 && prev[i + 1] === prev[i + 1]) { s += prev[i + 1]; c++; }
      if (y > 0 && prev[i - w] === prev[i - w]) { s += prev[i - w]; c++; }
      if (y < h - 1 && prev[i + w] === prev[i + w]) { s += prev[i + w]; c++; }
      if (c) mm[i] = s / c; else missing = true;
    }
  }
  for (let i = 0; i < n; i++) if (Number.isNaN(mm[i])) mm[i] = 900;
  boxBlur(mm, w, h, 3, 2);
  const texKm = f * cellKm;
  let slope = 0, maxSmooth = 0;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    for (const a of [el, floor]) slope = Math.max(slope, Math.abs(a[i + 1] - a[i]) / 1000 / texKm, Math.abs(a[i + w] - a[i]) / 1000 / texKm);
    if (mask[i] > 0.05) maxSmooth = Math.max(maxSmooth, el[i] / 1000);
  }
  const data = new Uint8Array(n * 4), u8 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let i = 0; i < n; i++) {
    data[i * 4] = u8(mask[i]);
    data[i * 4 + 1] = u8(rain ? humidityOf(mm[i]) : 0.5);
    data[i * 4 + 2] = u8(el[i] / 3500);
    data[i * 4 + 3] = u8(floor[i] / 3500);
  }
  return { data, w, h, f, m, slope, maxSmooth };
}
