import type { AnalysisDef, AnalysisGroup } from './types';

/**
 * Catálogo de análisis del menú. Para agregar uno: crear analyses/<id>/<Nombre>.tsx con un componente que
 * reciba { ctx } y use ctx.map (se limpia solo al cerrar), y añadir aquí su entrada con `load`.
 * Las entradas sin `load` aparecen como «Próximamente».
 */
export const ANALYSES: AnalysisDef[] = [
  {
    id: 'poblacion', titulo: 'Población', grupo: 'Población',
    resumen: 'Habitantes por municipio y por localidad, con columnas 3D proporcionales a la población.',
    fuentes: ['INEGI, Censo de Población y Vivienda 2020 (ITER)'],
    load: () => import('./poblacion/Poblacion'),
  },
  {
    id: 'localidades', titulo: 'Localidades', grupo: 'Población',
    resumen: 'Las 4 690 localidades del censo: filtra por tamaño y encuentra las más aisladas.',
    fuentes: ['INEGI, ITER 2020', 'CONAPO, Índice de marginación por localidad 2020', 'Tiempos: red vial de OpenStreetMap'],
    load: () => import('./localidades/Localidades'),
  },
  {
    id: 'marginacion', titulo: 'Relieve y marginación', grupo: 'Desigualdad',
    resumen: '¿El rezago se concentra donde el terreno es más abrupto? Mapa bivariado y dispersión por municipio.',
    fuentes: ['CONAPO, Índice de marginación por municipio 2020', 'Pendiente: relieve de INEGI medido a 30 m (Terrain Tiles)'],
    load: () => import('./marginacion/Marginacion'),
  },
  {
    id: 'accesibilidad', titulo: 'Accesibilidad', grupo: 'Servicios',
    resumen: 'Carreteras y tiempo de traslado al hospital, centro de salud o escuela más cercano. Rutas como en un navegador.',
    fuentes: ['Red vial: © colaboradores de OpenStreetMap (ODbL)', 'Salud: Secretaría de Salud, CLUES 2026', 'Escuelas: INEGI, DENUE'],
    load: () => import('./accesibilidad/Accesibilidad'),
  },
  {
    id: 'cuencas', titulo: 'Cuencas: ¿de dónde viene el agua?', grupo: 'Agua y riesgo',
    resumen: 'Clic en un punto y se ilumina toda su cuenca río arriba, con su cauce principal y el camino del agua río abajo.',
    fuentes: ['Relieve: INEGI, Continental relief 2016 (dirección del flujo a 90 m; pendiente a 30 m)', 'Ríos y presas: © colaboradores de OpenStreetMap (ODbL)', 'Población: INEGI, Censo 2020 (ITER)'],
    load: () => import('./cuencas/Cuencas'),
  },
  {
    id: 'inundacion', titulo: 'Simulador de inundación', grupo: 'Agua y riesgo',
    resumen: 'Sube el nivel de un río o de un valle y mira qué quedaría bajo el agua (ilustrativo, no pronóstico).',
    fuentes: ['Relieve: INEGI, Continental relief 2016 (30 m; flujo a 90 m)', 'Localidades: INEGI, Censo 2020 (ITER)', 'Salud: CLUES 2026 · Escuelas: DENUE', 'Red vial: © OpenStreetMap (ODbL) · Cuerpos de agua: INEGI, Serie VII'],
    load: () => import('./inundacion/Inundacion'),
  },
  {
    id: 'laderas', titulo: 'Laderas inestables', grupo: 'Agua y riesgo',
    resumen: 'Dónde se juntan pendiente fuerte, lluvia intensa, roca débil y suelo sin bosque; comparado con el mapa del CENAPRED y los deslizamientos registrados.',
    fuentes: ['Pendiente: relieve de INEGI a 30 m', 'Lluvia intensa: CHIRPS v3 (Climate Hazards Center, UCSB)', 'Roca: INEGI, geología 1:250 000 (vía IDEFOR, CONAFOR)', 'Cobertura: INEGI, Serie VII', 'CENAPRED: Mapa Nacional de Susceptibilidad por Inestabilidad de Laderas y atlas estatal de Hidalgo (deslizamientos 2008–2009)', 'Deslizamientos: NASA, Global Landslide Catalog'],
    load: () => import('./laderas/Laderas'),
  },
  {
    id: 'cambio-uso', titulo: 'Cambio de uso de suelo', grupo: 'Agua y riesgo',
    resumen: 'Series VI (2014) y VII (2018) de INEGI: dónde se perdió bosque, creció la ciudad o volvió la vegetación.',
    fuentes: ['INEGI, Uso del suelo y vegetación 1:250 000, Series VI y VII (vía IDEFOR, CONAFOR)'],
    load: () => import('./cambio-uso/CambioUso'),
  },
  { id: 'perfil', titulo: 'Perfil de elevación', grupo: 'Planeación', resumen: 'Corte del terreno entre dos puntos o a lo largo de una carretera.' },
  { id: 'antenas', titulo: 'Cobertura de antenas', grupo: 'Planeación', resumen: 'Qué localidades ve una torre desde un cerro.' },
  { id: 'solar', titulo: 'Potencial solar', grupo: 'Planeación', resumen: 'Radiación anual según la orientación del terreno.' },
  { id: 'movilidad', titulo: 'Movilidad', grupo: 'Planeación', resumen: 'Arcos 3D de traslados al trabajo entre municipios.' },
  { id: 'recorridos', titulo: 'Recorridos guiados', grupo: 'Difusión', resumen: 'Vuelos narrados por las regiones del estado.' },
  { id: 'geoparque', titulo: 'Geoparque y Pueblos Mágicos', grupo: 'Difusión', resumen: 'Geositios de la Comarca Minera (UNESCO) y pueblos en 3D.' },
  { id: 'video', titulo: 'Exportar video', grupo: 'Difusión', resumen: 'Grabar un vuelo para redes sociales.' },
  { id: 'impresion', titulo: 'Impresión 3D', grupo: 'Difusión', resumen: 'Modelo STL para maquetas y mapas táctiles.' },
  { id: 'escuelas', titulo: 'Modo escuelas', grupo: 'Difusión', resumen: 'Regiones, ríos y climas explicados.' },
  { id: 'preguntas', titulo: 'Preguntas en lenguaje natural', grupo: 'Plataforma', resumen: '«Municipios arriba de 2 500 m con más de 30 % de pobreza».' },
  { id: 'enlaces', titulo: 'Enlaces a vistas', grupo: 'Plataforma', resumen: 'Compartir un municipio o un ángulo exacto.' },
];

export const GROUP_ORDER: AnalysisGroup[] = ['Población', 'Desigualdad', 'Servicios', 'Agua y riesgo', 'Planeación', 'Difusión', 'Plataforma'];
