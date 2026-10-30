import type { SolarClimate } from '../shared/solar';
import type { TerrainApi } from '../shared/terrain';
import type { Meta } from '../shared/types';
import { fetchBin } from '../worker/decode';
import { createRouter, type Router } from './accesibilidad/router';

/** Municipio con población (ITER 2020), marginación (CONAPO 2020), relieve y uso de suelo. */
export interface Municipio {
  id: number; cve: string; nombre: string;
  pob: number; pob_fem: number; pob_mas: number; pob_0_14: number; pob_15_64: number; pob_65: number; viviendas: number;
  area_km2: number; densidad: number; localidades: number; pob_urbana: number;
  im: number | null; gm: string | null; imn: number | null;
  analf: number | null; sbasc: number | null; ovsde: number | null; ovsee: number | null; ovsae: number | null;
  ovpt: number | null; vhac: number | null; pl5000: number | null; po2sm: number | null;
  /** relieve medido a 30 m: pendiente media (°), % del territorio con más de 15° y de 30°, rugosidad (m), altitudes */
  pendiente: number; pct_pend_15: number; pct_pend_30: number; rugosidad: number; alt_media: number; alt_min: number; alt_max: number;
  uso: Record<string, number>;
}

/** Localidades del ITER 2020 en columnas (ordenadas de mayor a menor población). */
export interface Localidades {
  n: number;
  lon: Float32Array; lat: Float32Array;
  pob: Uint32Array; fem: Uint32Array; mas: Uint32Array; p014: Uint32Array; p65: Uint32Array; viv: Uint32Array;
  /** índice de marginación CONAPO (NaN = sin dato) */
  im: Float32Array;
  alt: Int16Array; loc: Uint16Array;
  muni: Uint8Array;
  /** grado de marginación: 0 sin dato, 1 muy bajo … 5 muy alto */
  grado: Uint8Array;
  /** pendiente media del entorno (1 km), grados */
  pend: Uint8Array;
  nombre: string[];
}

/** Clave de una localidad sin el estado («0480001» = municipio 048, localidad 0001), estable entre versiones de los datos. */
export const locKey = (l: Localidades, i: number) => String(l.muni[i]).padStart(3, '0') + String(l.loc[i]).padStart(4, '0');
export function locIndex(l: Localidades, key: string) {
  const m = /^(\d{3})(\d{4})$/.exec(key);
  if (!m) return -1;
  const mu = Number(m[1]), lo = Number(m[2]);
  for (let i = 0; i < l.n; i++) if (l.muni[i] === mu && l.loc[i] === lo) return i;
  return -1;
}

/**
 * Lugares extra para el buscador: localidades del catálogo de INEGI que no están en el ITER (deshabitadas o de 1–2
 * viviendas) y asentamientos (colonias, fraccionamientos, barrios…) de las direcciones del DENUE.
 */
export interface Lugares {
  n: number;
  lon: Float32Array; lat: Float32Array;
  /** clave de la localidad: la propia o aquella a la que pertenece el asentamiento */
  loc: Uint16Array;
  /** negocios del DENUE en el asentamiento (0 en localidades) */
  negocios: Uint16Array;
  /** índice en `localidades` de la localidad que se muestra junto al municipio (0 = ninguna) */
  sub: Uint16Array;
  muni: Uint8Array;
  /** índice en `tipos` (0 = localidad) */
  tipo: Uint8Array;
  nombre: string[]; tipos: string[]; localidades: string[];
}

export interface Servicios {
  n: number;
  lon: Float32Array; lat: Float32Array;
  /** índice en SERVICE_TYPES */
  tipo: Uint8Array;
  publico: Uint8Array;
  nombre: string[]; detalle: string[];
}

/**
 * Pendiente medida a 30 m, resumida por nodo de la rejilla del visor (W × H): sirve para medir a 30 m cualquier zona
 * (una cuenca) sin bajar las teselas. Media en cuartos de grado (0 = sin dato); p15 y p30 = fracción × 200.
 */
export interface Pendiente { w: number; h: number; mean: Uint8Array; p15: Uint8Array; p30: Uint8Array }

/**
 * Nombres de los ríos de OSM sobre el cauce calculado a 90 m: celda (fila · w + columna de la rejilla de flujo, en
 * orden creciente) e índice del río en `nombres`.
 */
export interface RiosNombres { n: number; cell: Uint32Array; rio: Uint16Array; nombres: string[] }

/** Uso del suelo y vegetación por clases (INEGI, una serie) en la rejilla de ≈ 65 m: factor f del visor; 0 = sin dato. */
export interface UsoSuelo {
  w: number; h: number; f: number;
  clase: Uint8Array;
  /** clase k = clases[k − 1]; grupo = índice en USV_GROUPS; sec = vegetación secundaria */
  clases: { clave: string; nombre: string; grupo: number; sec: boolean }[];
}

