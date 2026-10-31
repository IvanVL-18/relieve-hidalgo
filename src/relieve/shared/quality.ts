/**
 * Calidad de imagen por niveles. «auto» elige según la tarjeta gráfica (el nombre que da WebGL) y el tamaño de la
 * pantalla; las demás las elige quien mira. Sin dependencias: la usan la interfaz (etiquetas) y el motor (parámetros).
 *
 * Normal es el visor de siempre. Alta y Máxima suman lo que solo aguanta una tarjeta dedicada: sombras trazadas sobre
 * el relieve que se dibuja, agua con reflejos, más relieve fino a lo lejos, nubes más definidas y, al detenerse, varios
 * cuadros desplazados menos de un píxel que se promedian (bordes sin dientes y nubes sin grano).
 */
export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';
export type QualitySetting = 'auto' | QualityTier;

export const QUALITY_LEVELS: { id: QualitySetting; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'La que conviene a la tarjeta gráfica de este equipo' },
  { id: 'low', label: 'Básica', hint: 'Relieve de 270 m, sin teselas finas: para equipos lentos o para ahorrar batería.' },
  { id: 'medium', label: 'Normal', hint: 'Relieve de 30 m e imagen satelital fina al acercarte; sombras y nubes a media resolución.' },
  {
    id: 'high', label: 'Alta',
    hint: 'Sombras trazadas sobre el relieve fino, agua con reflejos y destellos, más detalle a lo lejos y bordes suaves al detenerte.',
  },
  { id: 'ultra', label: 'Máxima', hint: 'Lo de Alta con más resolución, nubes más definidas y relieve aún más denso. Pide una tarjeta potente.' },
];

const ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];
export const tierRank = (t: QualityTier) => ORDER.indexOf(t);
export const isQualitySetting = (v: unknown): v is QualitySetting => v === 'auto' || ORDER.includes(v as QualityTier);

export interface CloudQuality {
  /** pasos del recorrido por el volumen y hacia la luz */
  steps: number;
  lsteps: number;
  /** fracción de los px de CSS a la que se calcula el volumen y tope de píxeles */
  res: number;
  maxPx: number;
  /** texeles por lado del ruido 3D de la forma (más = detalle más fino de cerca) */
  noise: number;
  /** lado del mapa de sombra de las nubes */
  shadowPx: number;
}

export interface QualityParams {
  tier: QualityTier;
  /** relieve fino (90 y 30 m) e imagen satelital fina al acercarse */
  fine: boolean;
  /**
   * densidad de píxeles: tope, mínimo aunque la pantalla tenga menos (supermuestreo) y presupuesto en megapíxeles del
   * supermuestreo
   */
  dpr: { max: number; ss: number; mpx: number };
  /** niveles de detalle del relieve: profundidad del árbol (8 → cuadros de 34 m) y rango del nivel más fino (km) */
  lod: { depth: number; range: number };
  /** relieve de 90 m entero hasta [0] km de la cámara y nada desde [1]; el de 30 m, entero hasta [2] y nada desde [3] */
  blend: [number, number, number, number];
  /** ranuras por lado de los atlas de teselas (relieve de 30 m e imagen) y radio de la imagen fina (km) */
  tiles: { dem: number; sat: number; satKm: number };
  /** lado del mapa de sombras del Sol */
  shadowMap: number;
  /** sombras del relieve trazadas sobre la superficie que se dibuja: pasos y crecimiento de cada paso (0 = mapa de sombras) */
  rayShadows: { steps: number; grow: number };
  /** agua con oleaje, reflejo del cielo y destellos del Sol */
  water: boolean;
  /** cuadros que se promedian en reposo (antialias progresivo); 0 = ninguno */
  accumulate: number;
  /** edificios a menos de estos km de la cámara (0 = ninguno) y distancia mínima de la cámara a lo que mira (km) */
  buildingsKm: number;
  minKm: number;
  clouds: CloudQuality;
}

const TIERS: Record<QualityTier, Omit<QualityParams, 'tier'>> = {
  low: {
    fine: false, dpr: { max: 1.6, ss: 0, mpx: 0 }, lod: { depth: 5, range: 30 }, blend: [60, 100, 14, 24],
    tiles: { dem: 0, sat: 0, satKm: 0 }, shadowMap: 2048, rayShadows: { steps: 0, grow: 0 }, water: false, accumulate: 0, buildingsKm: 0, minKm: 12,
    clouds: { steps: 44, lsteps: 3, res: 0.4, maxPx: 560_000, noise: 64, shadowPx: 256 },
  },
  medium: {
    fine: true, dpr: { max: 2, ss: 0, mpx: 0 }, lod: { depth: 8, range: 30 }, blend: [60, 100, 14, 24],
    tiles: { dem: 14, sat: 8, satKm: 45 }, shadowMap: 4096, rayShadows: { steps: 0, grow: 0 }, water: false, accumulate: 0, buildingsKm: 9, minKm: 6,
    clouds: { steps: 72, lsteps: 4, res: 0.5, maxPx: 560_000, noise: 64, shadowPx: 512 },
  },
  high: {
    fine: true, dpr: { max: 2, ss: 0, mpx: 0 }, lod: { depth: 8, range: 40 }, blend: [90, 150, 22, 36],
    tiles: { dem: 20, sat: 12, satKm: 65 }, shadowMap: 4096, rayShadows: { steps: 28, grow: 1.24 }, water: true, accumulate: 8, buildingsKm: 12, minKm: 4,
    clouds: { steps: 96, lsteps: 5, res: 0.7, maxPx: 1_200_000, noise: 96, shadowPx: 1024 },
  },
  ultra: {
    fine: true, dpr: { max: 3, ss: 1.5, mpx: 10 }, lod: { depth: 9, range: 22 }, blend: [120, 200, 32, 50],
    tiles: { dem: 26, sat: 16, satKm: 90 }, shadowMap: 4096, rayShadows: { steps: 40, grow: 1.16 }, water: true, accumulate: 16, buildingsKm: 18, minKm: 3,
    clouds: { steps: 128, lsteps: 6, res: 1, maxPx: 2_500_000, noise: 128, shadowPx: 1024 },
  },
};

