/** Tipos de servicio para accesibilidad. Lo usan el visor y scripts/pipeline/build-servicios.mjs. */
export interface ServiceType { id: string; nombre: string; plural: string; fuente: 'CLUES' | 'DENUE'; aviso?: string }

const ESCUELAS = 'El DENUE registra sobre todo escuelas en localidades urbanas: en zonas rurales faltan planteles y los tiempos salen mayores a los reales.';

export const SERVICE_TYPES: ServiceType[] = [
  { id: 'hospital', nombre: 'Hospital', plural: 'Hospitales', fuente: 'CLUES' },
  { id: 'salud', nombre: 'Unidad de salud de primer nivel', plural: 'Centros de salud', fuente: 'CLUES' },
  { id: 'preescolar', nombre: 'Preescolar', plural: 'Preescolares', fuente: 'DENUE', aviso: ESCUELAS },
  { id: 'primaria', nombre: 'Primaria', plural: 'Primarias', fuente: 'DENUE', aviso: ESCUELAS },
  { id: 'secundaria', nombre: 'Secundaria', plural: 'Secundarias', fuente: 'DENUE', aviso: ESCUELAS },
  { id: 'media', nombre: 'Bachillerato', plural: 'Bachilleratos', fuente: 'DENUE', aviso: ESCUELAS },
  { id: 'superior', nombre: 'Universidad o tecnológico', plural: 'Universidades', fuente: 'DENUE', aviso: ESCUELAS },
];

/** Tipo de escuela según el código SCIAN del DENUE (−1 si no aplica). Público si el código termina en 2. */
export function schoolTypeOf(scian: string): number {
  const id = /^61111/.test(scian) ? 'preescolar'
    : /^61112/.test(scian) ? 'primaria'
    : /^6111[34]/.test(scian) ? 'secundaria'
    : /^6111[56]/.test(scian) ? 'media'
    : /^611(2|3)/.test(scian) ? 'superior'
    : '';
  return id ? SERVICE_TYPES.findIndex(t => t.id === id) : -1;
}
