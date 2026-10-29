# Relieve de Hidalgo

Modelo 3D interactivo del estado de Hidalgo con datos oficiales: relieve real, uso de suelo de INEGI, imagen
satelital, ríos, presas, municipios y localidades, luz solar según la hora y vista nocturna. Además incluye análisis de
población, marginación y acceso a servicios. Está hecho con React, TypeScript y three.js y funciona como un componente
que se puede incrustar en cualquier sitio React.

![Uso de suelo de INEGI sobre el relieve](docs/uso-de-suelo.webp)

## Qué se puede hacer

**Explorar el territorio**
- Relieve de INEGI con niveles de detalle: de lejos, 270 m; al acercarse, 90 m y luego 30 m (se descarga solo lo que
  está a la vista). Las cifras (pendientes, altitudes por municipio, punto más alto) se miden a 30 m.
- Tres mapas base: **uso de suelo** (INEGI Serie VII, con bordes suaves entre clases), **satélite** (Sentinel-2, sin
  las sombras de la foto; ≈ 16 m por píxel al acercarse) y **altitud**.
- Ríos calculados del relieve y guiados por OpenStreetMap, presas, límites municipales de INEGI, curvas de nivel,
  localidades del censo y regiones. Las líneas se ven nítidas a cualquier acercamiento.
- Sol en su posición real para la hora elegida; de noche se encienden las 4 690 localidades según su población.
- Buscador, ficha por municipio (población, superficie, altitudes), minimapa, imagen descargable con créditos y
  pantalla completa.

**Análisis** (botón «Análisis»)

| Análisis | Qué muestra |
|---|---|
| Población | Habitantes y densidad por municipio, y cada localidad como columna 3D proporcional a su población |
| Localidades | Las 4 690 localidades del censo: filtros por tamaño, marginación y las más aisladas |
| Relieve y marginación | Si la marginación se concentra en el terreno abrupto: mapa bivariado, dispersión y correlación |
| Accesibilidad | Carreteras y tiempo de traslado al hospital, centro de salud o escuela más cercano; rutas al hacer clic |

El menú también muestra los análisis planeados («Próximamente»): cuencas, inundación, perfil de elevación, antenas,
potencial solar, movilidad, recorridos guiados, impresión 3D y más. Las piezas que necesitan ya están en la base: capas
raster con su propia cobertura y paleta, cortina para comparar, y consultas de elevación, pendiente, cuencas y camino
del agua (ver «Agregar un análisis»).

![Relieve y marginación](docs/relieve-y-marginacion.webp)
![Accesibilidad a hospitales](docs/accesibilidad.webp)

## Usarlo

Requiere Node 22.

```bash
npm install
npm run dev
```

Parámetros útiles en la URL: `?analisis=accesibilidad` (o `poblacion`, `localidades`, `marginacion`),
`?mapa=satelite` o `?mapa=altitud`, `?hora=19.5` y `?embed` (el mapa dentro de una página normal).

Los datos procesados ya vienen en `src/relieve/data/`, así que no hace falta descargar nada para correrlo.

## Integrarlo en otro proyecto React + TypeScript

1. Copia `src/relieve/`.
2. Instala `three`, `@types/three`, `@fontsource/familjen-grotesk` y `@fontsource/jetbrains-mono`.
3. Ponlo dentro de un contenedor con altura:

```tsx
import { RelieveHidalgo } from './relieve';

<div style={{ height: 640 }}>
  <RelieveHidalgo
    cooperativeGestures                       // la rueda solo acerca con Ctrl, para no robar el scroll
    initialAnalysis="accesibilidad"
    municipioColors={{ '13048': '#f6b04a' }}  // tus propios indicadores por clave INEGI
    onSelectMunicipio={m => console.log(m?.code, m?.name)}
  />
</div>
```

Los estilos están aislados con el prefijo `rh-`, así que conviven con Bootstrap y Tailwind. three.js y los análisis
se descargan solo cuando el mapa aparece. Si los datos se sirven desde otra carpeta (por ejemplo, el `public/` de
Laravel), usa `dataBaseUrl` y copia ahí el contenido de `src/relieve/data/`.

El detalle al acercarse (`relieve-30m.bin`, `capas/satelite-16m.bin`) son paquetes de teselas que el mapa lee por
partes con peticiones *Range*, como cualquier servidor estático (Apache, nginx, un CDN). Si el servidor no las acepta,
el paquete se descarga completo una vez y todo sigue funcionando.

### Agregar un análisis

1. Crea `src/relieve/analyses/<id>/<Nombre>.tsx`, un componente que recibe `{ ctx }`.
2. Dibuja con `ctx.map`: colores por municipio, capas raster (`addRaster`: tu propia cobertura, resolución y paleta,
   con `valueAt` para consultar el valor), puntos, columnas, líneas, cortina para comparar (`compare`), clics y ficha
   del cursor. Todo lo que crea se borra solo al cerrar el análisis, así no afecta a los demás.
3. Si necesitas el relieve, pídelo a `ctx.data.terrain()`: elevación de puntos, perfiles, rejillas de elevación,
   pendiente, orientación o área drenada, cuenca de un punto y camino del agua (30 m donde hay teselas, si no 90 m).
4. Regístralo en `src/relieve/analyses/registry.ts`.

```tsx
const cuenca = await ctx.data.terrain().watershed(lon, lat);
ctx.map.addRaster({ kind: 'categorical', ...cuenca.grid, palette: [null, '#4fc3f7'], opacity: 0.5 });
```

