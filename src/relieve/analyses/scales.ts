/**
 * Escalas y paletas de los análisis. Rampas de un solo tono validadas como ordinales contra la superficie
 * oscura del visor (#0e121a) con el validador de la guía de visualización: índice 0 = menos, último = más.
 */
export const POP_RAMP = ['#7a3a12', '#a8521a', '#d17024', '#ef9440', '#ffbf73'];
export const MARG_RAMP = ['#6e3170', '#923b8f', '#b44dab', '#d266c4', '#ee90db'];
/** tiempo de traslado: claro = cerca, oscuro = lejos */
export const TIME_RAMP = ['#fde0c2', '#f9b98a', '#f28c5a', '#df6236', '#bd4124', '#93291a'];
export const TIME_BREAKS = [15, 30, 60, 90, 120];
export const TIME_LABELS = ['< 15 min', '15–30', '30–60', '1–1.5 h', '1.5–2 h', '> 2 h'];

/**
 * Matriz bivariada 3 × 3 (Stevens): columnas = pendiente (baja → alta, hacia cian),
 * filas = marginación (baja → alta, hacia magenta). Esquina de ambas altas en índigo.
 */
export const BIVARIATE = [
  ['#e8e8e8', '#ace4e4', '#5ac8c8'],
  ['#dfb0d6', '#a5add3', '#5698b9'],
  ['#be64ac', '#8c62aa', '#3b4994'],
];

/** Cortes por cuantiles (k clases → k − 1 cortes). */
export function quantileBreaks(values: number[], k: number) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return Array.from({ length: k - 1 }, (_, i) => v[Math.floor(((i + 1) / k) * (v.length - 1))]);
}
/** Clase (0…cortes.length) de un valor. */
export const classOf = (v: number, breaks: number[]) => { let c = 0; while (c < breaks.length && v > breaks[c]) c++; return c; };

export const hexToRgba = (hex: string, a = 255): [number, number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
};

export const fmtInt = (n: number) => Math.round(n).toLocaleString('es-MX');
export const fmtPct = (n: number, d = 1) => `${n.toFixed(d)} %`;
export const fmtMin = (m: number) => (!Number.isFinite(m) ? 'sin camino' : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`);
export const fmtShort = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e4 ? `${Math.round(n / 1e3)} mil` : fmtInt(n));

/** Correlación de Spearman (rangos), robusta a valores extremos. */
export function spearman(x: number[], y: number[]) {
  const rank = (a: number[]) => {
    const idx = a.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]), r = new Array<number>(a.length);
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(x), ry = rank(y), n = x.length, mx = (n - 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - mx); dx += (rx[i] - mx) ** 2; dy += (ry[i] - mx) ** 2; }
  return num / Math.sqrt(dx * dy);
}
