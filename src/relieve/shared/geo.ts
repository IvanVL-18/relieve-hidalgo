import type { GridMeta } from './types';

/**
 * Georreferencia del modelo. El espacio local está en kilómetros:
 * x hacia el este, z hacia el sur, y = altitud en km. El origen es el centro de la rejilla.
 */
export function makeGeo(m: GridMeta) {
  const latC = m.lat0 - ((m.H - 1) * m.step) / 2;
  const lonC = m.lon0 + ((m.W - 1) * m.step) / 2;
  const KX = 111.32 * Math.cos((latC * Math.PI) / 180);
  const KZ = 110.57;
  const toX = (lon: number) => (lon - lonC) * KX;
  const toZ = (lat: number) => (latC - lat) * KZ;
  return {
    latC, lonC, KX, KZ, toX, toZ,
    colOf: (lon: number) => (lon - m.lon0) / m.step,
    rowOf: (lat: number) => (m.lat0 - lat) / m.step,
    lonOfX: (x: number) => lonC + x / KX,
    latOfZ: (z: number) => latC - z / KZ,
    lonOfCol: (c: number) => m.lon0 + c * m.step,
    latOfRow: (r: number) => m.lat0 - r * m.step,
    xMin: toX(m.lon0),
    xMax: toX(m.lon0 + (m.W - 1) * m.step),
    zMin: toZ(m.lat0),
    zMax: toZ(m.lat0 - (m.H - 1) * m.step),
    /** km² de una celda */
    cellKm2: m.step * KX * m.step * KZ,
  };
}

export type Geo = ReturnType<typeof makeGeo>;

/** Profundidad de la base del modelo, en km bajo el nivel del mar. */
export const BASE_KM = -1.4;