/** Parámetros de un nivel; small = pantalla de celular (la densidad de píxeles se queda en 1.6 como antes). */
export function qualityParams(tier: QualityTier, small = false): QualityParams {
  const t = TIERS[tier];
  return { tier, ...t, dpr: small ? { ...t.dpr, max: Math.min(t.dpr.max, 1.6) } : t.dpr };
}

/**
 * Densidad de píxeles del lienzo: la de la pantalla hasta el tope del nivel; con supermuestreo (Máxima) al menos q.dpr.ss,
 * sin pasar del presupuesto de megapíxeles. cssPx = ancho × alto del lienzo en px de CSS.
 */
export function pixelRatio(q: QualityParams, device: number, cssPx: number) {
  const d = device || 1;
  let r = Math.min(q.dpr.max, Math.max(d, q.dpr.ss));
  if (r > d && q.dpr.mpx > 0 && cssPx * r * r > q.dpr.mpx * 1e6) r = Math.max(Math.min(d, q.dpr.max), Math.sqrt((q.dpr.mpx * 1e6) / Math.max(1, cssPx)));
  return r;
}

export type GpuKind = 'discrete' | 'integrated' | 'mobile' | 'software' | 'unknown';

/** Nombre legible de la tarjeta: «ANGLE (AMD, AMD Radeon(TM) Graphics (0x164C) Direct3D11…)» → «AMD Radeon Graphics». */
export function gpuName(renderer: string) {
  let s = renderer.trim();
  const angle = /^ANGLE \((.*)\)$/.exec(s);
  if (angle) {
    // «fabricante, nombre (0x…) Direct3D11 …, D3D11» o «Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version»
    const parts = angle[1].split(', ');
    s = parts.length > 1 ? parts[1] : parts[0];
    s = s.replace(/^ANGLE Metal Renderer: /, '');
  }
  return s
    .replace(/\s*\(0x[0-9a-f]+\)/gi, '')
    .replace(/\s+(Direct3D|OpenGL|Vulkan|vs_\d|ps_\d).*$/i, '')
    .replace(/\((TM|R)\)/gi, '')
    .replace(/,? or similar$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Tipo de tarjeta según su nombre. Las integradas recientes más capaces (Radeon 780M, Arc integrada) cuentan como integradas. */
export function gpuKind(renderer: string): GpuKind {
  const g = renderer.toLowerCase();
  if (!g || /^(webkit webgl|mozilla|apple gpu)$/.test(g.trim())) return 'unknown';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) return 'software';
  if (/mali|adreno(?!.*x1)|powervr|apple a\d|tegra|videocore|immortalis|xclipse/.test(g)) return 'mobile';
  if (/geforce mx|\bmx\d{3}\b/.test(g)) return 'integrated';
  if (/nvidia|geforce|quadro|rtx|gtx|titan/.test(g)) return 'discrete';
  if (/radeon (rx|pro|r9|r7|vii|hd \d{4})|\brx \d{3,4}|firepro|instinct/.test(g)) return 'discrete';
  if (/arc(\(tm\))? [ab]\d{3}/.test(g)) return 'discrete';
  if (/apple m\d+ (pro|max|ultra)/.test(g)) return 'discrete';
  if (/intel|radeon|vega|apple m\d|adreno|graphics/.test(g)) return 'integrated';
  return 'unknown';
}

/**
 * Nivel que conviene: Básica en celulares, programas sin tarjeta y equipos con muy poca memoria; Alta con tarjeta
 * dedicada; Normal en lo demás (integradas y desconocidas). Máxima no se elige sola.
 */
export function autoTier(renderer: string, o: { small: boolean; memoryGb?: number }): QualityTier {
  const kind = gpuKind(renderer);
  if (o.small || kind === 'software' || kind === 'mobile') return 'low';
  if (o.memoryGb !== undefined && o.memoryGb > 0 && o.memoryGb <= 2) return 'low';
  return kind === 'discrete' ? 'high' : 'medium';
}
