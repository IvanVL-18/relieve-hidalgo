import * as THREE from 'three';
import type { BuildingTile } from '../shared/buildings';
import type { TilePackInfo } from '../shared/types';

/**
 * Edificios (capas/edificios.bin): las teselas a menos de range km de la cámara y a la vista, una malla por tesela con el
 * material de createBuildingMaterial (la altura sobre el relieve la pone el sombreador). El worker de relieve arma la
 * geometría; aquí solo se suben y se sueltan las que quedan lejos.
 */
export interface BuildingsOptions {
  info: TilePackInfo;
  material: THREE.Material;
  /** km del nodo (0, 0) y km por celda */
  frame: { x0: number; z0: number; sx: number; sz: number };
  /** alturas mínima y máxima (m) del relieve de una tesela (para su caja) */
  bounds(size: number, tx: number, ty: number): [number, number];
  load(index: number): Promise<BuildingTile | null>;
  onChange(): void;
}

const UNIT = 0.01;
/** mallas que se guardan (las que salen de la vista se conservan un rato por si se vuelve) */
const KEEP = 160;

export class Buildings {
  readonly group = new THREE.Group();
  private tiles = new Map<number, { mesh: THREE.Mesh; used: number; n: number }>();
  private pending = new Set<number>();
  private failed = new Set<number>();
  private alive = true;
  private box = new THREE.Box3();
  /** km de la cámara a los que aparecen (0 = ninguno) */
  range = 0;
  /** edificios en las mallas cargadas */
  count = 0;

  constructor(private o: BuildingsOptions) {
    this.group.name = 'edificios';
  }

  /** ¿Falta alguna tesela por llegar? (para que una grabación espere) */
  get settled() { return this.pending.size === 0; }

  /**
   * Muestra las teselas a menos de range km de la cámara (camE en km, altura exagerada) y pide las que faltan: primero las
   * que están a la vista, de la más cercana a la más lejana; suelta las que sobran.
   */
  update(camE: THREE.Vector3, frustum: THREE.Frustum, ex: number, now: number) {
    const { info, frame: F } = this.o, T = info.tileCells, want: [number, number][] = [];
    const visible = new Set<number>();
    if (this.range > 0) {
      for (let ty = 0; ty < info.ny; ty++) for (let tx = 0; tx < info.nx; tx++) {
        const i = ty * info.nx + tx;
        if (!info.has[i]) continue;
        const [lo, hi] = this.o.bounds(T, tx, ty);
        const x0 = F.x0 + tx * T * F.sx, x1 = x0 + T * F.sx, z0 = F.z0 + ty * T * F.sz, z1 = z0 + T * F.sz;
        const y0 = ((lo - 400) / 1000) * ex, y1 = ((hi + 400) / 1000) * ex;
        const d = Math.hypot(Math.max(x0 - camE.x, 0, camE.x - x1), Math.max(y0 - camE.y, 0, camE.y - y1), Math.max(z0 - camE.z, 0, camE.z - z1));
        if (d > this.range) continue;
        this.box.min.set(x0 * UNIT, y0 * UNIT, z0 * UNIT);
        this.box.max.set(x1 * UNIT, y1 * UNIT, z1 * UNIT);
        // (las de fuera de la vista también se muestran: al girar no aparecen de golpe)
        visible.add(i);
        want.push([i, d + (d <= 1 || frustum.intersectsBox(this.box) ? 0 : 1000)]);
      }
    }
    for (const [i, t] of this.tiles) {
      t.mesh.visible = visible.has(i);
      if (t.mesh.visible) t.used = now;
    }
    want.sort((a, b) => a[1] - b[1]);
    for (const [i] of want) {
      if (this.pending.size >= 4) break;
      if (!this.tiles.has(i) && !this.pending.has(i) && !this.failed.has(i)) this.request(i);
    }
    // las que sobran: primero las que hace más que no se ven
    if (this.tiles.size > KEEP) {
      const old = [...this.tiles].filter(([i]) => !visible.has(i)).sort((a, b) => a[1].used - b[1].used);
      for (const [i] of old.slice(0, this.tiles.size - KEEP)) this.drop(i);
    }
  }

  private request(i: number) {
    this.pending.add(i);
    this.o.load(i).then(g => {
      this.pending.delete(i);
      if (!this.alive) return;
      if (!g || !g.n) { this.failed.add(i); return; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
      geo.setAttribute('aCenter', new THREE.BufferAttribute(g.center, 2));
      geo.setAttribute('aInfo', new THREE.BufferAttribute(g.info, 4, true));
      geo.setIndex(new THREE.BufferAttribute(g.index, 1));
      const mesh = new THREE.Mesh(geo, this.o.material);
      // (la posición la pone el sombreador: la malla no tiene caja útil; la vista se decide por tesela)
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.visible = false;
      this.group.add(mesh);
      this.tiles.set(i, { mesh, used: performance.now(), n: g.n });
      this.count += g.n;
      this.o.onChange();
    }, () => { this.pending.delete(i); this.failed.add(i); });
  }

  private drop(i: number) {
    const t = this.tiles.get(i);
    if (!t) return;
    this.group.remove(t.mesh);
    t.mesh.geometry.dispose();
    this.tiles.delete(i);
    this.count -= t.n;
  }

  /** Suelta todas las mallas (p. ej. al apagar la capa). */
  clear() { for (const i of [...this.tiles.keys()]) this.drop(i); }

  dispose() {
    this.alive = false;
    this.clear();
  }
}
