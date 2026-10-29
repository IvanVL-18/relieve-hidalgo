import * as THREE from 'three';
import type { GridMeta } from '../shared/types';
import { PALETTE_ROW, PALETTE_ROWS, type TerrainUniforms } from './materials';

/**
 * Capa raster sobre el relieve con su propia cobertura y resolución (p. ej. una cuenca, una mancha de inundación, una
 * serie de uso de suelo). Los píxeles cubren la extensión en partes iguales; la fila 0 es la del norte.
 */
export interface RasterSpec {
  /** extensión [oeste, sur, este, norte] en grados: los bordes de los píxeles, no sus centros */
  bounds: [number, number, number, number];
  width: number;
  height: number;
  /** continuous: valor por píxel · categorical: clase 0–255 por píxel · rgba: 4 bytes sRGB por píxel */
  kind: 'continuous' | 'categorical' | 'rgba';
  data: Float32Array | Float64Array | Uint8Array | Uint16Array | Int16Array | Int32Array | Uint32Array;
  /** continuous: colores de la rampa de domain[0] a domain[1] · categorical: color por clase (null = transparente) */
  palette?: (string | null)[];
  /** continuous: valores que van al primer y último color (por omisión, mínimo y máximo de data) */
  domain?: [number, number];
  /** valor sin dato (además de NaN) */
  nodata?: number;
  /** 0–1, por omisión 0.85 */
  opacity?: number;
  /** suaviza (bilineal o bordes de clase suaves); false = píxeles nítidos. Por omisión true */
  smooth?: boolean;
  /** lado de la cortina de comparación (MapApi.compare); por omisión ambos */
  side?: 'both' | 'left' | 'right';
}

export interface RasterHandle {
  readonly kind: 'raster';
  readonly spec: RasterSpec;
  /** reemplaza los valores (mismo tamaño); domain opcional para la rampa */
  setData(data: RasterSpec['data'], domain?: [number, number]): void;
  setPalette(palette: (string | null)[], domain?: [number, number]): void;
  setOpacity(opacity: number): void;
  setSide(side: 'both' | 'left' | 'right'): void;
  setVisible(visible: boolean): void;
  /** valor en lon/lat (el del píxel), o null fuera de la capa o sin dato */
  valueAt(lon: number, lat: number): number | null;
  dispose(): void;
}

/** Color CSS a RGBA sRGB (0–255): #rgb, #rrggbb, #rrggbbaa, rgb()/rgba() o nombre; null o «transparent» = transparente. */
export function cssToRgba(c: string | null | undefined): [number, number, number, number] {
  if (!c || c === 'transparent') return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{3,8})$/i.exec(c.trim());
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map(x => x + x).join('');
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length >= 8 ? parseInt(h.slice(6, 8), 16) : 255];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(c.trim());
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return [p[0], p[1], p[2], Math.round((p[3] ?? 1) * 255)].map(v => Math.max(0, Math.min(255, Math.round(v)))) as [number, number, number, number];
  }
  const col = new THREE.Color().setStyle(c, THREE.SRGBColorSpace).convertLinearToSRGB();
  return [Math.round(col.r * 255), Math.round(col.g * 255), Math.round(col.b * 255), 255];
}

/** Fila de 256 colores: rampa (colores repartidos parejo, interpolados en sRGB) o tabla por clase. */
export function paletteRow(palette: (string | null)[] | undefined, kind: RasterSpec['kind']): Uint8Array {
  const row = new Uint8Array(256 * 4), cols = (palette ?? ['#1b2433', '#f6d27a']).map(cssToRgba);
  if (kind === 'categorical') { cols.slice(0, 256).forEach((c, i) => row.set(c, i * 4)); return row; }
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (cols.length - 1), k = Math.min(cols.length - 2, Math.floor(t)), f = cols.length > 1 ? t - k : 0;
    const a = cols[k], b = cols[Math.min(cols.length - 1, k + 1)];
    for (let q = 0; q < 4; q++) row[i * 4 + q] = Math.round(a[q] + (b[q] - a[q]) * f);
  }
  return row;
}

const isNo = (v: number, nodata?: number) => Number.isNaN(v) || v === nodata;

class RasterLayer implements RasterHandle {
  readonly kind = 'raster';
  texture: THREE.DataTexture;
  visible = true;

  constructor(readonly spec: RasterSpec, private owner: Rasters) {
    this.texture = this.build();
  }

