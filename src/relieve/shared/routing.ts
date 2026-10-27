/**
 * Red vial como grafo no dirigido y rutas de menor tiempo (Dijkstra con montículo binario).
 * Lo usan el worker de accesibilidad y scripts/pipeline/build-vias.mjs (Node importa este .ts: solo sintaxis borrable).
 * Coordenadas en unidades de la rejilla × 8 (≈ 31 m); tiempos en segundos.
 */

/**
 * Clases de vía de OpenStreetMap: velocidad base en terreno plano (km/h) y estilo de dibujo. Con los factores de
 * build-vias.mjs dan ≈ 50 km/h en carretera federal de sierra, ≈ 35 en camino pavimentado de sierra y 15–20 en terracería.
 */
export const ROAD_CLASSES = [
  { id: 'motorway', nombre: 'Autopista', kmh: 100, color: '#f0a04b' },
  { id: 'trunk', nombre: 'Carretera troncal', kmh: 85, color: '#f3b85a' },
  { id: 'primary', nombre: 'Carretera federal o principal', kmh: 75, color: '#f6d27a' },
  { id: 'secondary', nombre: 'Carretera estatal', kmh: 60, color: '#f2e6b4' },
  { id: 'tertiary', nombre: 'Camino pavimentado', kmh: 50, color: '#e8e8e8' },
  { id: 'unclassified', nombre: 'Camino rural', kmh: 40, color: '#c9c9c9' },
  { id: 'track', nombre: 'Terracería o brecha', kmh: 22, color: '#a08a6c' },
] as const;
export type RoadClassId = (typeof ROAD_CLASSES)[number]['id'];

/** Velocidad a pie fuera de la red (km/h). */
export const WALK_KMH = 4.5;

export interface RoadGraph {
  nNodes: number;
  nEdges: number;
  /** nodos en rejilla × 8 */
  nx: Uint16Array;
  ny: Uint16Array;
  ea: Uint32Array;
  eb: Uint32Array;
  /** segundos */
  et: Float32Array;
  /** metros */
  el: Float32Array;
  ec: Uint8Array;
  /** índice en names (0 = sin nombre) */
  en: Uint16Array;
  names: string[];
  /** geometría de dibujo por arista: inicio y número de puntos en gx/gy (rejilla × 8) */
  gs: Uint32Array;
  gl: Uint16Array;
  gx: Uint16Array;
  gy: Uint16Array;
  /** adyacencia en formato CSR */
  adjStart: Uint32Array;
  adjNode: Uint32Array;
  adjEdge: Uint32Array;
}

export function buildAdjacency(nNodes: number, ea: Uint32Array, eb: Uint32Array) {
  const deg = new Uint32Array(nNodes + 1);
  for (let e = 0; e < ea.length; e++) { deg[ea[e]]++; deg[eb[e]]++; }
  const adjStart = new Uint32Array(nNodes + 1);
  for (let i = 0; i < nNodes; i++) adjStart[i + 1] = adjStart[i] + deg[i];
  const fill = adjStart.slice(0, nNodes), adjNode = new Uint32Array(ea.length * 2), adjEdge = new Uint32Array(ea.length * 2);
  for (let e = 0; e < ea.length; e++) {
    const a = ea[e], b = eb[e];
    adjNode[fill[a]] = b; adjEdge[fill[a]++] = e;
    adjNode[fill[b]] = a; adjEdge[fill[b]++] = e;
  }
  return { adjStart, adjNode, adjEdge };
}

/**
 * Tiempo mínimo desde varias fuentes (cada una con costo inicial) a todos los nodos.
 * pred guarda la arista por la que se llegó (−1 en las fuentes), para reconstruir rutas.
 */
export function dijkstra(g: RoadGraph, sources: ArrayLike<number>, startCost: ArrayLike<number>, maxSeconds = Infinity) {
  // doble precisión: con Float32 el redondeo hace que un nodo se vuelva a expandir en cascada
  const n = g.nNodes, dist = new Float64Array(n).fill(Infinity), pred = new Int32Array(n).fill(-1), src = new Int32Array(n).fill(-1);
  // montículo binario de (costo, nodo)
  let hc = new Float64Array(1024), hn = new Uint32Array(1024), size = 0;
  const push = (c: number, v: number) => {
    if (size === hc.length) { const c2 = new Float64Array(size * 2), n2 = new Uint32Array(size * 2); c2.set(hc); n2.set(hn); hc = c2; hn = n2; }
    let i = size++;
    while (i > 0) { const p = (i - 1) >> 1; if (hc[p] <= c) break; hc[i] = hc[p]; hn[i] = hn[p]; i = p; }
    hc[i] = c; hn[i] = v;
  };
  const pop = () => {
    const v = hn[0], c = hc[--size], last = hn[size];
    let i = 0;
    for (;;) {
      let k = 2 * i + 1;
      if (k >= size) break;
      if (k + 1 < size && hc[k + 1] < hc[k]) k++;
      if (hc[k] >= c) break;
      hc[i] = hc[k]; hn[i] = hn[k]; i = k;
    }
    hc[i] = c; hn[i] = last;
    return v;
  };
  for (let s = 0; s < sources.length; s++) {
    const v = sources[s], c = startCost[s];
    if (c < dist[v]) { dist[v] = c; src[v] = s; push(c, v); }
  }
  const { adjStart, adjNode, adjEdge, et } = g;
  while (size) {
    const c0 = hc[0], v = pop();
    if (c0 > dist[v]) continue;
    if (c0 > maxSeconds) break;
    for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
      const u = adjNode[k], c = c0 + et[adjEdge[k]];
      if (c < dist[u]) { dist[u] = c; pred[u] = adjEdge[k]; src[u] = src[v]; push(c, u); }
    }
  }
  return { dist, pred, src };
}

