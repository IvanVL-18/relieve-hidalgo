import * as THREE from 'three';

/**
 * Relieve con niveles de detalle (CDLOD, Strugar 2009): un árbol cuaternario sobre la rejilla del visor elige parches de
 * N × N cuadros más densos cerca de la cámara. Todos los parches son la misma malla instanciada; el sombreador de vértices
 * los coloca, les pone la altura (heights.ts) y, cerca del límite de su rango, funde los vértices impares con los pares
 * para coincidir con el nivel vecino más grueso: sin grietas ni saltos.
 *
 * Unidades: celdas de la rejilla del visor (≈ 270 m) para posiciones; km (altura exagerada) para distancias.
 */
export interface LodOptions {
  /** nivel más fino (8 → cuadros de 1/8 de celda ≈ 34 m) */
  depth: number;
  /** rango del nivel más fino en km; cada nivel más grueso dobla el anterior */
  range: number;
  /** cuadros por lado de cada parche */
  n: number;
}

const ROOT = 1024;            // celdas por lado del nodo raíz (potencia de 2 ≥ la rejilla)
const MARGIN_M = 400;         // holgura vertical de las cajas: el relieve fino se sale del promedio de 270 m
const MAX_INSTANCES = 16384;  // Máxima (nivel 9, más denso) llega a ~6 000 parches

/** Malla de un parche: (n + 1)² vértices con x = i, z = j (índices); las instancias dan origen y espaciado. */
function patchGeometry(n: number) {
  const g = new THREE.InstancedBufferGeometry(), v = n + 1;
  const pos = new Float32Array(v * v * 3), idx = new Uint32Array(n * n * 6);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const k = (j * v + i) * 3; pos[k] = i; pos[k + 2] = j; }
  let t = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * v + i, b = a + 1, c = a + v, d = c + 1;
    // hacia arriba (+y): (i, j) → (i, j + 1) → (i + 1, j)
    idx[t++] = a; idx[t++] = c; idx[t++] = b;
    idx[t++] = b; idx[t++] = c; idx[t++] = d;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  /** origen (columna, fila), celdas por cuadro, inicio del fundido (km) */
  const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 4), 4).setUsage(THREE.DynamicDrawUsage);
  /** fin del fundido (km) */
  const m = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES), 1).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aPatch', a);
  g.setAttribute('aMorph', m);
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

interface Level { n: number; size: number; min: Float32Array; max: Float32Array; state: Uint8Array }

export interface GridFrame {
  /** km del nodo (0, 0) y km por celda */
  x0: number; z0: number; sx: number; sz: number;
}

export class TerrainLod {
  readonly view = new THREE.Group();
  readonly caster: THREE.Mesh;
  private full: THREE.Mesh;
  private quarter: THREE.Mesh;
  private levels: Level[] = [];
  private ranges: number[] = [];
  private frame: GridFrame = { x0: 0, z0: 0, sx: 1, sz: 1 };
  /** relieve y celdas del estado (para rehacer los niveles si cambia la profundidad) */
  private data: { elev: Float32Array; state: Uint8Array; W: number; H: number } | null = null;
  private casterCount = 0;
  private box = new THREE.Box3();
  private count = { full: 0, quarter: 0 };
  /** parches dibujados en el último cuadro */
  stats = { full: 0, quarter: 0 };

  /** Las mallas se crean sin datos (para compilar los sombreadores mientras llegan); setData pone el relieve. */
  constructor(material: THREE.Material, casterMaterial: THREE.Material, casterDepth: THREE.Material, private opt: LodOptions) {
    this.setRanges();
    this.full = new THREE.Mesh(patchGeometry(opt.n), material);
    this.quarter = new THREE.Mesh(patchGeometry(opt.n / 2), material);
    for (const m of [this.full, this.quarter]) {
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.castShadow = false;
      this.view.add(m);
    }
    // sombra estática: todo el estado con parches de 32 celdas (cuadros de 1 celda) y solo el relieve de 270 m.
    // No se dibuja en la pasada normal (0 instancias); solo mientras se calcula la sombra.
    const cg = patchGeometry(32);
    this.caster = new THREE.Mesh(cg, casterMaterial);
    this.caster.customDepthMaterial = casterDepth;
    this.caster.castShadow = true;
    this.caster.receiveShadow = false;
    this.caster.frustumCulled = false;
    this.caster.onBeforeShadow = () => { cg.instanceCount = this.casterCount; };
    this.caster.onAfterShadow = () => { cg.instanceCount = 0; };
  }

