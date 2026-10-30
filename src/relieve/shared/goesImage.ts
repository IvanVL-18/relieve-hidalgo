/**
 * Nubes de hoy: lectura de las imágenes de GOES (PNG del WMS de GIBS) y campos de las nubes en una rejilla de ≈ 1 km con
 * cuatro canales (cobertura, cima, densidad y convección) que el sombreador convierte en volumen con el mismo ruido que
 * las nubes simuladas. Sin dependencias; lo usan el worker (goes.worker.ts) y las pruebas.
 */

import type { LiveBox } from './goes';

const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Lee un PNG de 8 bits sin entrelazar (lo que entrega GIBS) a RGBA8. */
export async function decodePng(src: ArrayBuffer): Promise<{ w: number; h: number; rgba: Uint8Array }> {
  const b = new Uint8Array(src), dv = new DataView(src);
  if (b.length < 33 || dv.getUint32(0) !== 0x89504e47) throw new Error('la respuesta no es una imagen PNG');
  let p = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, size = 0;
  let plte: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p), t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]), d = b.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = b[p + 16]; type = b[p + 17]; interlace = b[p + 20]; }
    else if (t === 'PLTE') plte = d;
    else if (t === 'tRNS') trns = d;
    else if (t === 'IDAT') { idat.push(d); size += len; }
    else if (t === 'IEND') break;
    p += 12 + len;
  }
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (depth !== 8 || interlace || !ch || !w || !h) throw new Error(`PNG no admitido (tipo ${type}, ${depth} bits)`);
  const z = new Uint8Array(size);
  for (let o = 0, i = 0; i < idat.length; o += idat[i].length, i++) z.set(idat[i], o);
  const raw = new Uint8Array(await new Response(new Blob([z]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = w * ch, px = new Uint8Array(stride * h);
  if (raw.length < (stride + 1) * h) throw new Error('PNG incompleto');
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], s = y * (stride + 1) + 1, o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[o + x - ch] : 0, up = y ? px[o - stride + x] : 0, c = x >= ch && y ? px[o - stride + x - ch] : 0;
      let v = raw[s + x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      px[o + x] = v;
    }
  }
  if (ch === 4) return { w, h, rgba: px };
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (type === 3) {
      const k = px[i];
      rgba[o] = plte?.[k * 3] ?? 0; rgba[o + 1] = plte?.[k * 3 + 1] ?? 0; rgba[o + 2] = plte?.[k * 3 + 2] ?? 0; rgba[o + 3] = trns && k < trns.length ? trns[k] : 255;
    } else if (ch === 3) { rgba[o] = px[i * 3]; rgba[o + 1] = px[i * 3 + 1]; rgba[o + 2] = px[i * 3 + 2]; rgba[o + 3] = 255; }
    else { rgba[o] = rgba[o + 1] = rgba[o + 2] = px[i * ch]; rgba[o + 3] = ch === 2 ? px[i * 2 + 1] : 255; }
  }
  return { w, h, rgba };
}

/**
 * Paleta «Clean Longwave Infrared Window» de GIBS (colormaps/v1.3/Clean_Longwave_Infrared_Window_Band.xml): de −91.6 °C a
 * −18.85 °C, 86 colores (cada 1 °C hasta −31.6 y cada 0.5 °C después); de −18.35 a 57 °C es una rampa gris lineal (196 →
 * 1). Los grises 177…5 de −77.6 a −70.6 °C se repiten en la rampa cálida: se distinguen por sus vecinos (ver irCelsius).
 */
