import type { Meta } from '../../shared/types';

export interface RouteResult {
  minutes: number;
  km: number;
  /** carreteras principales del trayecto (las de más kilómetros) */
  roads: string[];
  lon: Float32Array;
  lat: Float32Array;
  /** índice del servicio de destino en la lista enviada a compute (−1 en rutas A → B) */
  source: number;
}

export interface RoadLines { lon: Float32Array; lat: Float32Array; start: Uint32Array; len: Uint32Array; cls: Uint8Array }

export type RouterRequest =
  | { type: 'init'; url: string; grid: { W: number; H: number; step: number; lon0: number; lat0: number; kx: number; kz: number } }
  | { type: 'compute'; key: string; lon: Float32Array; lat: Float32Array; locLon: Float32Array; locLat: Float32Array }
  | { type: 'route'; id: number; lon: number; lat: number }
  | { type: 'routeAB'; id: number; a: [number, number]; b: [number, number] };

export type RouterResponse =
  | { type: 'ready'; nodes: number; edges: number; kmByClass: number[]; lines: RoadLines }
  | { type: 'computed'; key: string; cellMin: Uint16Array; locMin: Float32Array }
  | { type: 'route'; id: number; result: RouteResult | null }
  | { type: 'error'; message: string };

export interface Computed { cellMin: Uint16Array; locMin: Float32Array }

/**
 * Cliente del worker de rutas. Uno por visor: lo comparten Accesibilidad y Localidades, y recuerda el último
 * cálculo por clave para no repetirlo al cambiar de análisis.
 */
export function createRouter(url: string, meta: Meta) {
  const worker = new Worker(new URL('./routing.worker.ts', import.meta.url), { type: 'module' });
  const latC = meta.lat0 - ((meta.H - 1) * meta.step) / 2;
  let nextId = 1, error: string | null = null;
  const waiting = new Map<number | string, (r: RouterResponse) => void>();
  const failAll = (msg: string) => { error = msg; for (const f of waiting.values()) f({ type: 'error', message: msg }); waiting.clear(); };
  worker.onmessage = ({ data }: MessageEvent<RouterResponse>) => {
    const key = data.type === 'ready' ? 'ready' : data.type === 'computed' ? 'c:' + data.key : data.type === 'route' ? data.id : null;
    if (data.type === 'error') return failAll(data.message);
    const f = key !== null ? waiting.get(key) : undefined;
    if (f) { waiting.delete(key!); f(data); }
  };
  worker.onerror = e => failAll(e.message || 'Falló el cálculo de rutas');
  const ask = <T extends RouterResponse>(key: number | string, msg: RouterRequest, transfer: Transferable[] = []) => new Promise<T>((resolve, reject) => {
    if (error) return reject(new Error(error));
    waiting.set(key, r => (r.type === 'error' ? reject(new Error(r.message)) : resolve(r as T)));
    worker.postMessage(msg, transfer);
  });
  const ready = ask<Extract<RouterResponse, { type: 'ready' }>>('ready', {
    type: 'init', url,
    grid: { W: meta.W, H: meta.H, step: meta.step, lon0: meta.lon0, lat0: meta.lat0, kx: 111.32 * Math.cos((latC * Math.PI) / 180), kz: 110.57 },
  });
  // el worker guarda solo el último cálculo (lo usan las rutas): se reutiliza si la clave no cambió
  let lastKey = '', last: Promise<Computed | void> = Promise.resolve();
  return {
    ready,
    /** tiempos desde los servicios dados a cada celda y a cada localidad; queda guardado para route() */
    compute(key: string, lon: Float32Array, lat: Float32Array, locLon: Float32Array, locLat: Float32Array): Promise<Computed> {
      const run = () => ready.then(() => ask<Extract<RouterResponse, { type: 'computed' }>>('c:' + key, { type: 'compute', key, lon, lat, locLon, locLat }))
        .then(r => ({ cellMin: r.cellMin, locMin: r.locMin }));
      if (lastKey !== key) { lastKey = key; last = run(); }
      return last as Promise<Computed>;
    },
    route(lon: number, lat: number) {
      return last.then(() => ask<Extract<RouterResponse, { type: 'route' }>>(nextId, { type: 'route', id: nextId++, lon, lat })).then(r => r.result);
    },
    routeAB(a: [number, number], b: [number, number]) {
      return ready.then(() => ask<Extract<RouterResponse, { type: 'route' }>>(nextId, { type: 'routeAB', id: nextId++, a, b })).then(r => r.result);
    },
    dispose() { worker.terminate(); failAll('cerrado'); },
  };
}
export type Router = ReturnType<typeof createRouter>;