  /** Textura: rgba = RGBA8 sRGB; continuous = RG8 (valor 0–255 en la rampa, válido); categorical = R8 (clase). */
  build(): THREE.DataTexture {
    const s = this.spec, n = s.width * s.height;
    if (s.data.length < (s.kind === 'rgba' ? n * 4 : n)) throw new Error('La capa raster tiene menos datos que width × height');
    let tex: THREE.DataTexture;
    if (s.kind === 'rgba') {
      tex = new THREE.DataTexture(Uint8Array.from(s.data as ArrayLike<number>), s.width, s.height, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
    } else if (s.kind === 'categorical') {
      const d = new Uint8Array(n);
      for (let i = 0; i < n; i++) { const v = s.data[i]; d[i] = isNo(v, s.nodata) ? 0 : Math.max(0, Math.min(255, Math.round(v))); }
      tex = new THREE.DataTexture(d, s.width, s.height, THREE.RedFormat);
    } else {
      let [lo, hi] = s.domain ?? [Infinity, -Infinity];
      if (!s.domain) for (let i = 0; i < n; i++) { const v = s.data[i]; if (!isNo(v, s.nodata)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      if (!(hi > lo)) hi = lo + 1;
      const d = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) {
        const v = s.data[i];
        if (isNo(v, s.nodata)) continue;
        d[i * 2] = Math.round(Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 255);
        d[i * 2 + 1] = 255;
      }
      // los píxeles sin dato toman el valor de un vecino válido: al suavizar, la orilla no se tiñe del primer color
      for (let i = 0; i < n; i++) {
        if (d[i * 2 + 1]) continue;
        const x = i % s.width, y = (i / s.width) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= s.width || yy >= s.height) continue;
          const j = yy * s.width + xx;
          if (d[j * 2 + 1]) { d[i * 2] = d[j * 2]; break; }
        }
      }
      tex = new THREE.DataTexture(d, s.width, s.height, THREE.RGFormat);
    }
    const smooth = s.smooth !== false && s.kind !== 'categorical';
    tex.minFilter = tex.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
  }

  setData(data: RasterSpec['data'], domain?: [number, number]) {
    Object.assign(this.spec, { data }, domain ? { domain } : {});
    const old = this.texture;
    this.texture = this.build();
    old.dispose();
    this.owner.refresh(this);
  }
  setPalette(palette: (string | null)[], domain?: [number, number]) {
    this.spec.palette = palette;
    if (domain) { this.spec.domain = domain; this.setData(this.spec.data); } else this.owner.refresh(this);
  }
  setOpacity(opacity: number) { this.spec.opacity = opacity; this.owner.refresh(this); }
  setSide(side: 'both' | 'left' | 'right') { this.spec.side = side; this.owner.refresh(this); }
  setVisible(v: boolean) { this.visible = v; this.owner.refresh(this); }

  valueAt(lon: number, lat: number) {
    const s = this.spec, [w, so, e, no] = s.bounds;
    const x = Math.floor(((lon - w) / (e - w)) * s.width), y = Math.floor(((no - lat) / (no - so)) * s.height);
    if (x < 0 || y < 0 || x >= s.width || y >= s.height) return null;
    if (s.kind === 'rgba') return null;
    const v = s.data[y * s.width + x];
    return isNo(v, s.nodata) ? null : v;
  }

  dispose() { this.owner.remove(this); this.texture.dispose(); }
}

/**
 * Ranuras de capas raster del sombreador del terreno (2: suficientes para comparar dos series con la cortina). Al
 * cambiar el número de ranuras ocupadas se recompila el sombreador (onSlots).
 */
export class Rasters {
  static readonly SLOTS = 2;
  private slots: (RasterLayer | null)[] = [null, null];

  constructor(private u: TerrainUniforms, private palette: THREE.DataTexture, private grid: GridMeta, private onSlots: (used: number) => void, private changed: () => void) {}

  add(spec: RasterSpec): RasterHandle {
    const k = this.slots.indexOf(null);
    if (k < 0) throw new Error(`Solo caben ${Rasters.SLOTS} capas raster a la vez`);
    const layer = new RasterLayer({ ...spec }, this);
    this.slots[k] = layer;
    this.refresh(layer);
    this.onSlots(this.used);
    return layer;
  }

  /** Ranuras hasta la última ocupada (el sombreador compila ese número). */
  get used() { let n = 0; this.slots.forEach((s, i) => { if (s) n = i + 1; }); return n; }

