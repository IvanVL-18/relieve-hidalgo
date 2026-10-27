/** Colores en sRGB 0–1. La rampa se interpola en sRGB, igual que en el artefacto original. */
export type RGB = [number, number, number];
type Stop = [m: number, c: RGB];

const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const stops = (list: [number, string][]): Stop[] => list.map(([m, h]) => [m, hex(h)]);

/** Tintas hipsométricas del artefacto (modo «Altitud»). Exportadas para la leyenda. */
export const ALT_STOPS_HEX: [number, string][] = [
  [0, '#1f5a2e'], [350, '#2f7234'], [800, '#558a3a'], [1300, '#8c9449'],
  [1750, '#b59a5c'], [2100, '#bfa06a'], [2400, '#9c8458'], [2750, '#5f6b40'],
  [3050, '#4a5638'], [3350, '#857d70'],
];
const ALT = stops(ALT_STOPS_HEX);

export const ROCK_ALT = hex('#6e5d4c');

function ramp(list: Stop[], e: number, out: RGB): RGB {
  if (e <= list[0][0]) return copy(out, list[0][1]);
  for (let k = 1; k < list.length; k++) {
    if (e <= list[k][0]) {
      const t = (e - list[k - 1][0]) / (list[k][0] - list[k - 1][0]);
      return mix(copy(out, list[k - 1][1]), list[k][1], t);
    }
  }
  return copy(out, list[list.length - 1][1]);
}
export const altRamp = (e: number, out: RGB) => ramp(ALT, e, out);

export function copy(out: RGB, a: RGB): RGB { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; }
export function mix(out: RGB, b: RGB, t: number): RGB {
  out[0] += (b[0] - out[0]) * t; out[1] += (b[1] - out[1]) * t; out[2] += (b[2] - out[2]) * t;
  return out;
}
export function scale(out: RGB, k: number): RGB { out[0] *= k; out[1] *= k; out[2] *= k; return out; }
export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const toByte = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Ruido de valor determinista sobre la rejilla (las variaciones son siempre las mismas). */
function hash(x: number, y: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
export function fbm(x: number, y: number, octaves = 3) {
  let s = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) { s += valueNoise(x, y) * amp; norm += amp; x *= 2.03; y *= 2.03; amp *= 0.5; }
  return s / norm;
}
