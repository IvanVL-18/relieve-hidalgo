/** Localidad: [nombre, tipo (0 ciudad, 1 pueblo, 2 localidad), lon, lat, municipio (1–84), población OSM o 0] */
export type Place = [name: string, kind: 0 | 1 | 2, lon: number, lat: number, muni: number, pop: number];

export interface GridMeta {
  /** columnas y filas de la rejilla de elevación */
  W: number;
  H: number;
  /** tamaño de celda en grados */
  step: number;
  /** centro de la celda (0, 0): esquina noroeste */
  lon0: number;
  lat0: number;
}

export interface Meta extends GridMeta {
  version: number;
  names: string[];
  /** clave INEGI de 5 dígitos (13001…13084), en el mismo orden que names */
  codes: string[];
  /** [lon, lat, celdas] del centroide de cada municipio */
  cent: [number, number, number][];
  riverLabels: { n: string; lon: number; lat: number; km: number }[];
  lakeLabels: { n: string; lon: number; lat: number; a: number }[];
  places: Place[];
  sources: Record<string, string>;
}

export interface Quality {
  /** 1 = malla completa, 2 = una de cada dos celdas (pantallas chicas) */
  decimate: 1 | 2;
  /** lado de la textura de agua y límites */
  tex: number;
  /** separación de los puntos del entorno, en celdas */
  dotStep: number;
  mini: { w: number; h: number };
}

export interface BuildRequest {
  urls: { elev: string; muni: string; vec: string };
  grid: GridMeta;
  places: Place[];
  quality: Quality;
}

export interface MuniStats {
  min: Float32Array;
  max: Float32Array;
  mean: Float32Array;
  cells: Uint32Array;
  /** índice de rejilla del punto más alto de cada municipio */
  peak: Uint32Array;
}

export interface BuildResult {
  type: 'done';
  elev: Float32Array;
  muni: Uint8Array;
  minE: number;
  maxE: number;
  maxI: number;
  terrain: {
    position: Float32Array;
    normal: Int16Array;
    /** sRGB del color por altitud + oclusión ambiental en alfa */
    alt: Uint8Array;
    /** brillo nocturno de las localidades (0–255) */
    glow: Uint8Array;
    index: Uint32Array;
  };
  walls: { position: Float32Array; normal: Float32Array; top: Float32Array };
  dots: { position: Float32Array; color: Float32Array };
  /** R = ríos y presas, G = límites municipales */
  water: { size: number; data: Uint8Array };
  mini: ImageBitmap;
  muniStats: MuniStats;
  timings: Record<string, number>;
}

export type WorkerMessage =
  | { type: 'progress'; stage: 'download' | 'build' }
  | { type: 'error'; message: string }
  | BuildResult;
