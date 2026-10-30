import type { ComponentType } from 'react';
import type { Layers } from '../engine/Engine';
import type { MapApi } from '../engine/mapApi';
import type { BaseMapId } from '../shared/basemaps';
import type { CloudSettings } from '../shared/clouds';
import type { Meta } from '../shared/types';
import type { Datasets } from './datasets';

/** Lo del panel «Capas y luz»: mapa base, hora del Sol, exageración vertical, capas y nubes. */
export interface SceneSettings {
  baseMap: BaseMapId;
  /** hora local de México (5–20.5) */
  hour: number;
  exaggeration: number;
  layers: Layers;
  clouds: CloudSettings;
}

export interface SceneChange {
  baseMap?: BaseMapId;
  hour?: number;
  exaggeration?: number;
  layers?: Partial<Layers>;
  clouds?: Partial<CloudSettings>;
}

/** Ajustes de la escena para un análisis: el panel los sigue mostrando y al cerrar el análisis vuelve lo que había. */
export interface SceneApi {
  get(): SceneSettings;
  set(change: SceneChange): void;
}

/** normal · kiosco (módulo de feria: solo el recorrido, en bucle) · escuelas (interfaz simplificada) */
export type ViewerMode = 'normal' | 'kiosco' | 'escuelas';

/**
 * Estado del análisis que viaja en los enlaces a vistas (claves cortas → texto, en la URL como «a.clave»): el que
 * traía el enlace al abrir y cómo avisar cambios. Con useLinked (ui.tsx) basta una línea por cada dato.
 */
export interface AnalysisLink {
  readonly initial: Readonly<Record<string, string>>;
  /** null = valor por omisión (no se escribe en el enlace) */
  set(key: string, value: string | null): void;
}

/** Todo lo que recibe un análisis. El mapa viene con ámbito: al cerrarse el análisis, se limpia solo. */
export interface AnalysisContext {
  map: MapApi;
  data: Datasets;
  meta: Meta;
  /** pantalla chica: menos detalle y paneles más compactos */
  small: boolean;
  link: AnalysisLink;
  /** mapa base, hora, exageración, capas y nubes (como el panel «Capas y luz») */
  scene: SceneApi;
  mode: ViewerMode;
}

export interface AnalysisProps { ctx: AnalysisContext }

export type AnalysisGroup = 'Población' | 'Desigualdad' | 'Servicios' | 'Agua y riesgo' | 'Planeación' | 'Difusión' | 'Plataforma';

export interface AnalysisDef {
  id: string;
  titulo: string;
  grupo: AnalysisGroup;
  resumen: string;
  /** fuentes que se citan en el panel */
  fuentes?: string[];
  /** carga diferida del componente; sin load = «próximamente» */
  load?: () => Promise<{ default: ComponentType<AnalysisProps> }>;
}
