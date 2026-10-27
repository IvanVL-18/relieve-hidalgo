import type { Meta } from '../shared/types';

export type SearchKind = 'Municipio' | 'Ciudad' | 'Pueblo' | 'Localidad' | 'Río' | 'Cuerpo de agua';

export interface SearchItem {
  n: string;
  kind: SearchKind;
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
