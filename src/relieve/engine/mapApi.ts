import type { Meta } from '../shared/types';
import type { LinesHandle, LinesSpec, PointsHandle, PointsSpec } from './overlays';

export type { LinesHandle, LinesSpec, PointsHandle, PointsSpec, Tooltip } from './overlays';

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
  addPoints(spec: PointsSpec): PointsHandle;
  addLines(spec: LinesSpec): LinesHandle;
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
