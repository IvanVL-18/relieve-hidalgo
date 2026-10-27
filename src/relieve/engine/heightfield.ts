import { BASE_KM, type Geo } from '../shared/geo';

export interface Hit { lat: number; lon: number; e: number; m: number }

/** Elevación y municipio por celda, con muestreo bilineal y lanzamiento de rayos sobre el relieve. */
export class Heightfield {
  constructor(
    readonly geo: Geo,
    readonly elev: Float32Array,
    readonly muni: Uint8Array,
    readonly W: number,
    readonly H: number,
  ) {}

  elevAt(fr: number, fc: number) {
    const { W, H, elev } = this;
    fr = Math.max(0, Math.min(H - 1.001, fr));
    fc = Math.max(0, Math.min(W - 1.001, fc));
    const r = Math.floor(fr), c = Math.floor(fc), tr = fr - r, tc = fc - c, i = r * W + c;
    return (elev[i] * (1 - tc) + elev[i + 1] * tc) * (1 - tr) + (elev[i + W] * (1 - tc) + elev[i + W + 1] * tc) * tr;
  }

  muniAt(fr: number, fc: number) {
    const r = Math.round(fr), c = Math.round(fc);
    return r < 0 || c < 0 || r >= this.H || c >= this.W ? 0 : this.muni[r * this.W + c];
  }

  elevLL(lat: number, lon: number) { return this.elevAt(this.geo.rowOf(lat), this.geo.colOf(lon)); }
  muniLL(lat: number, lon: number) { return this.muniAt(this.geo.rowOf(lat), this.geo.colOf(lon)); }

  /**
   * Marcha un rayo (en coordenadas locales: km, y = altitud en km) hasta tocar el relieve.
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
    const dt = Math.min(0.12 / horiz, (t1 - t0) / 60);
    const hAt = (x: number, z: number) => {
      const r = g.rowOf(g.latOfZ(z)), c = g.colOf(g.lonOfX(x));
      return allowOutside || this.muniAt(r, c) ? this.elevAt(r, c) / 1000 : BASE_KM - 1;
    };
    let prevT = t0;
    for (let t = t0; ; t += dt) {
      const tt = Math.min(t, t1);
      const y = oy + dy * tt, h = hAt(ox + dx * tt, oz + dz * tt);
      if (y <= h) {
        if (tt === t0 && h > BASE_KM - 0.5 && !allowOutside) return null;   // pegó en la pared del zócalo
        let a = prevT, b = tt;
        for (let k = 0; k < 12; k++) {
          const m = (a + b) / 2;
          if (oy + dy * m > hAt(ox + dx * m, oz + dz * m)) a = m; else b = m;
        }
        const lat = g.latOfZ(oz + dz * b), lon = g.lonOfX(ox + dx * b);
        const r = g.rowOf(lat), c = g.colOf(lon);
        return { lat, lon, e: this.elevAt(r, c), m: this.muniAt(r, c) };
      }
      prevT = tt;
      if (tt >= t1) return null;
    }
  }
}
