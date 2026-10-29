import { BASE_KM, type Geo } from '../shared/geo';
import type { FineGrid } from '../shared/types';

export interface Hit { lat: number; lon: number; e: number; m: number }

/** Teselas de 30 m cargadas (las mismas del atlas de la GPU): RG16 por nodo, altura en cuartos de metro. */
export interface Tiles30 { nx: number; ny: number; cells: number; f: number; px: number; data: Map<number, Uint16Array> }

/**
 * Elevación y municipio por celda, con muestreo bilineal y lanzamiento de rayos sobre el relieve.
 * elevAt es la rejilla de 270 m; surfaceAt (= elevTrue) la mejor disponible: 30 m donde hay tesela cargada, 90 m si ya
 * llegó, si no 270 m. Es la que se dibuja de cerca: con ella se señala con el cursor, se apoya la cámara y se muestran
 * altitudes. Los municipios se leen de la rejilla de ~50 m.
 */
export class Heightfield {
  private fine: FineGrid<Uint8Array> | null = null;
  private detail: FineGrid<Int16Array> | null = null;
  private tiles: Tiles30 | null = null;

  constructor(
    readonly geo: Geo,
    readonly elev: Float32Array,
    readonly muni: Uint8Array,
    readonly W: number,
    readonly H: number,
  ) {}

  setMuniFine(g: FineGrid<Uint8Array>) { this.fine = g; }
  setDetail(g: FineGrid<Int16Array>) { this.detail = g; }
  setTiles(t: Tiles30 | null) { this.tiles = t; }

  elevAt(fr: number, fc: number) {
    const { W, H, elev } = this;
    fr = Math.max(0, Math.min(H - 1.001, fr));
    fc = Math.max(0, Math.min(W - 1.001, fc));
    const r = Math.floor(fr), c = Math.floor(fc), tr = fr - r, tc = fc - c, i = r * W + c;
    return (elev[i] * (1 - tc) + elev[i + 1] * tc) * (1 - tr) + (elev[i + W] * (1 - tc) + elev[i + W + 1] * tc) * tr;
  }

  /** Elevación en m a la mejor resolución disponible (30 → 90 → 270 m). */
  surfaceAt(fr: number, fc: number) {
    const t = this.tiles;
    if (t) {
      const T = t.cells * t.f, px = fc * t.f, py = fr * t.f, tx = Math.floor(px / T), ty = Math.floor(py / T);
      const q = tx >= 0 && ty >= 0 && tx < t.nx && ty < t.ny ? t.data.get(ty * t.nx + tx) : undefined;
      if (q) {
        const P = t.px, x = Math.min(P - 1.001, px - tx * T), y = Math.min(P - 1.001, py - ty * T);
        const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = (y0 * P + x0) * 2, j = i + P * 2;
        const a = q[i], b = q[i + 2], c = q[j], d = q[j + 2];
        if (a && b && c && d) return ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy) * 0.25;
      }
    }
    const d = this.detail;
    if (!d) return this.elevAt(fr, fc);
    const y = Math.max(0, Math.min(d.h - 1.001, fr * d.f)), x = Math.max(0, Math.min(d.w - 1.001, fc * d.f));
    const r = Math.floor(y), c = Math.floor(x), ty = y - r, tx = x - c, i = r * d.w + c, e = d.data;
    if (!e[i] || !e[i + 1] || !e[i + d.w] || !e[i + d.w + 1]) return this.elevAt(fr, fc);
    return (e[i] * (1 - tx) + e[i + 1] * tx) * (1 - ty) + (e[i + d.w] * (1 - tx) + e[i + d.w + 1] * tx) * ty;
  }
  /** Igual que surfaceAt (nombre anterior). */
  elevTrue(fr: number, fc: number) { return this.surfaceAt(fr, fc); }

  muniAt(fr: number, fc: number) {
    const g = this.fine;
    if (g) {
      const r = Math.round(fr * g.f), c = Math.round(fc * g.f);
      return r < 0 || c < 0 || r >= g.h || c >= g.w ? 0 : g.data[r * g.w + c];
    }
    const r = Math.round(fr), c = Math.round(fc);
    return r < 0 || c < 0 || r >= this.H || c >= this.W ? 0 : this.muni[r * this.W + c];
  }

  elevLL(lat: number, lon: number) { return this.elevAt(this.geo.rowOf(lat), this.geo.colOf(lon)); }
  surfaceLL(lat: number, lon: number) { return this.surfaceAt(this.geo.rowOf(lat), this.geo.colOf(lon)); }
  elevTrueLL(lat: number, lon: number) { return this.surfaceLL(lat, lon); }
  muniLL(lat: number, lon: number) { return this.muniAt(this.geo.rowOf(lat), this.geo.colOf(lon)); }

  /**
   * Marcha un rayo (en coordenadas locales: km, y = altitud en km) hasta tocar el relieve (la mejor superficie).
   * Con allowOutside también toca el terreno fuera de Hidalgo (para acercarse con la rueda).
   */
  pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, allowOutside = false): Hit | null {
    const g = this.geo;
    let t0 = 0, t1 = 1e6;
    for (const [o, d, lo, hi] of [[ox, dx, g.xMin, g.xMax], [oy, dy, BASE_KM, 4], [oz, dz, g.zMin, g.zMax]]) {
      if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return null; continue; }
      let a = (lo - o) / d, b = (hi - o) / d;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    }
    if (t0 > t1) return null;
    const horiz = Math.hypot(dx, dz) || 1e-6;
    // pasos de 60 m en horizontal (el relieve fino tiene crestas angostas)
    const dt = Math.min(0.06 / horiz, (t1 - t0) / 60);
    const hAt = (x: number, z: number) => {
      const r = g.rowOf(g.latOfZ(z)), c = g.colOf(g.lonOfX(x));
      return allowOutside || this.muniAt(r, c) ? this.surfaceAt(r, c) / 1000 : BASE_KM - 1;
    };
    let prevT = t0;
    for (let t = t0; ; t += dt) {
      const tt = Math.min(t, t1);
      const y = oy + dy * tt, h = hAt(ox + dx * tt, oz + dz * tt);
      if (y <= h) {
        if (tt === t0 && h > BASE_KM - 0.5 && !allowOutside) return null;   // pegó en la pared del zócalo
        let a = prevT, b = tt;
        for (let k = 0; k < 14; k++) {
          const m = (a + b) / 2;
          if (oy + dy * m > hAt(ox + dx * m, oz + dz * m)) a = m; else b = m;
        }
        const lat = g.latOfZ(oz + dz * b), lon = g.lonOfX(ox + dx * b);
        const r = g.rowOf(lat), c = g.colOf(lon);
        return { lat, lon, e: this.surfaceAt(r, c), m: this.muniAt(r, c) };
      }
      prevT = tt;
      if (tt >= t1) return null;
    }
  }
}