const COLD_HEX = 'ffffff7f007f8c0d8799198ea52696b2339dbf40a5cc4cadd959b4e566bcf272c3ff7fcbe6e6e6ccccccb1b1b19b9b9b8181816666664c4c4c3636361b1b1b0505051a00003300004d0000660000800000990000b30000cc0000e60000ff0000ff1a00ff3300ff4d00ff6600ff8000ff9900ffb300ffcc00ffe600ffff00e6ff00ccff00b3ff0099ff0080ff0066ff004dff0033ff001aff0000ff0000ea0a00d41300bf1d00aa2600953000803a006a4300554d004056002a6000156900007300007d000d7a001a8100268800338f004096004c9d0059a40066ab0073b20080b9008cc00099c700a6ce00b2d500bfdc00cce300d9ea00e6f100f2f800ffffc5c5c5';
const COLD = Array.from({ length: COLD_HEX.length / 6 }, (_, i) => ({
  r: parseInt(COLD_HEX.slice(i * 6, i * 6 + 2), 16), g: parseInt(COLD_HEX.slice(i * 6 + 2, i * 6 + 4), 16), b: parseInt(COLD_HEX.slice(i * 6 + 4, i * 6 + 6), 16),
  t: i <= 60 ? -91.6 + i : -30.85 + (i - 61) * 0.5,
}));
const COLORED = COLD.filter(e => !(e.r === e.g && e.g === e.b));
/** grises de la parte fría (blancos de −91.6 a −78.6 °C y la rampa de −77.6 a −70.6 °C) */
const COLD_GRAY = COLD.filter(e => e.r === e.g && e.g === e.b && e.t < -60);
const warmGray = (l: number) => 57.325 - 0.38672 * l;
const nearestGray = (l: number) => { let best = COLD_GRAY[0]; for (const e of COLD_GRAY) if (Math.abs(e.r - l) < Math.abs(best.r - l)) best = e; return best; };

/**
 * Temperatura de brillo (°C) de cada píxel de la imagen infrarroja de GIBS; NaN donde no hay dato. El WMS entrega los
 * colores con ±1 de error, así que se busca el más cercano. Un gris claro (≥ 199) es una cima muy fría; uno de la rampa
 * cálida solo se toma como frío (−70 a −78 °C) si está unido a una zona de colores muy fríos (< −60 °C).
 */
export function irCelsius(rgba: Uint8Array, w: number, h: number): Float32Array {
  const n = w * h, t = new Float32Array(n), gray = new Int16Array(n).fill(-1), cache = new Map<number, number>();
  // mezclas del remuestreo en los bordes (p. ej. gris + azul, que se parece al magenta de −90 °C): se rellenan con las vecinas
  const blend = new Uint8Array(n);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 4, r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    if (rgba[o + 3] < 128) { t[i] = NaN; continue; }
    if (Math.abs(r - g) <= 3 && Math.abs(g - b) <= 3) {
      const l = Math.round((r + g + b) / 3);
      if (l >= 199) { t[i] = nearestGray(l).t; stack.push(i); } else { t[i] = warmGray(l); gray[i] = l; }
      continue;
    }
    const key = (r << 16) | (g << 8) | b;
    let v = cache.get(key);
    if (v === undefined) {
      let bd = Infinity;
      v = 0;
      for (const e of COLORED) { const d = (e.r - r) ** 2 + (e.g - g) ** 2 + (e.b - b) ** 2; if (d < bd) { bd = d; v = e.t; } }
      if (bd > 400) v = NaN;
      cache.set(key, v);
    }
    t[i] = v;
    if (v !== v) blend[i] = 1;
    else if (v < -60) stack.push(i);
  }
  // los grises unidos a lo muy frío son la rampa fría (cimas de −70 a −78 °C)
  while (stack.length) {
    const i = stack.pop()!, x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx, l = gray[j];
      if (l < 0) continue;
      gray[j] = -1;
      const e = nearestGray(l);
      if (Math.abs(e.r - l) <= 3) { t[j] = e.t; stack.push(j); }
    }
  }
  // mezclas: mediana de las vecinas con dato (dos pasadas para las líneas de dos píxeles)
  const near = (i: number, out: number[]) => {
    const x = i % w, y = (i - x) / w;
    out.length = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h && t[yy * w + xx] === t[yy * w + xx]) out.push(t[yy * w + xx]);
    }
    return out.sort((a, b) => a - b);
  };
  const buf: number[] = [];
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) if (blend[i] && t[i] !== t[i]) { const v = near(i, buf); if (v.length) t[i] = v[v.length >> 1]; }
  // píxeles sueltos que no se parecen a ninguna vecina (> 20 K de la mediana): errores de color
  const fixed = t.slice();
  for (let i = 0; i < n; i++) {
    if (t[i] !== t[i]) continue;
    const v = near(i, buf);
    if (v.length >= 5 && Math.abs(t[i] - v[v.length >> 1]) > 20) fixed[i] = v[v.length >> 1];
  }
  return fixed;
}

