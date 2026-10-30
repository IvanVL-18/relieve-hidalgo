import type { BaseMapId } from '../shared/basemaps';
import type { Meta } from '../shared/types';
import type { ArcsHandle, ArcsSpec, LinesHandle, LinesSpec, PointsHandle, PointsSpec } from './overlays';
import type { RasterHandle, RasterSpec } from './rasters';

export type { ArcsHandle, ArcsSpec, LinesHandle, LinesSpec, PointsHandle, PointsSpec, Tooltip } from './overlays';
export type { RasterHandle, RasterSpec } from './rasters';

/** Lo que hay bajo el cursor o el clic. */
export interface MapHit {
  lon: number;
  lat: number;
  /** m s. n. m. */
  elev: number;
  /** municipio 1–84 (0 = fuera de Hidalgo) */
  municipio: number;
  /** punto de una capa de análisis, si el clic cayó sobre uno */
  point?: { layer: PointsHandle; index: number };
}

/** Imagen RGBA (sRGB) alineada a la rejilla del relieve: el texel (0, 0) es la celda noroeste. */
export interface GridImage { width: number; height: number; rgba: Uint8Array }

/** Cortina para comparar dos capas o dos mapas base. */
export interface CompareSpec {
  /** mapa base del lado derecho (el izquierdo es el del panel); sin base, la cortina solo separa las capas raster con side */
  base?: BaseMapId;
  /** textos de cada lado, p. ej. ['Serie VI · 2014', 'Serie VII · 2018'] */
  labels?: [string, string];
  /** 0–1 desde la izquierda (0.5 por omisión) */
  position?: number;
}

export interface CompareHandle {
  readonly position: number;
  setPosition(x: number): void;
  setLabels(left: string, right: string): void;
  /** avisa cuando se arrastra la cortina */
  onChange(fn: (x: number) => void): () => void;
  dispose(): void;
}

/**
 * Lo que un análisis puede hacer sobre el mapa. Cada análisis recibe su propia instancia (con ámbito):
 * al cerrarse, todo lo que creó se borra solo. Mantener esta interfaz estable es lo que permite agregar
 * análisis nuevos sin tocar el motor.
 */
export interface MapApi {
  readonly meta: Meta;
  elevationAt(lon: number, lat: number): number;
  municipioAt(lon: number, lat: number): number;
  /** colorea municipios: clave INEGI («13048») o id (1–84) → color CSS */
  setMunicipioFill(colors: Record<string | number, string> | null, strength?: number): void;
  /** capa de colores sobre el terreno, del tamaño de la rejilla (o cualquier tamaño que la cubra) */
  setOverlay(img: GridImage | null, opacity?: number): void;
  /**
   * capa raster con su propia extensión, resolución y paleta (continua, por clases o RGBA), con consulta de valor.
   * Caben 2 a la vez (setOverlay usa una).
   */
  addRaster(spec: RasterSpec): RasterHandle;
  /** cortina deslizable para comparar: un mapa base a la derecha y/o capas raster con side 'left' / 'right' */
  compare(spec?: CompareSpec): CompareHandle;
  addPoints(spec: PointsSpec): PointsHandle;
  addLines(spec: LinesSpec): LinesHandle;
  /** arcos 3D entre pares de puntos (flujos de origen a destino), con grosor en px y color por arco */
  addArcs(spec: ArcsSpec): ArcsHandle;
  /** vuela a un punto; viewKm = ancho aproximado de lo que se verá */
  flyTo(lon: number, lat: number, viewKm?: number): void;
  select(municipio: number, fly?: boolean): void;
  /** resalta un municipio sin seleccionarlo (0 = ninguno), p. ej. al pasar sobre una gráfica */
  highlight(municipio: number): void;
  /** municipio por celda (W × H, 0 = fuera); solo lectura */
  municipioGrid(): Uint8Array;
  setPin(label: string | null, lon?: number, lat?: number): void;
  /** clic en el mapa; devolver true evita la acción normal (seleccionar municipio) */
  onClick(fn: (hit: MapHit) => boolean | void): () => void;
  /** renglones extra para la ficha del cursor */
  onHover(fn: (hit: MapHit) => string[] | null): () => void;
  /** borra todo lo que creó este análisis */
  dispose(): void;
}
