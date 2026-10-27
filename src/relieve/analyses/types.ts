import type { ComponentType } from 'react';
import type { MapApi } from '../engine/mapApi';
import type { Meta } from '../shared/types';
import type { Datasets } from './datasets';

/** Todo lo que recibe un análisis. El mapa viene con ámbito: al cerrarse el análisis, se limpia solo. */
export interface AnalysisContext {
  map: MapApi;
  data: Datasets;
  meta: Meta;
  /** pantalla chica: menos detalle y paneles más compactos */
  small: boolean;
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