/**
 * Nubes bajas de noche en GeoColor: azul claro (verde y azul altos) sobre el suelo azul oscuro; las luces de las ciudades
 * (más rojas que azules) no cuentan. 0–1 por píxel del visible.
 */
export function nightLowClouds(rgba: Uint8Array): Float32Array {
  const n = rgba.length / 4, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    out[i] = rgba[i * 4 + 3] < 128 || r > b ? 0 : sstep(55, 120, Math.min(g, b));
  }
  return out;
}

/** Reflectancia del visible rojo: GIBS la entrega como √(R · seno de la altura del Sol) × 255. NaN sin dato. */
export function visReflectance(rgba: Uint8Array, sinElev: Float32Array): Float32Array {
  const n = sinElev.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = rgba[i * 4] / 255;
    out[i] = rgba[i * 4 + 3] < 128 ? NaN : (v * v) / Math.max(sinElev[i], 0.05);
  }
  return out;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** gradiente de temperatura con la altura que se supone (K por km) */
const LAPSE = 6.5;

/** Lo que el worker guarda entre imágenes: la reflectancia mínima (suelo despejado) y la temperatura del suelo despejado. */
export interface LiveMemory { rMin: Float32Array; clearDay?: number; clearNight?: number }

export interface LiveFields {
  /** RGBA8 por píxel de la rejilla visible (w × h, de norte a sur): cobertura, cima (km s. n. m. / 16), densidad, convección */
  data: Uint8Array;
  /** frialdad de las nubes en la rejilla de 2 km (K bajo el suelo despejado), para medir el movimiento */
  cold: Float32Array;
  /** núcleos de tormenta: [columna, renglón, cima km] en píxeles del visible */
  cores: number[];
  /** cima más alta (km) y pendiente máxima de la cima (km por píxel) donde hay nube */
  maxTop: number;
  slope: number;
}

/** Promedio móvil (2r + 1)² con bordes repetidos; los NaN no cuentan. */
function blur(a: Float32Array, w: number, h: number, r: number) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const v = a[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
      if (v === v) { s += v; c++; }
    }
    out[y * w + x] = c ? s / c : NaN;
  }
  return out;
}

