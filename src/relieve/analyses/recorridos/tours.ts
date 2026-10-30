/**
 * Recorridos guiados: paradas en recorridos.json con el mismo formato que los enlaces a vistas (para agregar una parada
 * basta copiar el enlace de una vista con el botón del riel y pegar su consulta en «enlace»). Lo usan el análisis de
 * recorridos y el de video.
 */
import type { MapApi } from '../../engine/mapApi';
import type { View } from '../../shared/enlaces';
import { decodeViewState } from '../../shared/enlaces';
import { makeGeo } from '../../shared/geo';
import type { Meta } from '../../shared/types';
import type { SceneChange } from '../types';
import { readingSeconds, type PathEnv } from './path';
import DATA from './recorridos.json';

/** Relieve y geometría para las trayectorias (la exageración es la que tendrá la escena). */
export function pathEnv(map: MapApi, meta: Meta, ex: number): PathEnv {
  const g = makeGeo(meta);
  return { elev: (lon, lat) => map.elevationAt(lon, lat), inside: (lon, lat) => map.municipioAt(lon, lat) > 0, kx: g.KX, ky: g.KZ, ex };
}

/** Segundos en una parada: lo que diga el recorrido, o lo que toma leerla (y escucharla, con la voz). */
export const holdSeconds = (s: Stop, voice = false) => Math.max(s.seconds ?? readingSeconds(s.text), voice ? (s.title + ' ' + s.text).split(/\s+/).length / 2.4 + 2 : 0);

/** Luz de una parada según el Sol del día: la hora exacta cambia con la fecha. */
export type Luz = 'amanecer' | 'manana' | 'mediodia' | 'tarde' | 'atardecer' | 'noche';

interface ParadaJson { titulo: string; texto: string; enlace: string; luz?: string; cantidad?: number; marca?: string; segundos?: number }
interface TourJson { id: string; titulo: string; resumen: string; paradas: ParadaJson[] }

export interface Stop {
  title: string;
  text: string;
  view: View;
  /** mapa base, hora, exageración y nubes de la parada (lo que no diga se queda como estaba) */
  scene: SceneChange;
  /** nombre que se marca en el objetivo de la vista */
  mark?: string;
  /** segundos en la parada (si el JSON no lo dice, según el largo del texto) */
  seconds?: number;
}

export interface Tour { id: string; title: string; summary: string; stops: Stop[] }

/** Hora de una luz con el amanecer y el anochecer del día (horas locales). */
export function hourFor(luz: string | undefined, sun: { sunrise: number; sunset: number }) {
  switch (luz) {
    case 'amanecer': return sun.sunrise + 0.9;
    case 'manana': return sun.sunrise + 2.5;
    case 'mediodia': return 12.6;
    case 'tarde': return sun.sunset - 1.8;
    case 'atardecer': return sun.sunset - 0.3;
    case 'noche': return sun.sunset + 1.4;
    default: return undefined;
  }
}

/** Recorridos de recorridos.json listos para usar con el Sol del día. */
export function loadTours(sun: { sunrise: number; sunset: number }): Tour[] {
  return (DATA as TourJson[]).map(t => ({
    id: t.id, title: t.titulo, summary: t.resumen,
    stops: t.paradas.map(p => {
      const s = decodeViewState('?' + p.enlace.replace(/^\?/, ''));
      if (!s.view) throw new Error(`Parada «${p.titulo}» sin vista en el enlace`);
      const hour = hourFor(p.luz, sun) ?? s.hour;
      const scene: SceneChange = {};
      if (s.baseMap) scene.baseMap = s.baseMap;
      if (hour !== undefined) scene.hour = Math.min(20.5, Math.max(5, hour));
      if (s.exaggeration !== undefined) scene.exaggeration = s.exaggeration;
      if (s.clouds) {
        scene.layers = { clouds: s.clouds !== 'no' };
        if (s.clouds !== 'no' && s.clouds !== 'hoy') scene.clouds = { kind: s.clouds, play: false, amount: p.cantidad ?? 0.5 };
      }
      return { title: p.titulo, text: p.texto, view: s.view, scene, mark: p.marca, seconds: p.segundos };
    }),
  }));
}