/**
 * Susceptibilidad de laderas (índice propio) a ≈ 90 m, f = factor del visor: tres planos de w·h bytes con la clase, sus
 * factores y las zonas de peligro del atlas estatal (empaque en shared/laderas.ts); la rejilla de lluvia de CHIRPS y los
 * deslizamientos registrados.
 */
export interface Laderas {
  w: number; h: number; f: number;
  p0: Uint8Array; p1: Uint8Array; p2: Uint8Array;
  /** 0 sin dato, 1 muy baja … 5 muy alta (de p0) */
  clase: Uint8Array;
  /** 1 = dentro de una zona de peligro por deslizamiento del atlas estatal (de p2) */
  zona: Uint8Array;
  clases: string[];
  /** km² de Hidalgo por clase (muy baja … muy alta) */
  km2: number[];
  /** CHIRPS a 0.05° (centros de celda desde lon0, lat0 + medio paso): promedio del máximo anual de lluvia en 5 días,
   *  su valor de 10 años y la lluvia anual, en mm (null = sin dato) */
  lluvia: { lon0: number; lat0: number; step: number; cols: number; rows: number; anios: [number, number]; rx5: (number | null)[]; rx10: (number | null)[]; anual: (number | null)[] };
  /** atlas estatal de Hidalgo en el CENAPRED: deslizamientos registrados en 2008 y 2009 */
  historicos: { fecha: string; lon: number; lat: number; nivel: string; roca: string; tipo: string; nota: string }[];
  /** deslizamientos del catálogo global de la NASA (precisión de kilómetros) */
  eventos: { fecha: string; lugar: string; lon: number; lat: number; precision: string; muertes: number }[];
  /** zonas de peligro por deslizamiento del atlas estatal (anillos lon/lat) */
  zonas: [number, number][][];
}

/** Potencial solar a ≈ 90 m (nodos de la rejilla de factor f): radiación anual sobre el terreno (modelo de shared/solar.ts). */
export interface Solar {
  w: number; h: number; f: number;
  /** (kWh/m²·año − q.offset) / q.step por nodo; 0 = sin dato */
  e: Uint8Array;
  q: { offset: number; step: number };
  /** cortes de las clases (kWh/m²·año) */
  clases: number[];
  clima: SolarClimate;
  periodos: { atlas: string; meses: string };
  estado: { media: number; p5: number; p50: number; p95: number; min: number; max: number };
  /** media sobre el terreno, global de lo plano (sin relieve), mínimo, máximo y km² por clase */
  municipios: { id: number; media: number; plano: number; min: number; max: number; km2: number[] }[];
}

/** Traslados de un tipo por municipio de residencia (muestra del Censo 2020, personas estimadas con el factor de expansión). */
export interface Traslados {
  /** total; en su municipio; a otro de Hidalgo; a otro estado; al extranjero; sin especificar; registros de la muestra */
  total: number; mismo: number; hgo: number; fuera: number; ext: number; ne: number; n: number;
  /** tiempo de traslado: índice = clave del censo (1 ≤ 15 min … 5 > 2 h, 6 no se puede saber, 7 no se traslada; 0 y 9 sin dato) */
  tiempo: number[];
  /** medio principal: índice = clave del censo (1 caminando … 12 otro; 0 sin dato) */
  medio: number[];
}

/** Movilidad cotidiana al trabajo y a la escuela: lugares, flujos [origen 0–83, lugar, personas, registros] y resúmenes. */
export interface Movilidad {
  fuente: string;
  /** 0–83 = municipios de Hidalgo (en su localidad más poblada); después, destinos de fuera */
  lugares: { clave: string; nombre: string; lon: number; lat: number; ent: number; en?: string }[];
  flujos: Record<'trabajo' | 'escuela', [number, number, number, number][]>;
  /** personas con destino sin lugar en el mapa (municipio del Estado de México sin especificar o con pocos traslados) */
  sinLugar: Record<'trabajo' | 'escuela', { edomex: number; otros: number }>;
  municipios: Record<'trabajo' | 'escuela', Traslados[]>;
}

export const GRADOS = ['Sin dato', 'Muy bajo', 'Bajo', 'Medio', 'Alto', 'Muy alto'];

