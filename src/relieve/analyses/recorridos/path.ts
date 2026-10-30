/**
 * Trayectorias de los recorridos guiados: vuelos entre paradas (vistas como las de los enlaces) que no atraviesan el
 * relieve y dejan ver el punto de llegada, estancias con un giro lento y la línea de tiempo del recorrido. Sin DOM: lo
 * usan el análisis, el video y las pruebas.
 *
 * Espacio de las cuentas: km con la altura exagerada (como se dibuja). La cámara está en el objetivo + esféricas de three
 * (polar desde la vertical, rumbo desde el sur hacia el este), con dist en unidades de escena (1 = 100 km).
 */
import type { View } from '../../shared/enlaces';

export interface PathEnv {
  /** m s. n. m. (NaN o ≤ 0 fuera del relieve) */
  elev(lon: number, lat: number): number;
  /** dentro de Hidalgo: fuera, el motor deja el punto que mira a 1 500 m */
  inside(lon: number, lat: number): boolean;
  /** km por grado de longitud y de latitud */
  kx: number;
  ky: number;
  /** exageración vertical */
  ex: number;
  /** límites de la cámara del motor */
  minDist?: number;
  maxDist?: number;
  maxPolar?: number;
}

export interface Leg { kind: 'fly' | 'hold'; stop: number; t0: number; t1: number; at(s: number): View }

export interface Timeline {
  legs: Leg[];
  /** ms */
  total: number;
  /** vista, parada, fase y avance dentro del tramo (0–1) en el instante t (ms) */
  at(t: number): { view: View; stop: number; phase: 'fly' | 'hold'; p: number };
}

