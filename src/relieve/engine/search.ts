import type { Meta } from '../shared/types';

export type SearchKind = 'Municipio' | 'Ciudad' | 'Pueblo' | 'Localidad' | 'Colonia' | 'Río' | 'Cuerpo de agua';

export interface SearchItem {
  n: string;
  kind: SearchKind;
  /** tipo que se muestra en lugar de `kind` (Fraccionamiento, Barrio… en las colonias) */
  tipo?: string;
  /** municipio al que pertenece (para localidades) */
  sub?: string;
  lon: number;
  lat: number;
  /** municipio 1–84 */
  m?: number;
  /** celdas del municipio (para decidir qué tan cerca volar) */
  area?: number;
  rank: number;
  pop?: number;
  f: string;
}

const KIND: SearchKind[] = ['Ciudad', 'Pueblo', 'Localidad'];
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const prettyRiver = (n: string) => (/^r[ií]o\b/i.test(n) ? n.replace(/^rio/i, 'Río') : 'Río ' + n);

export function buildIndex(meta: Meta): SearchItem[] {
  const index: Omit<SearchItem, 'f'>[] = [];
  meta.names.forEach((n, i) => index.push({ n, kind: 'Municipio', lon: meta.cent[i][0], lat: meta.cent[i][1], m: i + 1, area: meta.cent[i][2], rank: 0 }));
  meta.places.forEach(([n, kind, lon, lat, m, pop]) => index.push({ n, kind: KIND[kind], sub: meta.names[m - 1], lon, lat, m, rank: kind + 1, pop }));
  meta.riverLabels.forEach(r => index.push({ n: prettyRiver(r.n), kind: 'Río', lon: r.lon, lat: r.lat, rank: 2 }));
  meta.lakeLabels.forEach(l => index.push({ n: l.n, kind: 'Cuerpo de agua', lon: l.lon, lat: l.lat, rank: 2 }));
  return index.map(x => ({ ...x, f: fold(x.n) }));
}

/** Localidades en columnas, como las de capas/localidades.bin (ITER 2020). */
export interface PlaceColumns {
  n: number;
  lon: ArrayLike<number>; lat: ArrayLike<number>;
  muni: ArrayLike<number>;
  pob: ArrayLike<number>;
  nombre: string[];
}

/** Lugares de capas/lugares.bin: localidades del catálogo de INEGI fuera del ITER y colonias del DENUE. */
export interface ExtraPlaces {
  n: number;
  lon: ArrayLike<number>; lat: ArrayLike<number>;
  muni: ArrayLike<number>;
  tipo: ArrayLike<number>;
  sub: ArrayLike<number>;
  negocios: ArrayLike<number>;
  nombre: string[]; tipos: string[]; localidades: string[];
}

/** «Benito Juárez [Colonia]» → nombre «Benito Juárez» y tipo «Colonia» (así califica el ITER algunas localidades). */
function qualified(name: string): { n: string; tipo?: string } {
  const q = /^(.*\S)\s*\[([^\]]+)\]$/.exec(name);
  return q ? { n: q[1], tipo: q[2] } : { n: name };
}

/**
 * Lugares que llegan después del arranque: las localidades del ITER que no están en meta.places (solo trae las de
 * ≥ 500 hab. y las cabeceras, sin el calificativo entre corchetes) y las de lugares.bin. Una localidad del ITER ya
 * indexada (mismo nombre, municipio y población, a menos de ~1 km) no se repite; hay nombres repetidos dentro de un
 * municipio, incluso a pocas cuadras («X» y «X [Colonia]»).
 */
export function extraIndex(index: SearchItem[], meta: Meta, loc: PlaceColumns, lug: ExtraPlaces | null): SearchItem[] {
  const known = new Map<string, number[][]>();
  for (const x of index) {
    if (x.kind !== 'Ciudad' && x.kind !== 'Pueblo' && x.kind !== 'Localidad') continue;
    const k = `${x.m}|${x.f}`;
    (known.get(k) ?? known.set(k, []).get(k)!).push([x.lon, x.lat, x.pop ?? -1]);
  }
  const out: SearchItem[] = [];
  for (let i = 0; i < loc.n; i++) {
    const q = qualified(loc.nombre[i]), f = fold(q.n), m = loc.muni[i], lon = loc.lon[i], lat = loc.lat[i];
    if (known.get(`${m}|${f}`)?.some(([a, b, p]) => p === loc.pob[i] && Math.abs(a - lon) + Math.abs(b - lat) < 0.01)) continue;
    out.push({ ...q, kind: 'Localidad', sub: meta.names[m - 1], lon, lat, m, rank: 3, pop: loc.pob[i], f });
  }
  for (let i = 0; lug && i < lug.n; i++) {
    const m = lug.muni[i], t = lug.tipo[i], s = lug.sub[i];
    const sub = s ? `${lug.localidades[s]}, ${meta.names[m - 1]}` : meta.names[m - 1];
    const where = { sub, lon: lug.lon[i], lat: lug.lat[i], m };
    if (t) out.push({ n: lug.nombre[i], ...where, kind: 'Colonia', tipo: lug.tipos[t], rank: 4, f: fold(lug.nombre[i]) });
    else { const q = qualified(lug.nombre[i]); out.push({ ...q, ...where, kind: 'Localidad', rank: 3, f: fold(q.n) }); }
  }
  return out;
}

/** Coincidencias por subcadena; primero las que empiezan igual, luego inicio de palabra, luego el resto. */
export function search(index: SearchItem[], query: string, limit = 8): SearchItem[] {
  const q = fold(query.trim());
  if (!q) return [];
  return index
    .map(x => {
      const i = x.f.indexOf(q);
      if (i < 0) return null;
      const wordStart = i === 0 || x.f[i - 1] === ' ';
      return { x, s: (i === 0 ? 0 : wordStart ? 1 : 3) * 10 + x.rank - Math.min(1, (x.pop || 0) / 1e5) };
    })
    .filter((r): r is { x: SearchItem; s: number } => r !== null)
    .sort((a, b) => a.s - b.s || a.x.n.length - b.x.n.length)
    .slice(0, limit)
    .map(r => r.x);
}
