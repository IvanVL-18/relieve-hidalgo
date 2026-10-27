/**
 * Grupos de uso del suelo y vegetación (INEGI, Serie VII) para el mapa base y su leyenda.
 * Lo usan el visor y scripts/pipeline/build-usv.mjs (Node importa este .ts directamente: solo sintaxis borrable).
 */
export interface UsvGroup { id: string; nombre: string; color: string }

export const USV_GROUPS: UsvGroup[] = [
  { id: 'temporal', nombre: 'Agricultura de temporal', color: '#d9c98e' },
  { id: 'riego', nombre: 'Agricultura de riego', color: '#a9c46a' },
  { id: 'pastizal', nombre: 'Pastizal', color: '#c2c27c' },
  { id: 'matorral', nombre: 'Matorral xerófilo', color: '#b99d72' },
  { id: 'conifera', nombre: 'Bosque de pino y oyamel', color: '#2c5a35' },
  { id: 'encino', nombre: 'Bosque de encino', color: '#4b7438' },
  { id: 'mesofilo', nombre: 'Bosque mesófilo de montaña', color: '#1f6150' },
  { id: 'selva', nombre: 'Selva', color: '#3d8a3c' },
  { id: 'otra', nombre: 'Otra vegetación', color: '#7aa77c' },
  { id: 'urbano', nombre: 'Asentamientos humanos', color: '#b58b86' },
  { id: 'agua', nombre: 'Cuerpos de agua', color: '#4c86a8' },
  { id: 'sinveg', nombre: 'Sin vegetación aparente', color: '#d8d0c2' },
];

/**
 * Grupo de una clave INEGI. La vegetación secundaria («VSA/BQ», «VSa/SBC»…) toma el grupo de su vegetación
 * original y se marca como secundaria para aclararla en el mapa.
 */
export function usvGroupOf(clave: string): { group: number; secondary: boolean } {
  const secondary = /^VS[AaH]?\//i.test(clave);
  const k = (secondary ? clave.split('/')[1] : clave).toUpperCase();
  const id =
    k === 'H2O' ? 'agua'
    : k === 'AH' || k === 'ZU' ? 'urbano'
    : k === 'ADV' || k === 'DV' ? 'sinveg'
    : /^(R|HA)/.test(k) && k.length <= 4 ? 'riego'
    : /^T[APS]/.test(k) ? 'temporal'
    : /^P[CINHY]/.test(k) ? 'pastizal'
    : /^M/.test(k) ? 'matorral'
    : k === 'BM' ? 'mesofilo'
    : /^BQ/.test(k) ? 'encino'
    : /^B[APJSBC]/.test(k) ? 'conifera'
    : /^S/.test(k) ? 'selva'
    : 'otra';
  return { group: USV_GROUPS.findIndex(g => g.id === id), secondary };
}