const KM = 100, DEG = Math.PI / 180;
const smoother = (s: number) => { const t = Math.min(1, Math.max(0, s)); return t * t * t * (t * (t * 6 - 15) + 10); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Altura del punto que mira la cámara (km exagerados). */
const targetY = (env: PathEnv, lon: number, lat: number) => ((env.inside(lon, lat) ? Math.max(0, env.elev(lon, lat) || 0) : 1500) / 1000) * env.ex;
/** Altura del relieve (km exagerados). */
const groundY = (env: PathEnv, lon: number, lat: number) => { const e = env.elev(lon, lat); return ((e > 0 ? e : 0) / 1000) * env.ex; };

/**
 * La cámara de la vista queda al menos 0.5 km (reales) sobre el relieve y la recta hasta el objetivo no choca con él (se
 * revisa hasta el 90 % del camino: junto al objetivo la ladera misma lo taparía).
 */
export function isClear(env: PathEnv, v: View): boolean {
  const ty = targetY(env, v.lon, v.lat), D = v.dist * KM, ph = v.polar * DEG, th = v.az * DEG;
  const dx = D * Math.sin(ph) * Math.sin(th), dy = D * Math.cos(ph), dz = D * Math.sin(ph) * Math.cos(th);
  for (let k = 0; k <= 18; k++) {
    const u = (k / 18) * 0.9, px = dx * (1 - u), py = ty + dy * (1 - u), pz = dz * (1 - u);
    const g = groundY(env, v.lon + px / env.kx, v.lat - pz / env.ky);
    if (py < g + (k === 0 ? 0.5 * env.ex : 0.04 * env.ex)) return false;
  }
  return true;
}

/** La misma vista vista más desde arriba (de 3 en 3°) hasta que la cámara vea su objetivo. */
export function fitView(env: PathEnv, v: View): View {
  let p = v.polar;
  while (p > 6 && !isClear(env, { ...v, polar: p })) p -= 3;
  return p === v.polar ? v : { ...v, polar: Math.max(6, p) };
}

const clampView = (env: PathEnv, v: View): View => ({
  ...v,
  dist: Math.min(env.maxDist ?? 6.5, Math.max(env.minDist ?? 0.06, v.dist)),
  polar: Math.min(env.maxPolar ?? 84.6, Math.max(0.1, v.polar)),
});

/** km en planta entre dos puntos. */
export const travelKm = (env: PathEnv, a: View, b: View) => Math.hypot((b.lon - a.lon) * env.kx, (b.lat - a.lat) * env.ky);

/** Duración de un vuelo (ms): más largo si va lejos o cambia mucho la distancia de la cámara. */
export function flyMs(env: PathEnv, a: View, b: View) {
  const km = travelKm(env, a, b), zoom = Math.abs(Math.log(b.dist / a.dist));
  return Math.round(1000 * Math.min(13, Math.max(3.5, 3 + 1.9 * Math.sqrt(km / 10) + 1.1 * zoom)));
}

/**
 * Vuelo de a a b (s = 0–1): el objetivo va en línea recta, la distancia en escala logarítmica y sube a media trayectoria
 * en los viajes largos; los ángulos giran por el camino corto. Donde la cámara no vería su objetivo (o entraría al
 * relieve) se inclina más hacia abajo, con un límite suavizado para que el movimiento no dé tirones; en los extremos manda
 * la vista de la parada.
 */
export function flight(env: PathEnv, a: View, b: View): (s: number) => View {
  const km = travelKm(env, a, b), hop = Math.min(1.1, (km / KM) * 0.45), daz = wrap(b.az - a.az);
  const base = (s: number): View => {
    const e = smoother(s);
    return clampView(env, {
      lon: lerp(a.lon, b.lon, e), lat: lerp(a.lat, b.lat, e),
      dist: Math.exp(lerp(Math.log(a.dist), Math.log(b.dist), e)) + hop * Math.sin(Math.PI * e),
      polar: lerp(a.polar, b.polar, e), az: a.az + daz * e,
    });
  };
  // polar permitido en muestras: mínimo en una ventana (para adelantarse al cerro) y luego suavizado; con la ventana del
  // mínimo igual a la del suavizado, el límite nunca pasa del permitido en una muestra
  const N = 64, allow = new Float64Array(N + 1);
  for (let k = 0; k <= N; k++) allow[k] = fitView(env, base(k / N)).polar;
  const ero = Float64Array.from(allow, (_, k) => { let m = Infinity; for (let j = Math.max(0, k - 6); j <= Math.min(N, k + 6); j++) m = Math.min(m, allow[j]); return m; });
  const lim = Float64Array.from(ero, (_, k) => {
    let s = 0, w = 0;
    for (let j = Math.max(0, k - 6); j <= Math.min(N, k + 6); j++) { const q = Math.exp(-(((j - k) / 3) ** 2)); s += ero[j] * q; w += q; }
    return s / w;
  });
  return s => {
    const v = base(s), x = Math.min(N, Math.max(0, s * N)), k = Math.min(N - 1, Math.floor(x)), f = x - k;
    // cerca de los extremos el límite se suelta: ahí la vista es la de la parada
    const free = 1 - 4 * s * (1 - s), l = lerp(lerp(lim[k], lim[k + 1], f), 90, free * free);
    return v.polar > l ? { ...v, polar: l } : v;
  };
}

/** Estancia en una parada: gira despacio y se acerca un poco (si la vista final sigue viendo su objetivo). */
export function stay(env: PathEnv, v: View, drift = 9, push = 0.06): (s: number) => View {
  const end = { ...v, az: v.az + drift, dist: v.dist * (1 - push) };
  const [d, p] = isClear(env, end) ? [drift, push] : [0, 0];
  return s => { const e = smoother(s); return { ...v, az: v.az + d * e, dist: v.dist * (1 - p * e) }; };
}

/** Segundos para leer un texto (≈ 3 palabras por segundo), entre 7 y 18. */
export const readingSeconds = (text: string) => Math.min(18, Math.max(7, 3.5 + text.split(/\s+/).filter(Boolean).length / 3));

/**
 * Línea de tiempo: desde la vista actual, vuelo a cada parada y estancia (hold en s). Las vistas de las paradas se
 * ajustan con fitView por si con otra exageración el relieve tapara el objetivo. cuts: cortes en lugar de vuelos y sin
 * giro en las paradas (para quien pide reducir el movimiento).
 */
export function timeline(env: PathEnv, start: View, stops: { view: View; hold: number }[], opts: { cuts?: boolean } = {}): Timeline {
  const legs: Leg[] = [];
  let t = 0, from = start;
  stops.forEach((st, i) => {
    const to = fitView(env, clampView(env, st.view)), fms = opts.cuts ? 400 : flyMs(env, from, to);
    const fl = opts.cuts ? () => to : flight(env, from, to);
    legs.push({ kind: 'fly', stop: i, t0: t, t1: t + fms, at: fl });
    t += fms;
    const hl = opts.cuts ? () => to : stay(env, to), hms = Math.round(st.hold * 1000);
    legs.push({ kind: 'hold', stop: i, t0: t, t1: t + hms, at: hl });
    t += hms;
    from = hl(1);
  });
  return {
    legs, total: t,
    at(ms) {
      const tt = Math.min(t, Math.max(0, ms));
      let lo = 0, hi = legs.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (legs[m].t1 < tt) lo = m + 1; else hi = m; }
      const L = legs[lo], p = L.t1 > L.t0 ? (tt - L.t0) / (L.t1 - L.t0) : 1;
      return { view: L.at(p), stop: L.stop, phase: L.kind, p };
    },
  };
}
