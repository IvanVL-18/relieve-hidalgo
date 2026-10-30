/**
 * Nubes de hoy: imágenes del satélite GOES-Este (NOAA) que publica NASA GIBS por WMS (gratis, sin llave, con CORS; una
 * cada 10 min con ~40 min de retraso y ~3 meses de archivo). Sin dependencias: lo usan el worker, el motor, la interfaz
 * (tipos) y las pruebas.
 *
 *   · Infrarrojo limpio (banda 13, 10.3 µm, 2 km), de día y de noche: temperatura de la cima → altura (lo frío está alto).
 *   · Visible rojo (banda 2, 1 km), de día: reflectancia → cobertura, espesor y textura (cúmulos o capa).
 *
 * Aquí, lo ligero (recuadro, horas, día, estado): lo usan también el motor y la interfaz. La lectura de las imágenes y los
 * campos de las nubes están en goesImage.ts (solo el worker).
 */

export const GIBS_URL = 'https://gibs.earthdata.nasa.gov';
export const IR_LAYER = 'GOES-East_ABI_Band13_Clean_Infrared';
export const VIS_LAYER = 'GOES-East_ABI_Band2_Red_Visible_1km';
/** color «GeoColor» (CIRA): de noche marca las nubes bajas en azul claro (diferencia de 3.9 y 10.3 µm), que el infrarrojo no ve */
export const GEO_LAYER = 'GOES-East_ABI_GeoColor';
/** grados por píxel de la rejilla de 2 km de GIBS en EPSG:4326 (origen en −180, 90); el visible usa la mitad */
export const IR_RES = 0.017578125;
/** minutos entre las imágenes del día que se bajan (GOES-Este en GIBS: cada 10) */
export const STEP_MIN = 20;
/** hora de México (centro): UTC−6 todo el año */
const MX_H = -6;
const MIN = 60e3, HOUR = 3600e3;

/** Recuadro pedido al WMS, alineado a la rejilla de 2 km de GIBS (así no remuestrea). w × h = píxeles del visible. */
export interface LiveBox { west: number; south: number; east: number; north: number; w: number; h: number }

/** Recuadro que cubre [oeste, sur, este, norte] alineado hacia afuera a la rejilla de 2 km. */
export function liveBox(west: number, south: number, east: number, north: number): LiveBox {
  const c0 = Math.floor((west + 180) / IR_RES), c1 = Math.ceil((east + 180) / IR_RES);
  const r0 = Math.floor((90 - north) / IR_RES), r1 = Math.ceil((90 - south) / IR_RES);
  return { west: -180 + c0 * IR_RES, east: -180 + c1 * IR_RES, north: 90 - r0 * IR_RES, south: 90 - r1 * IR_RES, w: (c1 - c0) * 2, h: (r1 - r0) * 2 };
}

/** «2026-10-29T21:50:00Z» */
export const isoMinute = (ms: number) => new Date(Math.round(ms / MIN) * MIN).toISOString().slice(0, 16) + ':00Z';

/** GetMap del WMS de GIBS (EPSG:4326, versión 1.3.0: el recuadro va en latitud, longitud). ir = rejilla de 2 km. */
export function wmsUrl(base: string, layer: string, b: LiveBox, ir: boolean, time: number) {
  const k = ir ? 2 : 1;
  return `${base.replace(/\/$/, '')}/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&STYLES=&CRS=EPSG:4326`
    + `&BBOX=${b.south},${b.west},${b.north},${b.east}&WIDTH=${b.w / k}&HEIGHT=${b.h / k}&FORMAT=image/png&TIME=${isoMinute(time)}`;
}

/** Horas con imagen entre t0 y t1 (DescribeDomains del WMTS: unos cientos de bytes, en caché de CloudFront 30 min). */
export const domainsUrl = (base: string, layer: string, t0: number, t1: number) =>
  `${base.replace(/\/$/, '')}/wmts/epsg4326/best/1.0.0/${layer}/default/2km/all/${isoMinute(t0)}--${isoMinute(t1)}.xml`;

/** Lista de horas (ms) de una respuesta de DescribeDomains: «inicio/fin/PT10M,…» o fechas sueltas. */
export function parseDomains(xml: string): number[] {
  const m = xml.match(/<Domain>([^<]*)<\/Domain>/);
  if (!m) return [];
  const out = new Set<number>();
  for (const part of m[1].split(',')) {
    const [a, b, per] = part.trim().split('/');
    const t0 = Date.parse(a);
    if (Number.isNaN(t0)) continue;
    if (!b) { out.add(t0); continue; }
    const t1 = Date.parse(b), pm = per?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/);
    const step = pm ? ((+(pm[1] ?? 0)) * 60 + +(pm[2] ?? 0)) * MIN : 10 * MIN;
    for (let t = t0; t <= t1 && step > 0; t += step) out.add(t);
  }
  return [...out].sort((x, y) => x - y);
}

