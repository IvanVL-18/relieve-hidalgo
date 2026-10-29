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
    /** worker de rutas (red vial): se crea al primer uso y lo comparten Accesibilidad y Localidades */
    router: () => (router ??= createRouter(resolve('capas/vias.bin', new URL('../data/capas/vias.bin', import.meta.url).href), meta)),
    /** relieve a la mejor resolución (30 m donde hay teselas, si no 90 m): elevación, perfil, pendiente, flujo, cuencas */
    terrain: (): TerrainApi => { if (!terrain) throw new Error('El relieve no está disponible'); return terrain(); },
    dispose: () => { router?.dispose(); router = null; cache.clear(); },
  };
}
export type Datasets = ReturnType<typeof createDatasets>;
