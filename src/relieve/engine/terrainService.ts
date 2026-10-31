import type { Flood, FlowPath, GridKind, Profile, TerrainApi, TerrainGrid, Tower, Viewshed, Watershed } from '../shared/terrain';
import type { BuildingTile } from '../shared/buildings';
import type { DetailResult, GridMeta, TerrainMessage, TerrainOp, TerrainRequest, TilePackInfo } from '../shared/types';

export interface TerrainServiceOptions {
  /** mandar el relieve de 90 m para el sombreado */
  detail: boolean;
  /** abrir los paquetes de teselas (relieve de 30 m, imagen fina y edificios) para el detalle al acercarse */
  tiles: boolean;
  onDetail?(m: DetailResult): void;
  onWarning?(message: string): void;
}

/**
 * Cliente del worker de relieve (worker/terrain.worker.ts): uno por visor. Lo usa el motor para el relieve fino y las
 * teselas, y los análisis para sus consultas (TerrainApi), así los datos se descargan y decodifican una sola vez.
 */
export class TerrainService implements TerrainApi {
  private worker: Worker;
  private next = 1;
  private waiting = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  private closed = false;
  /** paquetes de teselas abiertos (null si no hay o no se pidieron) */
  readonly packs: Promise<{ dem: TilePackInfo | null; sat: TilePackInfo | null; bld: TilePackInfo | null }>;

  constructor(urls: Extract<TerrainRequest, { type: 'init' }>['urls'], grid: GridMeta, o: TerrainServiceOptions) {
    const worker = (this.worker = new Worker(new URL('../worker/terrain.worker.ts', import.meta.url), { type: 'module' }));
    let gotPacks: (p: { dem: TilePackInfo | null; sat: TilePackInfo | null; bld: TilePackInfo | null }) => void = () => undefined;
    this.packs = o.tiles ? new Promise(r => { gotPacks = r; }) : Promise.resolve({ dem: null, sat: null, bld: null });
    worker.onmessage = ({ data: m }: MessageEvent<TerrainMessage>) => {
      if (m.type === 'detail') o.onDetail?.(m);
      else if (m.type === 'packs') gotPacks(m);
      else if (m.type === 'error' && m.id === null) { o.onWarning?.(m.message); gotPacks({ dem: null, sat: null, bld: null }); }
      else {
        const w = m.id !== null ? this.waiting.get(m.id) : undefined;
        if (!w || m.id === null) return;
        this.waiting.delete(m.id);
        if (m.type === 'error') w.reject(new Error(m.message));
        else w.resolve((m.type === 'tile' ? (m.layer === 'dem' ? m.data : m.layer === 'bld' ? m.geom : m.bitmap) : m.value) as never);
      }
    };
    worker.onerror = e => {
      const msg = e.message || 'Falló el worker de relieve';
      o.onWarning?.(msg);
      gotPacks({ dem: null, sat: null, bld: null });
      for (const w of this.waiting.values()) w.reject(new Error(msg));
      this.waiting.clear();
    };
    worker.postMessage({ type: 'init', urls, grid, detail: o.detail, tiles: o.tiles } satisfies TerrainRequest);
  }

  private ask<T>(msg: (id: number) => TerrainRequest): Promise<T> {
    if (this.closed) return Promise.reject(new Error('El relieve ya se cerró'));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: never) => void, reject });
      this.worker.postMessage(msg(id));
    });
  }
  private query<T>(op: TerrainOp, args: Record<string, unknown>) { return this.ask<T>(id => ({ type: 'query', id, op, args })); }

  /** Tesela de 30 m (RG16: altura en cuartos de metro y normal) o de imagen (ImageBitmap); null si no hay. */
  tile(layer: 'dem', index: number): Promise<Uint16Array | null>;
  tile(layer: 'sat', index: number): Promise<ImageBitmap | null>;
  /** Edificios de una tesela: geometría de paredes y techos. */
  tile(layer: 'bld', index: number): Promise<BuildingTile | null>;
  tile(layer: 'dem' | 'sat' | 'bld', index: number) { return this.ask(id => ({ type: 'tile', id, layer, index })); }

  elevation(lon: ArrayLike<number>, lat: ArrayLike<number>) { return this.query<Float32Array>('elevation', { lon: Array.from(lon), lat: Array.from(lat) }); }
  profile(lon: number[], lat: number[], stepM?: number) { return this.query<Profile>('profile', { lon, lat, step: stepM }); }
  grid(kind: GridKind, bounds: [number, number, number, number], res: 30 | 90 = 90) { return this.query<TerrainGrid>('grid', { kind, bounds, res }); }
  watershed(lon: number, lat: number, snapM?: number) { return this.query<Watershed>('watershed', { lon, lat, snapM }); }
  flowPath(lon: number, lat: number, maxKm?: number) { return this.query<FlowPath>('flowpath', { lon, lat, maxKm }); }
  flood(lon: number, lat: number, opts: { mode?: 'rio' | 'valle'; radiusKm?: number; maxRise?: number } = {}) { return this.query<Flood>('flood', { lon, lat, ...opts }); }
  viewshed(towers: Tower[], opts: { receiver?: number; radiusKm?: number; k?: number; points?: { lon: ArrayLike<number>; lat: ArrayLike<number> } } = {}) {
    const { points, ...rest } = opts;
    return this.query<Viewshed>('viewshed', { towers, ...rest, points: points && { lon: Float32Array.from(points.lon), lat: Float32Array.from(points.lat) } });
  }

  dispose() {
    this.closed = true;
    this.worker.terminate();
    for (const w of this.waiting.values()) w.reject(new Error('El relieve ya se cerró'));
    this.waiting.clear();
  }
}
