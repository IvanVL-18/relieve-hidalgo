import type { BaseMapId } from '../shared/basemaps';
import type { View } from '../shared/enlaces';
import type { Meta } from '../shared/types';
import type { LabelKind } from './labels';
import type { ArcsHandle, ArcsSpec, LinesHandle, LinesSpec, PointsHandle, PointsSpec } from './overlays';
import type { RasterHandle, RasterSpec } from './rasters';

export type { ArcsHandle, ArcsSpec, LinesHandle, LinesSpec, PointsHandle, PointsSpec, Tooltip } from './overlays';
export type { RasterHandle, RasterSpec } from './rasters';
export type { View } from '../shared/enlaces';
export type { LabelKind } from './labels';

/** Cámara guiada por un análisis (recorridos, video). */
export interface CameraPath {
  /** termina el camino (la cámara se queda donde está) */
  stop(): void;
  /** 'end' = fn devolvió null · 'user' = el usuario tomó la cámara · 'stop' = stop(), otro vuelo o se cerró el análisis */
  readonly done: Promise<'end' | 'user' | 'stop'>;
}

export interface CaptureOptions {
  /** tamaño del cuadro en px (si pasa del máximo de la GPU se dibuja en mosaico) */
  width: number;
  height: number;
  /** px de la imagen por px de la interfaz: grosor de líneas y puntos y posición de las etiquetas (por omisión height / 720) */
  scale?: number;
}

/** Un cuadro de la grabación: hay que copiarlo enseguida (drawImage), el lienzo no se conserva. */
export interface CaptureFrame {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  scale: number;
  /** etiquetas que se verían (px de la imagen), de la más importante a la menos */
  labels: { text: string; sub?: string; kind: LabelKind; x: number; y: number }[];
  /** marcador de MapApi.setPin, si se ve */
  pin: { text: string; x: number; y: number } | null;
  /** color del cielo detrás del relieve (el lienzo es transparente donde no hay relieve) */
  glow: string;
}

/**
 * Grabación cuadro por cuadro a tamaño fijo, sin resolución adaptable y con el reloj del motor detenido: cada frame()
 * avanza el reloj dt segundos (vuelos, caminos, fundidos, agua y nubes), espera las teselas de detalle de esa vista y
 * dibuja. Mientras dura, el mapa no responde al ratón y el lienzo muestra la grabación.
 */
export interface CaptureSession {
  frame(dt: number, draw: (f: CaptureFrame) => void, opts?: {
    /** espera máxima por las teselas (ms; 8000 por omisión) */
    maxWaitMs?: number;
    /** termina los fundidos antes de dibujar (fotos) */
    still?: boolean;
  }): Promise<void>;
  /** vuelve el tamaño del lienzo, el bucle de dibujo y la interacción */
  end(): void;
}

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
  /** vista de la cámara (la misma de los enlaces): punto que mira, distancia y ángulos */
  getView(): View;
  /** lleva la cámara a una vista en ms (0 = corte); true al llegar, false si otro vuelo o el usuario la interrumpió */
  setView(view: View, ms?: number): Promise<boolean>;
  /**
   * cámara guiada: en cada cuadro el motor pone la vista fn(ms desde el inicio) hasta que fn devuelve null. Usa el reloj
   * del motor, así un camino también se puede grabar cuadro por cuadro (capture)
   */
  followPath(fn: (ms: number) => View | null): CameraPath;
  /** pide desde ya las teselas de detalle de una vista (antes de volar a ella); se resuelve cuando llegaron */
  prefetch(view: View): Promise<void>;
  /** con true, las nubes se ven con este análisis abierto (por omisión se ocultan para no tapar los datos) */
  showClouds(on: boolean): void;
  /** grabación cuadro por cuadro (video e imágenes grandes); se termina sola al cerrar el análisis */
  capture(opts: CaptureOptions): CaptureSession;
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