/** Lector de los .bin del proyecto: arreglos alineados a 4 bytes y textos separados por \n. */
export class BinReader {
  private dv: DataView;
  o = 0;
  constructor(private buf: Uint8Array) { this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  arr<T>(Ctor: { new (b: ArrayBuffer): T; BYTES_PER_ELEMENT: number }, n: number): T {
    const bytes = n * Ctor.BYTES_PER_ELEMENT;
    const a = new Ctor(this.buf.slice(this.o, this.o + bytes).buffer);
    this.o += bytes + ((4 - (bytes % 4)) % 4);
    return a;
  }
  str(): string[] {
    const len = this.u32();
    const s = new TextDecoder().decode(this.buf.subarray(this.o, this.o + len));
    this.o += len + ((4 - (len % 4)) % 4);
    return s.split('\n');
  }
  magic(m: number, name: string) { if (this.u32() !== m) throw new Error(`${name} no tiene el formato esperado`); }
}

export function decodeLocalidades(buf: Uint8Array): Localidades {
  const r = new BinReader(buf);
  r.magic(0x314c4852, 'localidades.bin');
  const n = r.u32();
  return {
    n, lon: r.arr(Float32Array, n), lat: r.arr(Float32Array, n),
    pob: r.arr(Uint32Array, n), fem: r.arr(Uint32Array, n), mas: r.arr(Uint32Array, n), p014: r.arr(Uint32Array, n), p65: r.arr(Uint32Array, n), viv: r.arr(Uint32Array, n),
    im: r.arr(Float32Array, n), alt: r.arr(Int16Array, n), loc: r.arr(Uint16Array, n),
    muni: r.arr(Uint8Array, n), grado: r.arr(Uint8Array, n), pend: r.arr(Uint8Array, n), nombre: r.str(),
  };
}

export function decodeLugares(buf: Uint8Array): Lugares {
  const r = new BinReader(buf);
  r.magic(0x314e4852, 'lugares.bin');
  const n = r.u32();
  return {
    n, lon: r.arr(Float32Array, n), lat: r.arr(Float32Array, n),
    loc: r.arr(Uint16Array, n), negocios: r.arr(Uint16Array, n), sub: r.arr(Uint16Array, n),
    muni: r.arr(Uint8Array, n), tipo: r.arr(Uint8Array, n), nombre: r.str(), tipos: r.str(), localidades: r.str(),
  };
}

export function decodePendiente(buf: Uint8Array): Pendiente {
  const r = new BinReader(buf);
  r.magic(0x31544852, 'pendiente.bin');
  const w = r.u32(), h = r.u32();
  return { w, h, mean: r.arr(Uint8Array, w * h), p15: r.arr(Uint8Array, w * h), p30: r.arr(Uint8Array, w * h) };
}

export function decodeRiosNombres(buf: Uint8Array): RiosNombres {
  const r = new BinReader(buf);
  r.magic(0x31524852, 'rios-nombres.bin');
  const n = r.u32();
  return { n, cell: r.arr(Uint32Array, n), rio: r.arr(Uint16Array, n), nombres: r.str() };
}

export function decodeUsoSuelo(buf: Uint8Array, clases: UsoSuelo['clases'], meta: Meta): UsoSuelo {
  const r = new BinReader(buf);
  r.magic(0x31555248, 'uso de suelo');
  const w = r.u32(), h = r.u32();
  return { w, h, f: Math.round(w / (meta.W - 1)), clase: r.arr(Uint8Array, w * h), clases };
}

export function decodeServicios(buf: Uint8Array): Servicios {
  const r = new BinReader(buf);
  r.magic(0x31534852, 'servicios.bin');
  const n = r.u32();
  return { n, lon: r.arr(Float32Array, n), lat: r.arr(Float32Array, n), tipo: r.arr(Uint8Array, n), publico: r.arr(Uint8Array, n), nombre: r.str(), detalle: r.str() };
}

export type ResolveUrl = (name: string, bundled: string) => string;

/**
 * Datos de los análisis, cargados una sola vez por visor y compartidos entre análisis.
 * Para agregar un conjunto nuevo: su URL con new URL(…, import.meta.url) y un cargador aquí.
 * terrain: el worker de relieve del visor (elevación, perfiles, pendiente, cuencas).
 */
export function createDatasets(resolve: ResolveUrl, meta: Meta, terrain?: () => TerrainApi) {
  const cache = new Map<string, Promise<unknown>>();
  let router: Router | null = null;
  const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    let p = cache.get(key) as Promise<T> | undefined;
    if (!p) { p = load(); cache.set(key, p); p.catch(() => cache.delete(key)); }
    return p;
  };
  const json = <T>(url: string) => fetch(url).then(r => { if (!r.ok) throw new Error(`No se pudo descargar ${url}`); return r.json() as Promise<T>; });
  return {
    municipios: () => once('municipios', () => json<Municipio[]>(resolve('capas/municipios.json', new URL('../data/capas/municipios.json', import.meta.url).href))),
    localidades: () => once('localidades', async () => decodeLocalidades(await fetchBin(resolve('capas/localidades.bin', new URL('../data/capas/localidades.bin', import.meta.url).href)))),
    servicios: () => once('servicios', async () => decodeServicios(await fetchBin(resolve('capas/servicios.bin', new URL('../data/capas/servicios.bin', import.meta.url).href)))),
    /** localidades del catálogo de INEGI fuera del ITER y colonias del DENUE (para el buscador) */
    lugares: () => once('lugares', async () => decodeLugares(await fetchBin(resolve('capas/lugares.bin', new URL('../data/capas/lugares.bin', import.meta.url).href)))),
    /** uso del suelo y vegetación de INEGI, Serie VII (el del mapa base), por clases a ≈ 65 m */
    usv: () => once('usv', async () => decodeUsoSuelo(
      await fetchBin(resolve('capas/usv.bin', new URL('../data/capas/usv.bin', import.meta.url).href)),
      (await json<{ clases: UsoSuelo['clases'] }>(resolve('capas/usv.json', new URL('../data/capas/usv.json', import.meta.url).href))).clases, meta)),
    /** Serie VI (la anterior), en la misma rejilla y con su propia lista de clases */
    usv6: () => once('usv6', async () => decodeUsoSuelo(
      await fetchBin(resolve('capas/usv6.bin', new URL('../data/capas/usv6.bin', import.meta.url).href)),
      (await json<{ clases: UsoSuelo['clases'] }>(resolve('capas/usv6.json', new URL('../data/capas/usv6.json', import.meta.url).href))).clases, meta)),
    /** susceptibilidad de laderas (pendiente a 30 m, lluvia intensa, roca y cobertura) y el atlas estatal del CENAPRED */
    laderas: () => once('laderas', async () => {
      const [bin, info] = await Promise.all([
        fetchBin(resolve('capas/laderas.bin', new URL('../data/capas/laderas.bin', import.meta.url).href)),
        json<Omit<Laderas, 'w' | 'h' | 'f' | 'p0' | 'p1' | 'p2' | 'clase' | 'zona'>>(resolve('capas/laderas.json', new URL('../data/capas/laderas.json', import.meta.url).href)),
      ]);
      const r = new BinReader(bin);
      r.magic(0x314b4852, 'laderas.bin');
      const w = r.u32(), h = r.u32(), planes = r.u32();
      if (planes !== 3) throw new Error('laderas.bin: se esperaban 3 planos');
      const p0 = r.arr(Uint8Array, w * h), p1 = r.arr(Uint8Array, w * h), p2 = r.arr(Uint8Array, w * h);
      return { ...info, w, h, f: Math.round(w / (meta.W - 1)), p0, p1, p2, clase: p0.map(v => v & 7), zona: p2.map(v => (v >> 3) & 1) } as Laderas;
    }),
    /** radiación solar anual sobre el terreno a 90 m y el clima con que se calculó (Global Solar Atlas y NASA POWER) */
    solar: () => once('solar', async () => {
      const [bin, info] = await Promise.all([
        fetchBin(resolve('capas/solar.bin', new URL('../data/capas/solar.bin', import.meta.url).href)),
        json<Omit<Solar, 'w' | 'h' | 'f' | 'e'>>(resolve('capas/solar.json', new URL('../data/capas/solar.json', import.meta.url).href)),
      ]);
      const r = new BinReader(bin);
      r.magic(0x31454852, 'solar.bin');
      const w = r.u32(), h = r.u32(), f = r.u32();
      return { ...info, w, h, f, e: r.arr(Uint8Array, w * h) } as Solar;
    }),
    /** traslados al trabajo y a la escuela entre municipios (muestra del Censo 2020) */
    movilidad: () => once('movilidad', () => json<Movilidad>(resolve('capas/movilidad.json', new URL('../data/capas/movilidad.json', import.meta.url).href))),
    /** pendiente a 30 m resumida por nodo del visor (media, % > 15° y > 30°) */
    pendiente: () => once('pendiente', async () => decodePendiente(await fetchBin(resolve('capas/pendiente.bin', new URL('../data/capas/pendiente.bin', import.meta.url).href)))),
    /** nombres de los ríos de OSM sobre el cauce calculado a 90 m (ríos de una cuenca, camino del agua) */
    riosNombres: () => once('riosNombres', async () => decodeRiosNombres(await fetchBin(resolve('capas/rios-nombres.bin', new URL('../data/capas/rios-nombres.bin', import.meta.url).href)))),
    /** worker de rutas (red vial): se crea al primer uso y lo comparten Accesibilidad y Localidades */
    router: () => (router ??= createRouter(resolve('capas/vias.bin', new URL('../data/capas/vias.bin', import.meta.url).href), meta)),
    /** relieve a la mejor resolución (30 m donde hay teselas, si no 90 m): elevación, perfil, pendiente, flujo, cuencas */
    terrain: (): TerrainApi => { if (!terrain) throw new Error('El relieve no está disponible'); return terrain(); },
    dispose: () => { router?.dispose(); router = null; cache.clear(); },
  };
}
export type Datasets = ReturnType<typeof createDatasets>;
