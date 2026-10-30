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
  {
    id: 'perfil', titulo: 'Perfil de elevación', grupo: 'Planeación',
    resumen: 'Corte del terreno entre dos o más puntos, o a lo largo de una carretera: subida, bajada, pendientes y punto más alto.',
    fuentes: ['Relieve: INEGI, Continental relief 2016 (30 m), vía Terrain Tiles', 'Red vial: © colaboradores de OpenStreetMap (ODbL)', 'Municipios: INEGI, Marco Geoestadístico 2022'],
    load: () => import('./perfil/Perfil'),
  },
  {
    id: 'antenas', titulo: 'Cobertura de antenas', grupo: 'Planeación',
    resumen: 'Pon torres en los cerros y mira qué zonas y localidades quedan a la vista de su antena, y cuánto más alta tendría que ser para llegar a las demás.',
    fuentes: ['Relieve: INEGI, Continental relief 2016 (30 m), vía Terrain Tiles', 'Localidades: INEGI, Censo 2020 (ITER)', 'Municipios: INEGI, Marco Geoestadístico 2022'],
    load: () => import('./antenas/Antenas'),
  },
  {
    id: 'solar', titulo: 'Potencial solar', grupo: 'Planeación',
    resumen: 'Cuánto sol recibe cada ladera al año según el clima, la pendiente, hacia dónde mira y lo que tapan los cerros; los meses de cualquier punto y un panel solar ahí.',
    fuentes: ['Clima: Global Solar Atlas 2.0 (Banco Mundial, ESMAP; datos © Solargis, CC BY 4.0)', 'Meses: NASA POWER (CERES SYN1deg)', 'Relieve: INEGI, Continental relief 2016 (90 m), vía Terrain Tiles'],
    load: () => import('./solar/Solar'),
  },
  {
    id: 'movilidad', titulo: 'Movilidad', grupo: 'Planeación',
    resumen: 'Arcos 3D de quienes viajan a diario a trabajar o estudiar a otro municipio o al valle de México: adónde van, de dónde llegan, cuánto tardan y en qué.',
    fuentes: ['INEGI, Censo de Población y Vivienda 2020, muestra (cuestionario ampliado)', 'Lugares fuera de Hidalgo: INEGI, Catálogo Único de Claves Geoestadísticas (servicio web)'],
    load: () => import('./movilidad/Movilidad'),
  },
  {
    id: 'recorridos', titulo: 'Recorridos guiados', grupo: 'Difusión',
    resumen: 'Vuelos narrados por el estado: de la Huasteca a la Comarca Minera, el camino del agua y el Geoparque. Con voz y en bucle para ferias.',
    fuentes: ['Población: INEGI, Censo 2020', 'Relieve: INEGI, Continental relief 2016', 'Geositios: Canet et al. (2017), Terra Digitalis, UNAM', 'Lluvia: INEGI'],
    load: () => import('./recorridos/Recorridos'),
  },
  {
    id: 'geoparque', titulo: 'Geoparque y Pueblos Mágicos', grupo: 'Difusión',
    resumen: 'Los 31 geositios del Geoparque Mundial de la UNESCO Comarca Minera y los 9 Pueblos Mágicos, con foto, historia y vuelo a cada uno.',
    fuentes: ['Geositios: Canet et al. (2017), Terra Digitalis, UNAM (Geoparque Comarca Minera)', 'Pueblos Mágicos: Secretaría de Turismo', 'Fotos: Wikimedia Commons (autor y licencia en cada ficha)'],
    load: () => import('./geoparque/Geoparque'),
  },
  {
    id: 'video', titulo: 'Video e imagen grande', grupo: 'Difusión',
    resumen: 'Graba en MP4 una vuelta, un acercamiento o un recorrido (horizontal, vertical o cuadrado), o descarga la vista en 4K u 8K.',
    fuentes: ['Las del mapa que se graba: relieve INEGI y USGS, OpenStreetMap, INEGI y el mapa base (van en el video)'],
    load: () => import('./video/Video'),
  },
  {
    id: 'impresion', titulo: 'Impresión 3D', grupo: 'Difusión',
    resumen: 'Descarga el relieve del estado, de un municipio o de un rectángulo como modelo STL para imprimir maquetas y mapas táctiles.',
    fuentes: ['Relieve: INEGI, Continental relief 2016 (30 y 90 m), vía Terrain Tiles', 'Ríos: drenaje calculado del relieve (90 m)', 'Municipios: INEGI, Marco Geoestadístico 2022', 'Localidades: INEGI, Censo 2020 (ITER)'],
    load: () => import('./impresion/Impresion'),
  },
  {
    id: 'escuelas', titulo: 'Hidalgo para escuelas', grupo: 'Difusión',
    resumen: 'Las 10 regiones, el relieve, los climas y el camino del agua explicados con sencillez, con preguntas para clase. También con ?escuelas.',
    fuentes: ['Regiones geoculturales: Secretaría de Cultura del Estado de Hidalgo (mapa, 2019)', 'Climas, provincias fisiográficas y topoformas: INEGI 1:1 000 000 (vía IDEFOR, CONAFOR)', 'Población: INEGI, Censo 2020', 'Camino del agua: relieve de INEGI (90 m) y ríos de © OpenStreetMap'],
    load: () => import('./escuelas/Escuelas'),
  },
  { id: 'preguntas', titulo: 'Preguntas en lenguaje natural', grupo: 'Plataforma', resumen: '«Municipios arriba de 2 500 m con más de 30 % de pobreza».' },
];

export const GROUP_ORDER: AnalysisGroup[] = ['Población', 'Desigualdad', 'Servicios', 'Agua y riesgo', 'Planeación', 'Difusión', 'Plataforma'];

/** Menú del modo escuelas: temas para clase y los análisis más sencillos de explicar. */
export const SCHOOL_ANALYSES = ['escuelas', 'recorridos', 'geoparque', 'poblacion', 'cuencas', 'perfil', 'solar', 'impresion'];