  private setRanges() {
    const D = this.opt.depth;
    this.ranges = [];
    for (let d = 0; d <= D; d++) this.ranges.push(this.opt.range * 2 ** (D - d));
  }

  /** Cambia la profundidad del árbol o el rango del nivel más fino (calidad de imagen); la próxima update() los usa. */
  setOptions(o: Partial<Pick<LodOptions, 'depth' | 'range'>>) {
    const depth = o.depth ?? this.opt.depth;
    this.opt = { ...this.opt, ...o };
    this.setRanges();
    if (this.data && depth !== this.levels.length - 1) this.setData(this.frame, this.data.elev, this.data.state, this.data.W, this.data.H);
  }

  /** Relieve de 270 m y celdas del estado (con margen): cajas de cada nivel e instancias de la sombra. */
  setData(frame: GridFrame, elev: Float32Array, state: Uint8Array, W: number, H: number) {
    this.frame = frame;
    this.data = { elev, state, W, H };
    this.levels = [];
    const D = this.opt.depth;
    // cajas por nivel: del más fino (nodos de ROOT / 2^D celdas) hacia la raíz
    const nD = 2 ** D, sD = ROOT / nD;
    const fine: Level = { n: nD, size: sD, min: new Float32Array(nD * nD).fill(Infinity), max: new Float32Array(nD * nD).fill(-Infinity), state: new Uint8Array(nD * nD) };
    for (let j = 0; j < nD; j++) for (let i = 0; i < nD; i++) {
      const c0 = i * sD, r0 = j * sD;
      if (c0 > W - 1 || r0 > H - 1) continue;
      let lo = Infinity, hi = -Infinity, st = 0;
      for (let r = r0; r <= Math.min(H - 1, r0 + sD); r++) for (let c = c0; c <= Math.min(W - 1, c0 + sD); c++) {
        const e = elev[r * W + c];
        if (e < lo) lo = e;
        if (e > hi) hi = e;
        st |= state[r * W + c];
      }
      const k = j * nD + i;
      fine.min[k] = lo; fine.max[k] = hi; fine.state[k] = st;
    }
    this.levels[D] = fine;
    for (let d = D - 1; d >= 0; d--) {
      const c = this.levels[d + 1], n = 2 ** d, L: Level = { n, size: ROOT / n, min: new Float32Array(n * n), max: new Float32Array(n * n), state: new Uint8Array(n * n) };
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const k = j * n + i, a = 2 * j * c.n + 2 * i, b = a + c.n;
        L.min[k] = Math.min(c.min[a], c.min[a + 1], c.min[b], c.min[b + 1]);
        L.max[k] = Math.max(c.max[a], c.max[a + 1], c.max[b], c.max[b + 1]);
        L.state[k] = c.state[a] | c.state[a + 1] | c.state[b] | c.state[b + 1];
      }
      this.levels[d] = L;
    }
    const cg = this.caster.geometry, ca = cg.getAttribute('aPatch') as THREE.InstancedBufferAttribute, cm = cg.getAttribute('aMorph') as THREE.InstancedBufferAttribute;
    const n5 = ROOT / 32, L5 = this.levelOfSize(32);
    let nc = 0;
    for (let j = 0; j < n5; j++) for (let i = 0; i < n5; i++) {
      if (!L5.state[j * n5 + i] || nc >= MAX_INSTANCES) continue;
      ca.setXYZW(nc, i * 32, j * 32, 1, 1e9); cm.setX(nc, 1e9); nc++;
    }
    ca.needsUpdate = cm.needsUpdate = true;
    this.casterCount = nc;
  }

  private levelOfSize(size: number) { return this.levels.find(l => l.size === size) ?? this.levels[this.levels.length - 1]; }

  /** Alturas mínima y máxima (m, del relieve de 270 m) del cuadro de size celdas en (i, j); size, potencia de 2 ≥ el nodo más fino. */
  bounds(size: number, i: number, j: number): [number, number] {
    const L = this.levelOfSize(size), k = Math.min(L.n - 1, j) * L.n + Math.min(L.n - 1, i);
    return [L.min[k], L.max[k]];
  }

  /**
   * Elige los parches para la cámara. camE: cámara en km locales con la altura exagerada; frustum en coordenadas del
   * mundo; unit: unidades de escena por km; ex: exageración vertical.
   */
  update(camE: THREE.Vector3, frustum: THREE.Frustum, unit: number, ex: number) {
    if (!this.levels.length) return;
    this.count.full = this.count.quarter = 0;
    const F = this.frame, D = this.opt.depth, R = this.ranges, box = this.box;
    const fa = this.full.geometry.getAttribute('aPatch') as THREE.InstancedBufferAttribute, fm = this.full.geometry.getAttribute('aMorph') as THREE.InstancedBufferAttribute;
    const qa = this.quarter.geometry.getAttribute('aPatch') as THREE.InstancedBufferAttribute, qm = this.quarter.geometry.getAttribute('aMorph') as THREE.InstancedBufferAttribute;
    const N = this.opt.n;
    const add = (d: number, c0: number, r0: number, quarter: boolean) => {
      const size = ROOT / 2 ** d, start = d === 0 ? 1e9 : R[d] * 0.7, end = d === 0 ? 1e9 : R[d] * 0.98;
      if (quarter) {
        if (this.count.quarter >= MAX_INSTANCES) return;
        qa.setXYZW(this.count.quarter, c0, r0, size / N, start); qm.setX(this.count.quarter++, end);
      } else {
        if (this.count.full >= MAX_INSTANCES) return;
        fa.setXYZW(this.count.full, c0, r0, size / N, start); fm.setX(this.count.full++, end);
      }
    };
    /** distancia (km) de la cámara a la caja del nodo; también deja la caja en coordenadas del mundo */
    const dist = (L: Level, i: number, j: number) => {
      const k = j * L.n + i, x0 = F.x0 + i * L.size * F.sx, x1 = x0 + L.size * F.sx, z0 = F.z0 + j * L.size * F.sz, z1 = z0 + L.size * F.sz;
      const y0 = ((L.min[k] - MARGIN_M) / 1000) * ex, y1 = ((L.max[k] + MARGIN_M) / 1000) * ex;
      box.min.set(x0 * unit, y0 * unit, z0 * unit);
      box.max.set(x1 * unit, y1 * unit, z1 * unit);
      const dx = Math.max(x0 - camE.x, 0, camE.x - x1), dy = Math.max(y0 - camE.y, 0, camE.y - y1), dz = Math.max(z0 - camE.z, 0, camE.z - z1);
      return Math.hypot(dx, dy, dz);
    };
    const visit = (d: number, i: number, j: number): boolean => {
      const L = this.levels[d];
      if (!L.state[j * L.n + i]) return true;
      const dd = dist(L, i, j);
      if (dd > R[d]) return false;
      if (!frustum.intersectsBox(box)) return true;
      const c0 = i * L.size, r0 = j * L.size;
      if (d === D || dd > R[d + 1]) { add(d, c0, r0, false); return true; }
      for (let q = 0; q < 4; q++) {
        const ci = 2 * i + (q & 1), cj = 2 * j + (q >> 1);
        if (!visit(d + 1, ci, cj)) add(d, c0 + (q & 1) * (L.size / 2), r0 + (q >> 1) * (L.size / 2), true);
      }
      return true;
    };
    if (!visit(0, 0, 0)) add(0, 0, 0, false);
    fa.addUpdateRange(0, this.count.full * 4); fm.addUpdateRange(0, this.count.full);
    qa.addUpdateRange(0, this.count.quarter * 4); qm.addUpdateRange(0, this.count.quarter);
    fa.needsUpdate = fm.needsUpdate = qa.needsUpdate = qm.needsUpdate = true;
    (this.full.geometry as THREE.InstancedBufferGeometry).instanceCount = this.count.full;
    (this.quarter.geometry as THREE.InstancedBufferGeometry).instanceCount = this.count.quarter;
    this.stats = { ...this.count };
  }

  dispose() {
    for (const m of [this.full, this.quarter, this.caster]) m.geometry.dispose();
  }
}