/** Valor bilineal de una rejilla de 2 km en el centro de un píxel del visible (la de 2 km tiene la mitad de lado). */
function up2(a: Float32Array, w2: number, h2: number, x: number, y: number) {
  const fx = Math.min(w2 - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), fy = Math.min(h2 - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w2 - 1, x0 + 1), y1 = Math.min(h2 - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
  const v00 = a[y0 * w2 + x0], v10 = a[y0 * w2 + x1], v01 = a[y1 * w2 + x0], v11 = a[y1 * w2 + x1];
  // sin dato en una esquina: la más cercana con dato
  if (!(v00 === v00 && v10 === v10 && v01 === v01 && v11 === v11)) {
    const c = [v00, v10, v01, v11].filter(v => v === v);
    return c.length ? c.reduce((s, v) => s + v, 0) / c.length : NaN;
  }
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

/**
 * Campos de una imagen. irC = °C en la rejilla de 2 km; refl = reflectancia del visible (null de noche); sinElev = seno de
 * la altura del Sol por píxel del visible; elev = altitud media del terreno por píxel del visible (km); w × h = visible.
 *
 *   · Suelo despejado: la temperatura baja 6.5 K por km de altitud; su nivel sale de los píxeles despejados de la imagen
 *     (de día los que el visible ve oscuros) y si casi no hay, de la imagen anterior.
 *   · Cobertura: de día, reflectancia sobre la del suelo (la mínima del día en ese píxel); además, lo que el infrarrojo ve
 *     mucho más frío que el suelo (cirros). De noche, el infrarrojo y, si llega (low), las nubes bajas de GeoColor.
 *   · Cima: altitud del suelo + (suelo despejado − cima) / 6.5 K por km. Si la nube no llena el píxel de 2 km, la mezcla
 *     sale más tibia: se corrige con la cobertura del visible.
 *   · Densidad: reflectancia (de día) o frialdad (de noche). Convección: textura del visible (cúmulos) y núcleos fríos.
 */
export function buildFields(
  irC: Float32Array, refl: Float32Array | null, sinElev: Float32Array, elev: Float32Array, w: number, h: number, mem: LiveMemory, low: Float32Array | null = null,
): LiveFields {
  const w2 = w / 2, h2 = h / 2, n = w * h, n2 = w2 * h2;
  // altitud del terreno en la rejilla de 2 km
  const elev2 = new Float32Array(n2), day2 = new Float32Array(n2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const i = (y * 2) * w + x * 2;
    elev2[y * w2 + x] = (elev[i] + elev[i + 1] + elev[i + w] + elev[i + w + 1]) / 4;
    day2[y * w2 + x] = refl ? sstep(0.07, 0.17, (sinElev[i] + sinElev[i + w + 1]) / 2) : 0;
  }
  // reflectancia del suelo: la mínima del día (los cúmulos se mueven), sin pasar de 0.14 (una capa que no se va)
  const fVis = new Float32Array(n), rRef = new Float32Array(n), wd = new Float32Array(n);
  if (refl) for (let i = 0; i < n; i++) {
    const r = refl[i];
    wd[i] = r === r ? sstep(0.07, 0.17, sinElev[i]) : 0;
    if (wd[i] > 0.5) mem.rMin[i] = Math.min(mem.rMin[i], r);
    rRef[i] = Math.min(0.14, Math.max(0.03, Math.min(mem.rMin[i], r === r ? r : 1)));
    fVis[i] = r === r ? sstep(rRef[i] + 0.05, rRef[i] + 0.3, r) : 0;
  }
  // nivel del suelo despejado (°C al nivel del mar): de día, donde el visible no ve nube; de noche, lo más tibio
  const isDay = refl !== null && day2.reduce((s, v) => s + v, 0) > n2 * 0.5;
  const cand: number[] = [];
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const j = y * w2 + x, t = irC[j];
    if (!(t === t) || t < -15) continue;
    if (isDay) { const i = (y * 2) * w + x * 2; if (Math.max(fVis[i], fVis[i + 1], fVis[i + w], fVis[i + w + 1]) > 0.05) continue; }
    cand.push(t + LAPSE * elev2[j]);
  }
  cand.sort((a, b) => a - b);
  const prev = isDay ? mem.clearDay : mem.clearNight;
  let clear = cand.length > n2 * 0.02 ? cand[Math.floor(cand.length * (isDay ? 0.6 : 0.9))] : prev ?? (isDay ? 32 : 20);
  // sin muchos píxeles despejados, la estimación no baja de golpe respecto a la imagen anterior
  if (prev !== undefined && cand.length < n2 * 0.15) clear = Math.max(clear, prev - 3);
  if (isDay) mem.clearDay = clear; else mem.clearNight = clear;
  // frialdad: cuánto más fría que el suelo despejado está la cima
  const cold = new Float32Array(n2);
  for (let j = 0; j < n2; j++) { const t = irC[j]; cold[j] = t === t ? clear - LAPSE * elev2[j] - t : 0; }
  // núcleos de tormenta: cimas muy frías y más frías que sus alrededores (≈ 10 km), que también son fríos (en el borde
  // de un yunque el promedio de alrededor es tibio y no cuenta)
  const around = blur(irC, w2, h2, 2), core2 = new Float32Array(n2);
  for (let j = 0; j < n2; j++) { const t = irC[j]; core2[j] = t === t ? sstep(1.5, 5, around[j] - t) * sstep(-32, -55, t) * sstep(-25, -40, around[j]) : 0; }
  const fIr2 = new Float32Array(n2);
  for (let j = 0; j < n2; j++) fIr2[j] = sstep(isDay ? 4 : 5, isDay ? 12 : 14, cold[j]);

  const f = new Float32Array(n), top = new Float32Array(n), dens = new Float32Array(n), conv = new Float32Array(n);
  // cobertura del visible en cada píxel de 2 km (para corregir la cima de las nubes que no llenan el píxel)
  const fv2 = new Float32Array(n2);
  if (refl) for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) { const i = (y * 2) * w + x * 2; fv2[y * w2 + x] = (fVis[i] + fVis[i + 1] + fVis[i + w] + fVis[i + w + 1]) / 4; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, d = wd[i];
    const c = up2(cold, w2, h2, x, y), fi = up2(fIr2, w2, h2, x, y), core = up2(core2, w2, h2, x, y);
    if (!(c === c)) continue;
    // de día cuenta el visible y lo muy frío (cirros que el visible apenas ve); de noche, el infrarrojo
    // (de día el infrarrojo solo cuenta lo muy frío: el suelo de la Huasteca y el del altiplano no calientan igual)
    const fDay = Math.max(fVis[i], sstep(14, 28, c)), fl = low ? low[i] : 0;
    f[i] = d * fDay + (1 - d) * Math.max(fi, fl);
    // nube que no llena el píxel de 2 km: la mezcla con el suelo la hace ver más tibia (corrección moderada: el visible
    // casi no ve los cirros delgados y la corrección los subiría de más)
    const cover = d > 0 ? Math.max(0.7, up2(fv2, w2, h2, x, y)) : 1;
    const dT = Math.min(Math.max(0, c) / (d * cover + (1 - d)), Math.max(0, c) + 10);
    top[i] = Math.min(17, elev[i] + Math.max(0.3, (dT - 3 * d) / LAPSE));
    const r = refl ? refl[i] : NaN;
    const densDay = r === r ? sstep(rRef[i] + 0.05, rRef[i] + 0.65, r) : 0.5;
    dens[i] = d * densDay + (1 - d) * Math.max(0.3 + 0.7 * sstep(4, 40, c), 0.55 * fl);
    // textura: desviación de la reflectancia en 3 × 3 sobre su media (los campos de cúmulos son moteados)
    let tex = 0;
    if (d > 0 && refl) {
      let s = 0, s2 = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const v = refl[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
        if (v === v) { s += v; s2 += v * v; k++; }
      }
      if (k > 1) { const m = s / k; tex = Math.sqrt(Math.max(0, s2 / k - m * m)) / (m + 0.08); }
    }
    // (de noche no hay textura: 0.35, o capa si la nube es baja)
    conv[i] = Math.max(d * (0.1 + 0.5 * sstep(0.04, 0.16, tex)) + (1 - d) * (fl > fi ? 0.15 : 0.35), core);
  }
  // cima, densidad y convección del núcleo de la nube (cobertura > 50 %) hacia el borde y el cielo despejado: en el borde
  // la mezcla con el suelo da una cima más baja y, al filtrar la textura, la nube se hundiría. Las nubes sueltas que no
  // tienen núcleo cerca conservan lo suyo
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) valid[i] = f[i] > 0.5 ? 1 : 0;
  const own = [top.slice(), dens.slice(), conv.slice()], was = new Uint8Array(n);
  for (let pass = 0; pass < 8; pass++) {
    was.set(valid);
    let any = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (was[i]) continue;
      let st = 0, sd = 0, sc = 0, k = 0;
      for (let q = 0; q < 4; q++) {
        const j = q === 0 ? (x > 0 ? i - 1 : -1) : q === 1 ? (x < w - 1 ? i + 1 : -1) : q === 2 ? (y > 0 ? i - w : -1) : y < h - 1 ? i + w : -1;
        if (j >= 0 && was[j]) { st += top[j]; sd += dens[j]; sc += conv[j]; k++; }
      }
      if (k) { top[i] = st / k; dens[i] = sd / k; conv[i] = sc / k; valid[i] = 1; any = true; }
    }
    if (!any) break;
  }
  for (let i = 0; i < n; i++) {
    if (valid[i]) continue;
    if (f[i] > 0.04) { top[i] = own[0][i]; dens[i] = own[1][i]; conv[i] = own[2][i]; } else { top[i] = elev[i] + 1.5; dens[i] = 0.3; conv[i] = 0.2; }
  }
  // la cobertura, apenas suavizada (3 × 3): bordes de ~2 km en vez de escalones de un píxel
  const fs = blur(f, w, h, 1);
  const data = new Uint8Array(n * 4);
  let maxTop = 0, slope = 0;
  for (let i = 0; i < n; i++) {
    data[i * 4] = Math.round(clamp01((f[i] + fs[i]) / 2) * 255);
    data[i * 4 + 1] = Math.round(clamp01(top[i] / 16) * 255);
    data[i * 4 + 2] = Math.round(clamp01(dens[i]) * 255);
    data[i * 4 + 3] = Math.round(clamp01(conv[i]) * 255);
    if (f[i] > 0.04) {
      maxTop = Math.max(maxTop, top[i]);
      const x = i % w;
      if (x < w - 1) slope = Math.max(slope, Math.abs(top[i + 1] - top[i]));
      if (i + w < n) slope = Math.max(slope, Math.abs(top[i + w] - top[i]));
    }
  }
  // núcleos: máximos locales en la rejilla de 2 km
  const cores: number[] = [];
  for (let y = 1; y < h2 - 1 && cores.length < 120; y++) for (let x = 1; x < w2 - 1; x++) {
    const j = y * w2 + x, v = core2[j];
    if (v < 0.6) continue;
    let peak = true;
    for (let dy = -1; dy <= 1 && peak; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && core2[j + dy * w2 + dx] > v) { peak = false; break; }
    if (peak) cores.push(x * 2 + 1, y * 2 + 1, top[(y * 2 + 1) * w + x * 2 + 1]);
  }
  return { data, cold, cores, maxTop, slope };
}

