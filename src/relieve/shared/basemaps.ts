/** Mapas base disponibles (sin dependencias, para la interfaz). La carga está en engine/basemaps.ts. */
export type BaseMapId = 'usodesuelo' | 'satelite' | 'altitud';

export interface BaseMapInfo { id: BaseMapId; label: string; credit: string }

export const BASE_MAPS: BaseMapInfo[] = [
  { id: 'usodesuelo', label: 'Uso de suelo', credit: 'Uso del suelo y vegetación: INEGI, Serie VII, 1:250 000 (vía IDEFOR, CONAFOR)' },
  { id: 'satelite', label: 'Satélite', credit: 'Imagen: Sentinel-2 cloudless 2016 © EOX IT Services GmbH, datos modificados de Copernicus Sentinel 2016 (CC BY 4.0)' },
  { id: 'altitud', label: 'Altitud', credit: '' },
];