  refresh(layer: RasterLayer) {
    const k = this.slots.indexOf(layer);
    if (k < 0) return;
    const s = layer.spec, g = this.grid, [w, so, e, no] = s.bounds, u = this.u;
    const tex = (k === 0 ? u.tR0 : u.tR1), map = (k === 0 ? u.uR0Map : u.uR1Map).value, par = (k === 0 ? u.uR0Par : u.uR1Par).value;
    tex.value = layer.texture;
    (k === 0 ? u.uR0Size : u.uR1Size).value.set(s.width, s.height);
    map.set((g.lon0 - w) / (e - w), ((g.W - 1) * g.step) / (e - w), (no - g.lat0) / (no - so), ((g.H - 1) * g.step) / (no - so));
    par.set(s.kind === 'rgba' ? 0 : s.kind === 'continuous' ? 1 : 2, layer.visible ? Math.max(0, Math.min(1, s.opacity ?? 0.85)) : 0, s.side === 'left' ? 1 : s.side === 'right' ? 2 : 0, s.smooth === false ? 0 : 1);
    const row = k === 0 ? PALETTE_ROW.raster0 : PALETTE_ROW.raster1;
    (this.palette.image.data as Uint8Array).set(paletteRow(s.palette, s.kind), row * 256 * 4);
    this.palette.needsUpdate = true;
    this.changed();
  }

  remove(layer: RasterLayer) {
    const k = this.slots.indexOf(layer);
    if (k < 0) return;
    this.slots[k] = null;
    (k === 0 ? this.u.uR0Par : this.u.uR1Par).value.y = 0;
    this.onSlots(this.used);
    this.changed();
  }

  dispose() { for (const s of this.slots) s?.dispose(); }
}

/** Palette compartida inicial: 256 × PALETTE_ROWS RGBA sRGB, con la rampa de altitud en su fila. */
export function makePalette(altStops: [number, string][], altMax: number) {
  const data = new Uint8Array(256 * PALETTE_ROWS * 4), row = PALETTE_ROW.alt * 256 * 4;
  const stops = altStops.map(([m, c]) => [m, cssToRgba(c)] as const);
  for (let i = 0; i < 256; i++) {
    const e = (i / 255) * altMax;
    let k = 1;
    while (k < stops.length - 1 && e > stops[k][0]) k++;
    const [m0, c0] = stops[k - 1], [m1, c1] = stops[k], t = Math.max(0, Math.min(1, (e - m0) / (m1 - m0)));
    for (let q = 0; q < 3; q++) data[row + i * 4 + q] = Math.round(c0[q] + (c1[q] - c0[q]) * t);
    data[row + i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, 256, PALETTE_ROWS, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Cortina para comparar: línea vertical arrastrable sobre el mapa (también con flechas del teclado). */
export class Curtain {
  readonly el: HTMLDivElement;
  private handle: HTMLButtonElement;
  private labels: [HTMLSpanElement, HTMLSpanElement];
  private listeners = new Set<(x: number) => void>();
  position: number;

  constructor(host: HTMLElement, position: number, labels: [string, string], private moved: () => void) {
    this.position = Math.max(0.02, Math.min(0.98, position));
    const el = (this.el = document.createElement('div'));
    el.className = 'rh-curtain';
    const l = document.createElement('span'), r = document.createElement('span');
    l.className = 'rh-curtain-l rh-mono'; r.className = 'rh-curtain-r rh-mono';
    this.labels = [l, r];
    const h = (this.handle = document.createElement('button'));
    h.type = 'button';
    h.className = 'rh-curtain-h';
    h.setAttribute('role', 'slider');
    h.setAttribute('aria-valuemin', '0');
    h.setAttribute('aria-valuemax', '100');
    h.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l-6 6 6 6M15 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    el.append(l, r, h);
    host.appendChild(el);
    this.setLabels(...labels);
    let drag = false;
    const go = (cx: number) => { const b = host.getBoundingClientRect(); this.set((cx - b.left) / b.width); };
    h.addEventListener('pointerdown', e => { drag = true; h.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); });
    h.addEventListener('pointermove', e => { if (drag) go(e.clientX); });
    h.addEventListener('pointerup', () => { drag = false; });
    h.addEventListener('pointercancel', () => { drag = false; });
    h.addEventListener('keydown', e => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowLeft') this.set(this.position - step);
      else if (e.key === 'ArrowRight') this.set(this.position + step);
      else return;
      e.preventDefault();
    });
    this.place();
  }

  setLabels(left: string, right: string) {
    this.labels[0].textContent = left; this.labels[1].textContent = right;
    this.labels[0].hidden = !left; this.labels[1].hidden = !right;
    this.handle.setAttribute('aria-label', left && right ? `Comparar: ${left} a la izquierda, ${right} a la derecha` : 'Cortina de comparación');
  }

  set(x: number) {
    this.position = Math.max(0.02, Math.min(0.98, x));
    this.place();
    for (const fn of this.listeners) fn(this.position);
    this.moved();
  }

  private place() {
    this.el.style.left = `${(this.position * 100).toFixed(2)}%`;
    this.handle.setAttribute('aria-valuenow', String(Math.round(this.position * 100)));
  }

  onChange(fn: (x: number) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  dispose() { this.el.remove(); this.listeners.clear(); }
}