/**
 * Cuánto se movieron las nubes de a a b (rejillas de frialdad de 2 km): el desplazamiento entero de ±max píxeles con menor
 * diferencia cuadrática, afinado con una parábola. ok = hay nubes y el mínimo es claro.
 */
export function shiftBetween(a: Float32Array, b: Float32Array, w: number, h: number, max = 12): { dx: number; dy: number; ok: boolean } {
  const cap = (v: number) => Math.min(30, Math.max(0, v));
  let energy = 0;
  for (let i = 0; i < a.length; i++) energy += cap(a[i]);
  if (energy < a.length * 0.3) return { dx: 0, dy: 0, ok: false };
  const S = 2 * max + 1, cost = new Float64Array(S * S);
  for (let dy = -max; dy <= max; dy++) for (let dx = -max; dx <= max; dx++) {
    let s = 0, c = 0;
    for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y += 2) for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x += 2) {
      const d = cap(a[y * w + x]) - cap(b[(y + dy) * w + x + dx]);
      s += d * d; c++;
    }
    cost[(dy + max) * S + dx + max] = c > 50 ? s / c : Infinity;
  }
  let bi = 0;
  for (let i = 1; i < cost.length; i++) if (cost[i] < cost[bi]) bi = i;
  const bx = bi % S, by = (bi - bx) / S, at = (x: number, y: number) => cost[Math.min(S - 1, Math.max(0, y)) * S + Math.min(S - 1, Math.max(0, x))];
  const par = (l: number, m: number, r: number) => { const den = l - 2 * m + r; return den > 1e-9 ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den))) : 0; };
  const c0 = cost[bi], zero = cost[max * S + max];
  // en el borde de la búsqueda o sin un mínimo marcado, no hay medida
  const ok = bx > 0 && by > 0 && bx < S - 1 && by < S - 1 && Number.isFinite(c0) && (zero - c0 > c0 * 0.05 || bi === max * S + max);
  return { dx: bx - max + par(at(bx - 1, by), c0, at(bx + 1, by)), dy: by - max + par(at(bx, by - 1), c0, at(bx, by + 1)), ok };
}

/** Seno de la altura del Sol en cada píxel del visible (se calcula en una red de 9 × 9 y se interpola). */
export function sunGrid(b: LiveBox, sinElevAt: (lat: number, lon: number) => number): Float32Array {
  const N = 9, lat = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) lat[j * N + i] = sinElevAt(b.north - ((b.north - b.south) * j) / (N - 1), b.west + ((b.east - b.west) * i) / (N - 1));
  const out = new Float32Array(b.w * b.h);
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
    const fx = ((x + 0.5) / b.w) * (N - 1), fy = ((y + 0.5) / b.h) * (N - 1), i = Math.min(N - 2, Math.floor(fx)), j = Math.min(N - 2, Math.floor(fy)), tx = fx - i, ty = fy - j;
    out[y * b.w + x] = (lat[j * N + i] * (1 - tx) + lat[j * N + i + 1] * tx) * (1 - ty) + (lat[(j + 1) * N + i] * (1 - tx) + lat[(j + 1) * N + i + 1] * tx) * ty;
  }
  return out;
}
