/** Localidad para etiquetas: [nombre, tipo (0 ciudad, 1 pueblo, 2 localidad), lon, lat, municipio (1–84), población 2020] */
export type Place = [name: string, kind: 0 | 1 | 2, lon: number, lat: number, muni: number, pop: number];

/** Datos de un municipio: [alt. mínima, máxima y media (m, medidas a 30 m), área del polígono INEGI (km²), localidades, población 2020] */
export type MunRow = [min: number, max: number, mean: number, areaKm2: number, localidades: number, pob: number];

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
  /** por municipio (índice = id − 1) */
  mun: MunRow[];
  /** extremos del estado medidos a 30 m; peak = [lon, lat, m] */
  relief: { min: number; max: number; peak: [number, number, number] };
  riverLabels: { n: string; lon: number; lat: number; km: number }[];
  lakeLabels: { n: string; lon: number; lat: number; a: number }[];
  places: Place[];
  sources: Record<string, string>;
}

export interface Quality {
  /** lado de la textura de líneas (ríos, presas y límites) */
  tex: number;
  /** separación de los puntos del entorno, en celdas */
  dotStep: number;
  mini: { w: number; h: number };
}

export interface BuildRequest {
  urls: { elev: string; muni: string; muniFine: string; vec: string };
  grid: GridMeta;
  quality: Quality;
}

/** Rejilla de municipios más fina que la del visor: el nodo (r·f, c·f) es el nodo (r, c) de la rejilla. */
export interface FineGrid<T> { w: number; h: number; f: number; data: T }

export interface BuildResult {
  type: 'done';
  /** elevación de 270 m (m), nodo por nodo de la rejilla */
  elev: Float32Array;
  muni: Uint8Array;
  /** municipio a ≈ 50 m, para la selección y las coropletas */
  muniFine: FineGrid<Uint8Array>;
  /** RG8 sobre la rejilla de muniFine: municipio y distancia con signo al contorno del estado (128 = orilla, > 128 fuera) */
  muniTex: Uint8Array;
  /** RGBA8 por nodo: oclusión, brillo nocturno y normal (x, z) del relieve de 270 m */
  fields: Uint8Array;
  /** paredes del zócalo: x (km), 1 arriba / 0 abajo, z (km); la altura la pone el sombreador */
  walls: { position: Float32Array; normal: Float32Array };
  dots: { position: Float32Array; color: Float32Array };
  /** luces de las localidades de noche: posición local (km; la altura la pone el sombreador) y tamaño en px */
  lights: { position: Float32Array; size: Float32Array };
  mini: ImageBitmap;
  timings: Record<string, number>;
}

/**
 * Líneas del relieve como campos de distancia (texeles, RGBA): R distancia al río más cercano, G al límite
 * municipal más cercano, B a la orilla de presas y lagos con signo (128 = orilla, menos = dentro) y A tamaño del
 * río más cercano. Dan líneas nítidas a cualquier acercamiento.
 */
export interface LinesResult { type: 'lines'; size: number; range: number; data: Uint8Array; ms: number }

/** Relieve de 90 m: normales (x, z) en media precisión y elevación en metros (0 = sin dato). */
export interface DetailResult { type: 'detail'; w: number; h: number; f: number; normal: Uint16Array; elev: Float32Array; ms: number }

export type WorkerMessage =
  | { type: 'progress'; stage: 'download' | 'build' }
  | { type: 'error'; message: string }
  /** algo opcional falló (p. ej. las líneas): el visor sigue sin eso */
  | { type: 'warning'; message: string }
  | BuildResult
  | LinesResult;

/** Paquete de teselas abierto por el worker de relieve (ver worker/pack.ts). */
export interface TilePackInfo { kind: number; tileCells: number; nx: number; ny: number; px: number; f: number; has: Uint8Array }

export type TerrainOp = 'elevation' | 'profile' | 'grid' | 'watershed' | 'flowpath' | 'flood' | 'viewshed';

/** Mensajes al worker de relieve (worker/terrain.worker.ts). */
export type TerrainRequest =
  | { type: 'init'; urls: { detail: string; flow: string; dem: string; sat: string }; grid: GridMeta; detail: boolean; tiles: boolean }
  | { type: 'tile'; id: number; layer: 'dem' | 'sat'; index: number }
  | { type: 'query'; id: number; op: TerrainOp; args: Record<string, unknown> };

/** Respuestas del worker de relieve. */
export type TerrainMessage =
  | DetailResult
  | { type: 'packs'; dem: TilePackInfo | null; sat: TilePackInfo | null }
  /** relieve de 30 m: RG16 por nodo (altura en cuartos de metro, 0 = sin dato; normal x, z en 8 + 8 bits) */
  | { type: 'tile'; id: number; layer: 'dem'; data: Uint16Array | null }
  | { type: 'tile'; id: number; layer: 'sat'; bitmap: ImageBitmap | null }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'error'; id: number | null; message: string };
