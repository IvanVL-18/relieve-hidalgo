import * as THREE from 'three';
import type { TilePackInfo } from '../shared/types';

/**
 * Teselas de detalle en un atlas de la GPU (texturas virtuales): cada tesela cargada ocupa una ranura y su página
 * (una textura chica, una celda por tesela) dice en qué ranura está y cuánto ha aparecido. Las que ya no hacen falta se
 * reemplazan por las más cercanas a la cámara cuando el atlas se llena.
 */
export interface TileSetOptions<T> {
  info: TilePackInfo;
  /** texeles por lado de cada ranura */
  slotPx: number;
  /** ranuras por lado del atlas */
  slots: number;
  atlas: THREE.Texture;
  /** textura de páginas compartida (RGBA8) y la fila donde empiezan las de este juego */
  pages: THREE.DataTexture;
  pageRow: number;
  /** peticiones simultáneas */
  concurrency: number;
  load(index: number): Promise<T | null>;
  /** sube la tesela a la ranura (x, y) del atlas */
  upload(payload: T, x: number, y: number): void;
  onResident?(index: number, payload: T): void;
  onEvict?(index: number): void;
  /** algo cambió y hay que dibujar */
  onChange(): void;
  /** reloj de los fundidos (ms; el del motor, que al grabar avanza cuadro por cuadro) */
  now?(): number;
}

interface Slot { index: number; x: number; y: number; t0: number; used: number }

const FADE_MS = 500;

export class TileSet<T> {
  private resident = new Map<number, Slot>();
  private pending = new Set<number>();
  private free: [number, number][] = [];
  private fading = 0;
  private alive = true;
  /** teselas deseadas en la última actualización (índice → prioridad) */
  private want = new Map<number, number>();
  private failed = new Set<number>();
  failures = 0;

  constructor(private o: TileSetOptions<T>) {
    for (let y = o.slots - 1; y >= 0; y--) for (let x = o.slots - 1; x >= 0; x--) this.free.push([x, y]);
  }

  get info() { return this.o.info; }
  get count() { return this.resident.size; }
  /** la tesela ya está en el atlas (o no se pudo bajar: no se espera por ella) */
  ready(i: number) { return this.resident.has(i) || this.failed.has(i); }
  /** no queda nada en camino de lo deseado: todo cargado o el atlas lleno de teselas deseadas */
  get settled() {
    if (this.pending.size) return false;
    for (const i of this.want.keys()) if (!this.ready(i)) return !this.free.length && ![...this.resident.values()].some(s => !this.want.has(s.index));
    return true;
  }

  /** Pide las teselas deseadas (índice → prioridad; menor = más urgente) y libera ranuras si hace falta. */
  update(want: Map<number, number>, now: number) {
    this.want = want;
    for (const [i, s] of this.resident) if (want.has(i)) s.used = now;
    const order = [...want].filter(([i]) => !this.resident.has(i) && !this.pending.has(i)).sort((a, b) => a[1] - b[1]);
    for (const [i] of order) {
      if (this.pending.size >= this.o.concurrency) break;
      // sin ranura libre: se reemplaza la menos usada que ya no se quiere
      if (!this.free.length && !this.evictOne()) break;
      this.request(i);
    }
  }

  private evictOne() {
    let worst: Slot | null = null;
    for (const s of this.resident.values()) if (!this.want.has(s.index) && (!worst || s.used < worst.used)) worst = s;
    if (!worst) return false;
    this.drop(worst);
    return true;
  }

  private drop(s: Slot) {
    this.resident.delete(s.index);
    this.free.push([s.x, s.y]);
    this.setPage(s.index, 0, 0, 0, 0);
    this.o.onEvict?.(s.index);
  }

  private request(i: number) {
    this.pending.add(i);
    this.o.load(i).then(p => {
      this.pending.delete(i);
      if (!this.alive) return;
      if (!p) { this.failed.add(i); return; }
      if (!this.free.length && !this.evictOne()) return;
      const [x, y] = this.free.pop()!;
      this.o.upload(p, x * this.o.slotPx, y * this.o.slotPx);
      const now = this.o.now?.() ?? performance.now();
      this.failed.delete(i);
      this.resident.set(i, { index: i, x, y, t0: now, used: now });
      this.setPage(i, x, y, 0, 255);
      this.fading++;
      this.o.onResident?.(i, p);
      this.o.onChange();
    }, () => { this.pending.delete(i); this.failed.add(i); this.failures++; });
  }

  private setPage(i: number, x: number, y: number, fade: number, on: number) {
    const { nx } = this.o.info, p = this.o.pages, d = p.image.data as Uint8Array;
    const k = ((this.o.pageRow + Math.floor(i / nx)) * (p.image.width) + (i % nx)) * 4;
    d[k] = x; d[k + 1] = y; d[k + 2] = fade; d[k + 3] = on;
    p.needsUpdate = true;
  }

  /** Avanza la aparición de las teselas nuevas; true mientras haya alguna en curso. */
  animate(now: number) {
    if (!this.fading) return false;
    let n = 0;
    for (const s of this.resident.values()) {
      const t = (now - s.t0) / FADE_MS;
      if (t >= 1.2) continue;
      n++;
      const e = Math.min(1, t), v = Math.round(255 * e * e * (3 - 2 * e));
      this.setPage(s.index, s.x, s.y, v, 255);
    }
    this.fading = n;
    return n > 0;
  }

  dispose() { this.alive = false; }
}