/** Aristas de la ruta hasta el nodo v, del origen al destino. */
export function pathEdges(g: RoadGraph, pred: Int32Array, v: number) {
  const out: number[] = [];
  for (let guard = 0; pred[v] >= 0 && guard < 1e6; guard++) {
    const e = pred[v];
    out.push(e);
    v = g.ea[e] === v ? g.eb[e] : g.ea[e];
  }
  return out.reverse();
}

/** Índice espacial de nodos por cubetas de 2 × 2 celdas para encontrar el más cercano. */
export function nodeIndex(g: RoadGraph, W: number, H: number) {
  const B = 16, bw = Math.ceil((W * 8) / B), bh = Math.ceil((H * 8) / B);
  const count = new Uint32Array(bw * bh + 1);
  for (let i = 0; i < g.nNodes; i++) count[Math.min(bh - 1, (g.ny[i] / B) | 0) * bw + Math.min(bw - 1, (g.nx[i] / B) | 0) + 1]++;
  for (let k = 1; k < count.length; k++) count[k] += count[k - 1];
  const fill = count.slice(0, bw * bh), items = new Uint32Array(g.nNodes);
  for (let i = 0; i < g.nNodes; i++) items[fill[Math.min(bh - 1, (g.ny[i] / B) | 0) * bw + Math.min(bw - 1, (g.nx[i] / B) | 0)]++] = i;
  /** nodo más cercano a (x, y) en rejilla × 8, buscando en anillos de cubetas; −1 si no hay en maxRing */
  return (x: number, y: number, maxRing = 40) => {
    const bx = Math.floor(x / B), by = Math.floor(y / B);
    let best = -1, bd = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      for (let j = by - ring; j <= by + ring; j++) {
        if (j < 0 || j >= bh) continue;
        for (let i = bx - ring; i <= bx + ring; i++) {
          if (i < 0 || i >= bw || (Math.abs(i - bx) !== ring && Math.abs(j - by) !== ring)) continue;
          const k = j * bw + i;
          for (let q = count[k]; q < count[k + 1]; q++) {
            const v = items[q], d = (g.nx[v] - x) ** 2 + (g.ny[v] - y) ** 2;
            if (d < bd) { bd = d; best = v; }
          }
        }
      }
      // ya no puede haber algo más cerca que lo encontrado
      if (best >= 0 && Math.sqrt(bd) < ring * B) break;
    }
    return best;
  };
}

/** Lee vias.bin ya descomprimido (formato en scripts/pipeline/build-vias.mjs). */
export function decodeGraph(buf: Uint8Array): RoadGraph {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const take = <T>(Ctor: { new (b: ArrayBuffer): T; BYTES_PER_ELEMENT: number }, n: number): T => {
    const bytes = n * Ctor.BYTES_PER_ELEMENT;
    const a = new Ctor(buf.slice(o, o + bytes).buffer);
    o += bytes + ((4 - (bytes % 4)) % 4);
    return a;
  };
  if (u32() !== 0x31474852) throw new Error('vias.bin no es un archivo RHG1');
  const nNodes = u32(), nEdges = u32(), nPts = u32();
  const nx = take(Uint16Array, nNodes), ny = take(Uint16Array, nNodes);
  const ea = take(Uint32Array, nEdges), eb = take(Uint32Array, nEdges);
  const et = Float32Array.from(take(Uint16Array, nEdges), v => v * 0.5);
  const el = Float32Array.from(take(Uint16Array, nEdges), v => v * 2);
  const ec = take(Uint8Array, nEdges), en = take(Uint16Array, nEdges);
  const gl = take(Uint16Array, nEdges);
  const dx = take(Int8Array, nPts), dy = take(Int8Array, nPts);
  const nameBytes = u32();
  const names = new TextDecoder().decode(buf.subarray(o, o + nameBytes)).split('\n');
  const gs = new Uint32Array(nEdges), gx = new Uint16Array(nPts), gy = new Uint16Array(nPts);
  for (let e = 0, p = 0; e < nEdges; e++) {
    gs[e] = p;
    // la geometría arranca en el nodo a y sigue con desplazamientos
    let x = nx[ea[e]], y = ny[ea[e]];
    for (let k = 0; k < gl[e]; k++, p++) { x += dx[p]; y += dy[p]; gx[p] = x; gy[p] = y; }
  }
  return { nNodes, nEdges, nx, ny, ea, eb, et, el, ec, en, names, gs, gl, gx, gy, ...buildAdjacency(nNodes, ea, eb) };
}
