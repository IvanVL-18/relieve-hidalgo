/**
 * Enlaces a vistas: lo que se puede compartir (cámara, mapa base, hora, exageración, nubes, municipio y el análisis
 * con sus parámetros) y su forma en la URL. Sin dependencias: lo usan el componente, el anfitrión y las pruebas.
 * src/relieve/ no toca el historial: el anfitrión lee la URL con decodeViewState y la mantiene con onViewChange.
 *
 *   ?vista=-98.7637,20.0429,85,52,-30   lon, lat, distancia de la cámara (km), inclinación (0 = en planta) y rumbo (°)
 *   &mapa=satelite &hora=17.5 &exag=3 &nubes=niebla (o «no») &mun=13048
 *   &analisis=inundacion &a.punto=-99.3409,20.0524 &a.h=3      parámetros del análisis, con el prefijo «a.»
 */
import type { BaseMapId } from './basemaps';
import type { CloudKind } from './clouds';

/** Vista de la cámara: punto que mira, distancia (unidades de escena = 100 km) y ángulos en grados. */
export interface View { lon: number; lat: number; dist: number; polar: number; az: number }

export interface ViewState {
  view?: View;
  baseMap?: BaseMapId;
  /** hora local de México (5–20.5) */
  hour?: number;
  exaggeration?: number;
  /** tipo de nubes, o «no» si la capa está apagada */
  clouds?: CloudKind | 'no';
  /** clave INEGI del municipio seleccionado («13048»); con un análisis abierto, cada análisis guarda el suyo */
  municipio?: string;
  analysis?: string;
  /** estado del análisis: claves cortas → texto (lo define cada análisis) */
  params?: Record<string, string>;
}

const BASES: BaseMapId[] = ['usodesuelo', 'satelite', 'altitud'];
// 'hoy' = nubes reales del día (otra sesión lo agrega a CloudKind)
const CLOUDS: readonly string[] = ['auto', 'cumulos', 'nublado', 'niebla', 'tormenta', 'hoy', 'no'];
/** parámetros de la URL que son del visor (además de los «a.*»); los demás son del anfitrión y se conservan */
export const VIEW_KEYS = ['vista', 'mapa', 'hora', 'exag', 'nubes', 'mun', 'analisis'];
const PREFIX = 'a.';
const KM_PER_UNIT = 100;

/** número sin ceros de más */
const fix = (v: number, d: number) => String(Number(v.toFixed(d)));
/** las comas, los dos puntos y los punto y coma se dejan legibles (son válidos en una consulta) */
const enc = (s: string) => encodeURIComponent(s).replace(/%2C/gi, ',').replace(/%3A/gi, ':').replace(/%3B/gi, ';');
const dec = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return ''; } };
const ours = (key: string) => VIEW_KEYS.includes(key) || key.startsWith(PREFIX);

/** Pares clave=valor de una consulta, sin decodificar (para conservar tal cual los del anfitrión). */
function pairs(search: string) {
  return search.replace(/^\?/, '').split('&').filter(Boolean).map(p => {
    const i = p.indexOf('=');
    return { raw: p, key: dec(i < 0 ? p : p.slice(0, i)), value: i < 0 ? '' : dec(p.slice(i + 1)) };
  });
}

/** Consulta (sin «?») con el estado; los valores por omisión del visor no se escriben. */
export function encodeViewState(s: ViewState): string {
  const out: string[] = [];
  const put = (k: string, v: string) => out.push(`${enc(k)}=${enc(v)}`);
  if (s.view) {
    const v = s.view, km = v.dist * KM_PER_UNIT;
    put('vista', [fix(v.lon, 5), fix(v.lat, 5), fix(km, km < 10 ? 2 : 1), fix(v.polar, 1), fix(v.az, 1)].join(','));
  }
  if (s.baseMap && s.baseMap !== 'usodesuelo') put('mapa', s.baseMap);
  if (s.hour !== undefined) put('hora', fix(s.hour, 2));
  if (s.exaggeration !== undefined && Math.abs(s.exaggeration - 2.5) > 0.01) put('exag', fix(s.exaggeration, 1));
  if (s.clouds && s.clouds !== 'auto') put('nubes', s.clouds);
  if (s.municipio) put('mun', s.municipio);
  if (s.analysis) {
    put('analisis', s.analysis);
    for (const [k, v] of Object.entries(s.params ?? {})) put(PREFIX + k, v);
  }
  return out.join('&');
}

/** Estado desde una consulta («?vista=…&mapa=…»); lo que no se entiende se ignora. */
export function decodeViewState(search: string): ViewState {
  const s: ViewState = {}, params: Record<string, string> = {};
  for (const { key, value } of pairs(search)) {
    if (key.startsWith(PREFIX) && key.length > PREFIX.length && value.length <= 4000) { params[key.slice(PREFIX.length)] = value; continue; }
    const n = Number(value);
    switch (key) {
      case 'vista': {
        const [lon, lat, km, polar, az] = value.split(',').map(Number);
        if ([lon, lat, km, polar, az].every(Number.isFinite) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90 && km > 0) {
          s.view = { lon, lat, dist: km / KM_PER_UNIT, polar: Math.min(90, Math.max(0, polar)), az };
        }
        break;
      }
      case 'mapa': if (BASES.includes(value as BaseMapId)) s.baseMap = value as BaseMapId; break;
      case 'hora': if (value && n >= 0 && n <= 24) s.hour = n; break;
      case 'exag': if (value && n >= 1 && n <= 6) s.exaggeration = n; break;
      case 'nubes': if (CLOUDS.includes(value)) s.clouds = value as CloudKind | 'no'; break;
      case 'mun': {
        // «13048», «048» o «48»
        const m = /^(?:13)?(\d{1,3})$/.exec(value), id = m ? Number(m[1]) : 0;
        if (id >= 1 && id <= 84) s.municipio = '13' + String(id).padStart(3, '0');
        break;
      }
      case 'analisis': if (/^[a-z0-9-]{1,40}$/.test(value)) s.analysis = value; break;
    }
  }
  if (s.analysis && Object.keys(params).length) s.params = params;
  return s;
}

/**
 * Dirección para compartir: la página actual (href) con el estado en la consulta. Los parámetros del anfitrión se
 * conservan tal cual y los del visor se reemplazan.
 */
export function viewStateUrl(href: string, s: ViewState): string {
  const hash = href.indexOf('#'), base = hash < 0 ? href : href.slice(0, hash), frag = hash < 0 ? '' : href.slice(hash);
  const qi = base.indexOf('?'), path = qi < 0 ? base : base.slice(0, qi);
  const keep = pairs(qi < 0 ? '' : base.slice(qi)).filter(p => !ours(p.key)).map(p => p.raw);
  const q = [...keep, encodeViewState(s)].filter(Boolean).join('&');
  return path + (q ? '?' + q : '') + frag;
}

/** Punto o lista de puntos «lon,lat;lon,lat» (5 decimales ≈ 1 m) para los parámetros de los análisis. */
export const fmtPoints = (pts: [number, number][]) => pts.map(([lon, lat]) => `${fix(lon, 5)},${fix(lat, 5)}`).join(';');
export function parsePoints(s: string, max = 50): [number, number][] | undefined {
  const pts = s.split(';').slice(0, max).map(p => p.split(',').map(Number) as [number, number]);
  return pts.length && pts.every(p => p.length === 2 && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90 && p.every(Number.isFinite)) ? pts : undefined;
}