/** Medianoche (hora de México) del día que se muestra: hoy, o ayer si aún no hay imágenes de día (antes de las 6:00). */
export function liveDayStart(now: number) {
  const local = now + MX_H * HOUR, mid = Math.floor(local / 86400e3) * 86400e3 - MX_H * HOUR;
  return local - Math.floor(local / 86400e3) * 86400e3 < 6 * HOUR ? mid - 86400e3 : mid;
}

/** Fecha [año, mes 0–11, día] de una medianoche de liveDayStart. */
export function dayYmd(dayStart: number): [number, number, number] {
  const d = new Date(dayStart + MX_H * HOUR + 12 * HOUR);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

/**
 * Días del archivo: el WMS de GIBS guarda ~91 días de GOES-Este y borra lo anterior hora por hora (DescribeDomains
 * sigue listando desde 2019, pero esas imágenes llegan vacías). 90 días hacia atrás contando hoy: el más viejo aún
 * tiene sus imágenes de 5:00 a 20:40.
 */
export const ARCHIVE_DAYS = 90;
/** «2026-09-11» de una medianoche de liveDayStart */
export const dayIso = (dayStart: number) => new Date(dayStart + MX_H * HOUR + 12 * HOUR).toISOString().slice(0, 10);
/** Medianoche (hora de México) de «2026-09-11»; null si no es una fecha válida. */
export function dayStartOf(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], -MX_H);
  return dayIso(t) === day ? t : null;
}
/** Primer y último día que se pueden elegir («2026-08-01», «2026-10-29»): el último es el de hoy (liveDayStart). */
export function archiveRange(now: number): [string, string] {
  const today = liveDayStart(now);
  return [dayIso(liveDayStart(now - (ARCHIVE_DAYS - 1) * 86400e3)), dayIso(today)];
}

/**
 * Imágenes del día: una cada STEP_MIN min de las 5:00 a las 20:40 (hora de México) y la última disponible. Cada marca
 * toma la disponible más cercana a ≤ 10 min (GIBS a veces se salta una).
 */
export function pickFrames(available: number[], dayStart: number): number[] {
  if (!available.length) return [];
  const latest = available[available.length - 1], out = new Set<number>();
  for (let t = dayStart + 5 * HOUR; t <= Math.min(latest, dayStart + 20 * HOUR + 40 * MIN); t += STEP_MIN * MIN) {
    let best = -1, bd = 10 * MIN + 1;
    for (const a of available) { const d = Math.abs(a - t); if (d < bd) { bd = d; best = a; } }
    if (best >= 0) out.add(best);
  }
  out.add(latest);
  return [...out].sort((x, y) => x - y);
}

/**
 * Altitud media del terreno (km) en cada píxel del visible, desde la rejilla del visor (m; lon0, lat0 = primer nodo, al
 * noroeste). Fuera de la rejilla, la del borde más cercano.
 */
export function elevForBox(elev: ArrayLike<number>, W: number, H: number, lon0: number, lat0: number, step: number, b: LiveBox): Float32Array {
  // un píxel del visible (≈ 0.0088°) abarca ~3.5 nodos del visor por lado: se promedian los que caen dentro
  const out = new Float32Array(b.w * b.h), res = (b.east - b.west) / b.w;
  const at = (r: number, c: number) => elev[Math.min(H - 1, Math.max(0, r)) * W + Math.min(W - 1, Math.max(0, c))];
  for (let y = 0; y < b.h; y++) {
    const ra = Math.ceil((lat0 - (b.north - y * res)) / step), rb = Math.max(ra, Math.floor((lat0 - (b.north - (y + 1) * res)) / step));
    for (let x = 0; x < b.w; x++) {
      const ca = Math.ceil((b.west + x * res - lon0) / step), cb = Math.max(ca, Math.floor((b.west + (x + 1) * res - lon0) / step));
      let s = 0;
      for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) s += at(r, c);
      out[y * b.w + x] = s / ((rb - ra + 1) * (cb - ca + 1)) / 1000;
    }
  }
  return out;
}

/** Estado de las nubes de hoy, para la interfaz. */
export interface LiveCloudsStatus {
  state: 'loading' | 'ready' | 'error';
  /** hora (ms) de la imagen que se ve y de la última disponible */
  shown?: number;
  latest?: number;
  /** imágenes del día: bajadas y en total */
  loaded: number;
  total: number;
  /** hora local (decimal) de la primera y la última imagen del día */
  firstHour?: number;
  lastHour?: number;
  /** de dónde vienen las nubes (grados desde el norte) y a qué velocidad (km/h), si se pudo medir */
  windDeg?: number;
  windKmh?: number;
  /** amanecer y anochecer (hora local decimal) del día que se muestra; los pone el motor */
  sunrise?: number;
  sunset?: number;
  message?: string;
}

/** Hora local de México (decimal) de un instante. */
export const mxHour = (ms: number) => ((((ms / HOUR + MX_H) % 24) + 24) % 24);
