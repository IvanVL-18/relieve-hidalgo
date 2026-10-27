# Relieve de Hidalgo

Modelo 3D interactivo del estado de Hidalgo con datos oficiales: relieve real, uso de suelo de INEGI, imagen
satelital, ríos, presas, municipios y localidades, luz solar según la hora y vista nocturna. Además incluye análisis de
población, marginación y acceso a servicios. Está hecho con React, TypeScript y three.js y funciona como un componente
que se puede incrustar en cualquier sitio React.

![Uso de suelo de INEGI sobre el relieve](docs/uso-de-suelo.webp)

## Qué se puede hacer

**Explorar el territorio**
- Tres mapas base: **uso de suelo** (INEGI Serie VII), **satélite** (Sentinel-2) y **altitud**.
- Ríos, presas, límites municipales de INEGI, curvas de nivel, localidades y regiones.
- Sol en su posición real para la hora elegida; de noche se encienden las localidades.
- Buscador, ficha por municipio, minimapa, imagen descargable con créditos y pantalla completa.

**Análisis** (botón «Análisis»)

| Análisis | Qué muestra |
|---|---|
| Población | Habitantes y densidad por municipio, y cada localidad como columna 3D proporcional a su población |
| Localidades | Las 4 690 localidades del censo: filtros por tamaño, marginación y las más aisladas |
| Relieve y marginación | Si la marginación se concentra en el terreno abrupto: mapa bivariado, dispersión y correlación |
| Accesibilidad | Carreteras y tiempo de traslado al hospital, centro de salud o escuela más cercano; rutas al hacer clic |

El menú también muestra los análisis planeados («Próximamente»): cuencas, inundación, perfil de elevación, antenas,
potencial solar, movilidad, recorridos guiados, impresión 3D y más.

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

### Agregar un análisis

1. Crea `src/relieve/analyses/<id>/<Nombre>.tsx`, un componente que recibe `{ ctx }`.
2. Dibuja con `ctx.map`: colores por municipio, capas sobre el terreno, puntos, columnas, líneas, clics y ficha del
   cursor. Todo lo que crea se borra solo al cerrar el análisis, así no afecta a los demás.
3. Regístralo en `src/relieve/analyses/registry.ts`.

## Datos

```bash
npm run data:fetch   # descarga las fuentes oficiales a data-src/cache
npm run data         # las procesa y genera src/relieve/data
npm run data:db      # las carga en PostgreSQL (configura .env a partir de .env.example)
```

La base de datos (esquema `relieve`) tiene municipios, localidades con minutos al servicio más cercano, servicios,
uso de suelo, la red vial como grafo y vistas para consultas frecuentes. El mapa no la necesita: lee archivos
estáticos comprimidos. La base es para consultas, análisis y la API del laboratorio.

### Fuentes y licencias

| Dato | Fuente | Licencia |
|---|---|---|
| Elevación | SRTM vía Terrain Tiles (AWS Open Data) | Dominio público |
| Límites municipales | INEGI, Marco Geoestadístico 2022 | Términos de libre uso del INEGI |
| Uso del suelo y vegetación | INEGI, Serie VII 1:250 000 (vía IDEFOR, CONAFOR) | Términos de libre uso del INEGI |
| Población por localidad y municipio | INEGI, Censo de Población y Vivienda 2020 (ITER) | Términos de libre uso del INEGI |
| Marginación | CONAPO, índices de marginación 2020 por municipio y localidad | Datos abiertos del Gobierno de México |
| Unidades médicas | Secretaría de Salud, catálogo CLUES (agosto 2026) | Datos abiertos del Gobierno de México |
| Escuelas | INEGI, DENUE | Términos de libre uso del INEGI |
| Carreteras, ríos, presas, localidades de etiqueta | © colaboradores de OpenStreetMap | ODbL 1.0 |
| Imagen satelital | Sentinel-2 cloudless 2016, EOX IT Services GmbH (datos modificados de Copernicus Sentinel 2016) | CC BY 4.0 |

Estas atribuciones aparecen en el mapa y en la imagen descargable, y deben conservarse.

### Ten en cuenta
- Los **tiempos de traslado** son estimados sin tráfico: dependen del tipo de vía, el pavimento, la pendiente y las
  curvas. Úsalos para comparar zonas, no como el tiempo exacto de un viaje.
- El **DENUE** registra sobre todo escuelas urbanas. En zonas rurales faltan planteles, así que los tiempos a
  escuelas salen mayores a los reales.
- En el índice de **marginación** de CONAPO 2020, un valor menor significa mayor marginación. Los análisis lo
  invierten para que «más» se lea como «más marginación».

![Hidalgo de noche](docs/noche.webp)

## Estructura

```
src/relieve/           componente integrable
  engine/              motor 3D (three.js): escena, capas, rutas, mapas base
  analyses/            análisis y su registro
  shared/              lógica compartida por el navegador y los scripts de datos
  worker/              procesamiento del relieve en segundo plano
  data/                datos procesados que carga el mapa
scripts/pipeline/      descarga y procesamiento de fuentes, carga a PostgreSQL
scripts/               capturas (npm run shot) y medición de rendimiento (npm run perf)
data-src/              insumos base del relieve
```
