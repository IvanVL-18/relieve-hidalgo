import type { ComponentType } from 'react';
import type { MapApi } from '../engine/mapApi';
import type { Meta } from '../shared/types';
import type { Datasets } from './datasets';

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