## Datos

```bash
npm run data:fetch   # descarga las fuentes oficiales a data-src/cache (relieve, OSM, INEGI, CONAPO, CLUES…)
npm run data         # las procesa y genera src/relieve/data
npm run data:db      # las carga en PostgreSQL (configura .env a partir de .env.example)
```

Todo se regenera desde las fuentes públicas, incluido el relieve: el primer paso arma un relieve de ~30 m con las
teselas de elevación y de ahí saca el relieve del visor (270 m), el de 90 m, las teselas de 30 m, la red de ríos, las
direcciones de flujo y las estadísticas por municipio y localidad. Si Overpass no responde, los ríos y presas salen de
la copia `data-src/osm_agua.json.gz`.

Los datos procesados pesan ~37 MB, pero al abrir el mapa se descargan ~4 MB; el resto (relieve de 30 m e imagen fina)
llega por partes al acercarse.

### Pruebas

```bash
npm test                    # pruebas unitarias (Node, sin dependencias extra)
npm run visual -- --update  # guarda vistas de referencia del visor en shots/visual-base/
npm run visual              # las vuelve a capturar y marca en rojo lo que cambió (shots/visual-diff/)
```

Las referencias visuales dependen de la tarjeta gráfica: se comparan en el mismo equipo.

La base de datos (esquema `relieve`) tiene municipios, localidades con minutos al servicio más cercano, servicios,
uso de suelo, la red de ríos con orden de Strahler, la red vial como grafo y vistas para consultas frecuentes. El mapa
no la necesita: lee archivos estáticos comprimidos. La base es para consultas, análisis y la API del laboratorio.

### Fuentes y licencias

| Dato | Fuente | Licencia |
|---|---|---|
| Elevación | INEGI, Continental relief 2016, y USGS (SRTM, GMTED2010), vía Terrain Tiles (AWS Open Data) | Términos de libre uso del INEGI; USGS: dominio público |
| Límites municipales | INEGI, Marco Geoestadístico 2022 | Términos de libre uso del INEGI |
| Uso del suelo y vegetación | INEGI, Serie VII 1:250 000 (vía IDEFOR, CONAFOR) | Términos de libre uso del INEGI |
| Población, localidades de etiqueta y luces nocturnas | INEGI, Censo de Población y Vivienda 2020 (ITER) | Términos de libre uso del INEGI |
| Marginación | CONAPO, índices de marginación 2020 por municipio y localidad | Datos abiertos del Gobierno de México |
| Unidades médicas | Secretaría de Salud, catálogo CLUES (agosto 2026) | Datos abiertos del Gobierno de México |
| Escuelas | INEGI, DENUE | Términos de libre uso del INEGI |
| Carreteras, ríos, presas | © colaboradores de OpenStreetMap | ODbL 1.0 |
| Imagen satelital (todo el estado y teselas finas) | Sentinel-2 cloudless 2016, EOX IT Services GmbH (datos modificados de Copernicus Sentinel 2016) | CC BY 4.0 |

Estas atribuciones aparecen en el mapa y en la imagen descargable, y deben conservarse.

### Ten en cuenta
- Los **tiempos de traslado** son estimados sin tráfico: dependen del tipo de vía, el pavimento, la pendiente y las
  curvas. Úsalos para comparar zonas, no como el tiempo exacto de un viaje.
- El **DENUE** registra sobre todo escuelas urbanas. En zonas rurales faltan planteles, así que los tiempos a
  escuelas salen mayores a los reales.
- En el índice de **marginación** de CONAPO 2020, un valor menor significa mayor marginación. Los análisis lo
  invierten para que «más» se lea como «más marginación».
- Las **pendientes** dependen de la resolución: medidas a 30 m son mucho mayores que a 270 m (en el estado, 40 % del
  territorio supera 15° a 30 m contra 23 % a 270 m). Las cifras del visor y de la base usan 30 m.
- Los **ríos** son la red de drenaje calculada del relieve a 90 m (guiada por los ríos de OpenStreetMap), no la red
  hidrográfica oficial de INEGI: sirven para ver por dónde corre el agua, no para deslindar cauces.
- Las **cuencas** se calculan dentro de la zona del mapa (Hidalgo y ~1 km alrededor): lo que drena desde otros estados
  (por ejemplo, el río Tula desde el valle de México) no se cuenta. El resultado lo avisa con `truncated`.
- En las planicies, el relieve de INEGI trae un rayado; al acercarse, el sombreado de 30 m se usa solo en laderas.

![Hidalgo de noche](docs/noche.webp)

## Estructura

```
src/relieve/           componente integrable
  engine/              motor 3D (three.js): relieve con niveles de detalle, teselas, capas raster, rutas, mapas base
  analyses/            análisis y su registro
  shared/              lógica compartida por el navegador y los scripts de datos (rutas, cuencas, pendientes)
  worker/              arranque del relieve y worker de relieve (relieve fino, teselas y consultas de los análisis)
  data/                datos procesados que carga el mapa
scripts/pipeline/      descarga y procesamiento de fuentes (relieve, hidrología, población…), carga a PostgreSQL
scripts/               capturas (npm run shot), regresión visual (npm run visual) y rendimiento (npm run perf)
tests/                 pruebas unitarias (npm test)
data-src/              copia de respaldo de ríos y presas (OSM); cache/ y out/ se generan
```
