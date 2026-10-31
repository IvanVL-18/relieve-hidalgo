/** Fuentes públicas: URL, archivo en data-src/cache, cita y licencia. */
import { LAT0, LAT1, LON0, LON1 } from './lib.mjs';

const pad = 0.03;
export const BBOX = { s: LAT1 - pad, w: LON0 - pad, n: LAT0 + pad, e: LON1 + pad };

export const SOURCES = {
  // huellas de edificios detectadas en imágenes de satélite: lista de archivos (uno por cuadrícula z9 de Bing, quadkey) y
  // de ella los de México que tocan el rectángulo del mapa; GeoJSON por renglón en .csv.gz. Para México no traen altura
  edificios: {
    url: 'https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv', file: 'edificios/', region: 'Mexico',
    fuente: 'Microsoft, Global ML Building Footprints (versión 2026-02-03)', licencia: 'Open Data Commons Open Database License (ODbL) 1.0',
  },
  iter: { url: 'https://www.inegi.org.mx/contenidos/programas/ccpv/2020/datosabiertos/iter/iter_13_cpv2020_csv.zip', file: 'iter/iter_13_cpv2020_csv.zip', fuente: 'INEGI, Censo de Población y Vivienda 2020, ITER', licencia: 'Términos de libre uso de la información del INEGI' },
  // muestra del censo (cuestionario ampliado): municipio de trabajo y de escuela de cada persona, con su factor de expansión
  muestra: { url: 'https://www.inegi.org.mx/contenidos/programas/ccpv/2020/microdatos/Censo2020_CA_hgo_csv.zip', file: 'inegi/Censo2020_CA_hgo_csv.zip', fuente: 'INEGI, Censo de Población y Vivienda 2020, microdatos de la muestra (cuestionario ampliado), Hidalgo', licencia: 'Términos de libre uso de la información del INEGI' },
  muestra_dic: { url: 'https://www.inegi.org.mx/contenidos/programas/ccpv/2020/microdatos/diccionario_cuestionario_ampliado_cpv2020.xlsx', file: 'inegi/diccionario_cuestionario_ampliado_cpv2020.xlsx', fuente: 'INEGI, Censo 2020, diccionario de datos del cuestionario ampliado', licencia: 'Términos de libre uso de la información del INEGI' },
  denue: { url: 'https://www.inegi.org.mx/contenidos/masiva/denue/denue_13_csv.zip', file: 'denue/denue_13_csv.zip', fuente: 'INEGI, Directorio Estadístico Nacional de Unidades Económicas (DENUE)', licencia: 'Términos de libre uso de la información del INEGI' },
  // una consulta por municipio ({mun} = 001 … 084): todas las localidades activas, también las que el ITER agrupa
  catalogo: { url: 'https://gaia.inegi.org.mx/wscatgeo/v2/localidades/13{mun}', file: 'inegi/localidades/13{mun}.json', fuente: 'INEGI, Catálogo Único de Claves de Áreas Geoestadísticas Estatales, Municipales y Localidades (servicio wscatgeo)', licencia: 'Términos de libre uso de la información del INEGI' },
  imm: { url: 'https://conapo.segob.gob.mx/work/models/CONAPO/Datos_Abiertos/Municipio/IMM_2020.xlsx', file: 'conapo/IMM_2020.xlsx', fuente: 'CONAPO, Índice de marginación por municipio 2020', licencia: 'Datos abiertos del Gobierno de México' },
  iml: { url: 'https://conapo.segob.gob.mx/work/models/CONAPO/Datos_Abiertos/Localidad/IML_2020.zip', file: 'conapo/IML_2020.zip', fuente: 'CONAPO, Índice de marginación por localidad 2020', licencia: 'Datos abiertos del Gobierno de México' },
  clues: { url: 'http://gobi.salud.gob.mx/gobi/catalogos/catalogosmaestros/ESTABLECIMIENTO_SALUD_202608.xlsx', file: 'clues/ESTABLECIMIENTO_SALUD_202608.xlsx', fuente: 'Secretaría de Salud, DGIS, Catálogo de Clave Única de Establecimientos de Salud (CLUES), agosto 2026', licencia: 'Datos abiertos del Gobierno de México' },
  usv: {
    url: `https://idefor.cnf.gob.mx/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=geonode:cdv_usuev250svii_cnal_wgs84&outputFormat=application/json&bbox=${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n},EPSG:4326`,
    file: 'usv/usv250s7_hidalgo.geojson', fuente: 'INEGI, Uso del suelo y vegetación 1:250 000 Serie VII (vía IDEFOR, CONAFOR)', licencia: 'Términos de libre uso de la información del INEGI',
  },
  // serie anterior para el análisis de cambio de uso de suelo (misma leyenda de claves que la Serie VII)
  usv6: {
    url: `https://idefor.cnf.gob.mx/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=geonode:usv250s6_lcc_atributos_mgm_geo&outputFormat=application/json&bbox=${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n},EPSG:4326`,
    file: 'usv/usv250s6_hidalgo.geojson', fuente: 'INEGI, Uso del suelo y vegetación 1:250 000 Serie VI (vía IDEFOR, CONAFOR)', licencia: 'Términos de libre uso de la información del INEGI',
  },
  // rangos de precipitación media anual (INEGI, 1910–2009), publicados por CONAFOR para la Megalópolis (cubre Hidalgo)
  lluvia: {
    url: `https://idefor.cnf.gob.mx/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=geonode:precipitacion&outputFormat=application/json&bbox=${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n},EPSG:4326`,
    file: 'inegi/precipitacion_hidalgo.geojson', fuente: 'INEGI, precipitación media anual 1910–2009 (vía IDEFOR, CONAFOR: Megalópolis 2021)', licencia: 'Términos de libre uso de la información del INEGI',
  },
  // tipo de roca (INEGI, geología serie I 1:250 000), publicado por CONAFOR para la Megalópolis (cubre Hidalgo)
  rocas: {
    url: `https://idefor.cnf.gob.mx/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=geonode:rocas_mega_ent&outputFormat=application/json&bbox=${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n},EPSG:4326`,
    file: 'inegi/rocas_hidalgo.geojson', fuente: 'INEGI, conjunto de datos geológicos 1:250 000 serie I (vía IDEFOR, CONAFOR: tipo de roca en la Megalópolis 2021)', licencia: 'Términos de libre uso de la información del INEGI',
  },
  // modo escuelas: climas (Köppen modificado por García), provincias fisiográficas y sistemas de topoformas de INEGI,
  // publicados por CONAFOR para la Megalópolis (cubren Hidalgo)
  climas: {
    url: `https://idefor.cnf.gob.mx/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=geonode:climas_inters&outputFormat=application/json&bbox=${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n},EPSG:4326`,
    file: 'inegi/climas_hidalgo.geojson', fuente: 'INEGI, unidades climáticas 1:1 000 000 (vía IDEFOR, CONAFOR: Megalópolis)', licencia: 'Términos de libre uso de la información del INEGI',
  },
  provincias: {
    url: `https://idefor.cnf.gob.mx/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=geonode:provincias&outputFormat=application/json&bbox=${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n},EPSG:4326`,
    file: 'inegi/provincias_hidalgo.geojson', fuente: 'INEGI, provincias fisiográficas 1:1 000 000 (vía IDEFOR, CONAFOR: Megalópolis)', licencia: 'Términos de libre uso de la información del INEGI',
  },
  topoformas: {
    url: `https://idefor.cnf.gob.mx/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=geonode:topofromas&outputFormat=application/json&bbox=${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n},EPSG:4326`,
    file: 'inegi/topoformas_hidalgo.geojson', fuente: 'INEGI, sistemas de topoformas 1:1 000 000 (vía IDEFOR, CONAFOR: Megalópolis)', licencia: 'Términos de libre uso de la información del INEGI',
  },
  // lluvia por pentada (5 días) de CHIRPS v3, 1981–2025: de cada archivo de Latinoamérica se lee por rangos solo la
  // franja de Hidalgo ({y} año, {m} mes, {p} pentada 1–6); se guarda un archivo por año
  chirps: {
    url: 'https://data.chc.ucsb.edu/products/CHIRPS/v3.0/pentads/latam/tifs/chirps-v3.0.{y}.{m}.{p}.tif', file: 'chirps/pentadas/', anios: [1981, 2025],
    fuente: 'Climate Hazards Center (UCSB), CHIRPS v3.0, pentadas a 0.05° (Funk et al.; CHIRPS3 Data Repository, doi:10.15780/G2JQ0P)', licencia: 'Dominio público',
  },
  // CENAPRED, servicio ArcGIS del Atlas Nacional de Riesgos: del atlas estatal de Hidalgo, los deslizamientos
  // registrados (2008 y 2009) y las zonas de peligro por deslizamiento. (Su Mapa Nacional de Susceptibilidad por
  // Inestabilidad de Laderas solo se publica, en Situacionales/Laderas_Fernand, para Tamaulipas, Nuevo León, San Luis
  // Potosí y Veracruz: no cubre Hidalgo.)
  cenapred: {
    url: 'http://servicios2.cenapred.unam.mx:6080/arcgis/rest/services', file: 'cenapred/',
    historicos: ['AtlasEstatales/MapaHidalgo/MapServer/141', 'AtlasEstatales/MapaHidalgo/MapServer/142'], zonas: 'AtlasEstatales/MapaHidalgo/MapServer/139',
    fuente: 'CENAPRED, Atlas Nacional de Riesgos: Atlas Estatal de Hidalgo, inestabilidad de laderas (deslizamientos registrados en 2008 y 2009 y zonificación)', licencia: 'Información pública del Gobierno de México (citar al CENAPRED)',
  },
  // radiación solar. Nivel del año: Global Solar Atlas 2.0 (Solargis, 1999–2018, 9″ ≈ 270 m; el zip de México trae la
  // global y la difusa anuales, y mensual solo la producción FV). Reparto en los meses: climatología 2001–2025 de NASA
  // POWER (CERES SYN1deg, celdas de 1°), global y difusa; la API regional acepta un parámetro por consulta ({p})
  atlas_solar: {
    url: 'https://api.globalsolaratlas.info/download/Mexico/Mexico_GISdata_LTAym_AvgDailyTotals_GlobalSolarAtlas-v2_AAIGRID.zip', file: 'solargis/Mexico_LTAym_AvgDailyTotals_AAIGRID.zip',
    fuente: 'Global Solar Atlas 2.0 (World Bank Group, ESMAP; datos © 2019 Solargis): radiación global y difusa horizontal, promedio 1999–2018', licencia: 'CC BY 4.0 (con la cláusula de mediación de Solargis)',
  },
  solar: {
    url: 'https://power.larc.nasa.gov/api/temporal/climatology/regional?parameters={p}&community=RE&longitude-min=-100.5&longitude-max=-97.5&latitude-min=19.5&latitude-max=21.5&format=JSON',
    file: 'nasa/power_{p}.json', parametros: ['ALLSKY_SFC_SW_DWN', 'ALLSKY_SFC_SW_DIFF'],
    fuente: 'NASA Langley Research Center, POWER Project (Prediction Of Worldwide Energy Resources): climatología mensual 2001–2025 de radiación solar en superficie (CERES SYN1deg, 1°)', licencia: 'Datos abiertos de la NASA (citar al proyecto POWER)',
  },
  // deslizamientos registrados (precisión de kilómetros): referencia para el análisis de laderas
  deslizamientos: { url: 'https://data.nasa.gov/docs/legacy/Global_Landslide_Catalog_Export/Global_Landslide_Catalog_Export_rows.csv', file: 'nasa/glc.csv', fuente: 'NASA, Global Landslide Catalog (Kirschbaum et al.)', licencia: 'Datos abiertos de la NASA' },
  vias: { url: 'overpass', file: 'osm/vias_hidalgo.json', fuente: 'OpenStreetMap (Overpass API)', licencia: 'ODbL 1.0 © colaboradores de OpenStreetMap' },
  agua: { url: 'overpass', file: 'osm/agua_hidalgo.json', fuente: 'OpenStreetMap (Overpass API): ríos, presas y lagos', licencia: 'ODbL 1.0 © colaboradores de OpenStreetMap' },
  relieve: {
    url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', file: 'terrain/',
    fuente: 'Terrain Tiles (AWS Open Data, Mapzen/Tilezen): en México, INEGI, Continental relief, 2016; SRTM y GMTED2010 cortesía del USGS',
    licencia: 'Términos de libre uso de la información del INEGI; USGS: dominio público',
  },
  satelite: { url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg', file: 's2/', fuente: 'Sentinel-2 cloudless 2016 — https://s2maps.eu, EOX IT Services GmbH (contiene datos modificados de Copernicus Sentinel 2016)', licencia: 'CC BY 4.0' },
};

/** Atribución del relieve tal como la piden Terrain Tiles (INEGI para México) y el USGS. */
export const RELIEF_CREDIT = 'INEGI, Continental relief 2016, y USGS (SRTM, GMTED2010), vía Terrain Tiles (AWS Open Data)';

/** Teselas Web Mercator z12 que cubren la rejilla (≈ 36 m por píxel). */
export function tileRange(z) {
  const n = 2 ** z;
  const tx = lon => Math.floor(((lon + 180) / 360) * n);
  const ty = lat => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n); };
  return { z, x0: tx(LON0 - 0.01), x1: tx(LON1 + 0.01), y0: ty(LAT0 + 0.01), y1: ty(LAT1 - 0.01) };
}

