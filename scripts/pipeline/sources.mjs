/** Fuentes públicas: URL, archivo en data-src/cache, cita y licencia. */
import { LAT0, LAT1, LON0, LON1 } from './lib.mjs';

const pad = 0.03;
export const BBOX = { s: LAT1 - pad, w: LON0 - pad, n: LAT0 + pad, e: LON1 + pad };

export const SOURCES = {
  iter: { url: 'https://www.inegi.org.mx/contenidos/programas/ccpv/2020/datosabiertos/iter/iter_13_cpv2020_csv.zip', file: 'iter/iter_13_cpv2020_csv.zip', fuente: 'INEGI, Censo de Población y Vivienda 2020, ITER', licencia: 'Términos de libre uso de la información del INEGI' },
  denue: { url: 'https://www.inegi.org.mx/contenidos/masiva/denue/denue_13_csv.zip', file: 'denue/denue_13_csv.zip', fuente: 'INEGI, Directorio Estadístico Nacional de Unidades Económicas (DENUE)', licencia: 'Términos de libre uso de la información del INEGI' },
  imm: { url: 'https://conapo.segob.gob.mx/work/models/CONAPO/Datos_Abiertos/Municipio/IMM_2020.xlsx', file: 'conapo/IMM_2020.xlsx', fuente: 'CONAPO, Índice de marginación por municipio 2020', licencia: 'Datos abiertos del Gobierno de México' },
  iml: { url: 'https://conapo.segob.gob.mx/work/models/CONAPO/Datos_Abiertos/Localidad/IML_2020.zip', file: 'conapo/IML_2020.zip', fuente: 'CONAPO, Índice de marginación por localidad 2020', licencia: 'Datos abiertos del Gobierno de México' },
  clues: { url: 'http://gobi.salud.gob.mx/gobi/catalogos/catalogosmaestros/ESTABLECIMIENTO_SALUD_202608.xlsx', file: 'clues/ESTABLECIMIENTO_SALUD_202608.xlsx', fuente: 'Secretaría de Salud, DGIS, Catálogo de Clave Única de Establecimientos de Salud (CLUES), agosto 2026', licencia: 'Datos abiertos del Gobierno de México' },
  usv: {
    url: `https://idefor.cnf.gob.mx/geoserver/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=geonode:cdv_usuev250svii_cnal_wgs84&outputFormat=application/json&bbox=${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n},EPSG:4326`,
    file: 'usv/usv250s7_hidalgo.geojson', fuente: 'INEGI, Uso del suelo y vegetación 1:250 000 Serie VII (vía IDEFOR, CONAFOR)', licencia: 'Términos de libre uso de la información del INEGI',
  },
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

