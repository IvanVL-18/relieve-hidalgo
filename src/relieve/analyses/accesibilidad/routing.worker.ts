import { ROAD_CLASSES, WALK_KMH, decodeGraph, dijkstra, nodeIndex, type RoadGraph } from '../../shared/routing';
import { fetchBin } from '../../worker/decode';
import type { RouteResult, RouterRequest, RouterResponse } from './router';

/**
 * Worker de accesibilidad: guarda la red vial y el último cálculo para responder rutas al instante.
 * Mensajes en router.ts.
 */
const ctx = self as unknown as { postMessage(m: RouterResponse, t?: Transferable[]): void; onmessage: ((e: MessageEvent<RouterRequest>) => void) | null };

let g: RoadGraph, nearest: (x: number, y: number, ring?: number) => number;
let grid: { W: number; H: number; step: number; lon0: number; lat0: number; kx: number; kz: number };
let cellNode: Int32Array, cellWalkS: Float32Array;
let last: { dist: Float64Array; pred: Int32Array; src: Int32Array; srcIndex: number[]; srcWalk: number[] } | null = null;

const toX = (lon: number) => ((lon - grid.lon0) / grid.step) * 8;
const toY = (lat: number) => ((grid.lat0 - lat) / grid.step) * 8;
const lonOf = (x: number) => grid.lon0 + (x / 8) * grid.step;
const latOf = (y: number) => grid.lat0 - (y / 8) * grid.step;
const walkS = (dx8: number, dy8: number) => (Math.hypot((dx8 / 8) * grid.step * grid.kx, (dy8 / 8) * grid.step * grid.kz) / WALK_KMH) * 3600;
const snap = (lon: number, lat: number) => {
  const x = toX(lon), y = toY(lat), v = nearest(x, y);
  return v < 0 ? null : { v, s: walkS(x - g.nx[v], y - g.ny[v]) };
};

/** Para cada celda, el nodo de la red más cercano y el tiempo a pie hasta él (transformada de distancia en dos pasadas). */
function cellNearest() {
  const { W, H } = grid, N = W * H;
  const node = new Int32Array(N).fill(-1), d = new Float32Array(N).fill(Infinity);
  for (let v = 0; v < g.nNodes; v++) {
    const c = Math.min(W - 1, Math.round(g.nx[v] / 8)), r = Math.min(H - 1, Math.round(g.ny[v] / 8)), i = r * W + c;
    const dd = Math.hypot(g.nx[v] / 8 - c, g.ny[v] / 8 - r);
    if (dd < d[i]) { d[i] = dd; node[i] = v; }
  }
  const D = Math.SQRT2;
  const relax = (i: number, j: number, w: number) => { if (node[j] >= 0 && d[j] + w < d[i]) { d[i] = d[j] + w; node[i] = node[j]; } };
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c;
    if (c > 0) relax(i, i - 1, 1);
    if (r > 0) { relax(i, i - W, 1); if (c > 0) relax(i, i - W - 1, D); if (c < W - 1) relax(i, i - W + 1, D); }
  }
  for (let r = H - 1; r >= 0; r--) for (let c = W - 1; c >= 0; c--) {
    const i = r * W + c;
    if (c < W - 1) relax(i, i + 1, 1);
    if (r < H - 1) { relax(i, i + W, 1); if (c < W - 1) relax(i, i + W + 1, D); if (c > 0) relax(i, i + W - 1, D); }
  }
  const cellKm = grid.step * (grid.kx + grid.kz) / 2;
  cellWalkS = Float32Array.from(d, v => (v * cellKm / WALK_KMH) * 3600);
  cellNode = node;
}

/** Ruta desde el nodo target hasta la fuente que lo alcanzó, siguiendo los predecesores del último cálculo. */
function route(target: number, extraS: number): RouteResult | null {
  if (!last || !Number.isFinite(last.dist[target])) return null;
  const lon: number[] = [], lat: number[] = [], byName = new Map<number, number>();
  let km = 0, at = target;
  for (let guard = 0; last.pred[at] >= 0 && guard < 1e6; guard++) {
    const e = last.pred[at], fromA = g.ea[e] === at, s = g.gs[e], n = g.gl[e];
    for (let k = lon.length ? 1 : 0; k < n; k++) { const p = s + (fromA ? k : n - 1 - k); lon.push(lonOf(g.gx[p])); lat.push(latOf(g.gy[p])); }
    km += g.el[e] / 1000;
    if (g.en[e]) byName.set(g.en[e], (byName.get(g.en[e]) ?? 0) + g.el[e]);
    at = fromA ? g.eb[e] : g.ea[e];
  }
  return {
    minutes: (last.dist[target] + extraS) / 60, km,
    roads: [...byName].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k]) => g.names[k]),
    lon: Float32Array.from(lon), lat: Float32Array.from(lat),
    source: last.src[target] >= 0 ? last.srcIndex[last.src[target]] : -1,
  };
}

ctx.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'init') {
      grid = m.grid;
      g = decodeGraph(await fetchBin(m.url));
      nearest = nodeIndex(g, grid.W, grid.H);
      cellNearest();
      // geometría para dibujar: una polilínea por arista, color según la clase
      const nP = g.gx.length, lon = new Float32Array(nP), lat = new Float32Array(nP);
      for (let p = 0; p < nP; p++) { lon[p] = lonOf(g.gx[p]); lat[p] = latOf(g.gy[p]); }
      const len = Uint32Array.from(g.gl), start = Uint32Array.from(g.gs), cls = Uint8Array.from(g.ec);
      const km = new Float64Array(ROAD_CLASSES.length);
      for (let e = 0; e < g.nEdges; e++) km[g.ec[e]] += g.el[e] / 1000;
      ctx.postMessage({ type: 'ready', nodes: g.nNodes, edges: g.nEdges, kmByClass: Array.from(km), lines: { lon, lat, start, len, cls } }, [lon.buffer, lat.buffer, start.buffer, len.buffer, cls.buffer]);
    } else if (m.type === 'compute') {
      const sn = Array.from({ length: m.lon.length }, (_, i) => snap(m.lon[i], m.lat[i]));
      const ok = sn.map((s, i) => (s ? i : -1)).filter(i => i >= 0);
      const r = dijkstra(g, ok.map(i => sn[i]!.v), ok.map(i => sn[i]!.s));
      last = { ...r, srcIndex: ok, srcWalk: ok.map(i => sn[i]!.s) };
      const N = cellNode.length, cellMin = new Uint16Array(N);
      for (let i = 0; i < N; i++) {
        const v = cellNode[i], t = v >= 0 ? (r.dist[v] + cellWalkS[i]) / 60 : Infinity;
        cellMin[i] = Number.isFinite(t) ? Math.min(65534, Math.round(t)) : 65535;
      }
      const locMin = new Float32Array(m.locLon.length);
      for (let i = 0; i < locMin.length; i++) {
        const s = snap(m.locLon[i], m.locLat[i]);
        locMin[i] = s ? (r.dist[s.v] + s.s) / 60 : Infinity;
      }
      ctx.postMessage({ type: 'computed', key: m.key, cellMin, locMin }, [cellMin.buffer, locMin.buffer]);
    } else if (m.type === 'route') {
      const s = snap(m.lon, m.lat);
      ctx.postMessage({ type: 'route', id: m.id, result: s ? route(s.v, s.s) : null });
    } else if (m.type === 'routeAB') {
      const a = snap(m.a[0], m.a[1]), b = snap(m.b[0], m.b[1]);
      if (!a || !b) { ctx.postMessage({ type: 'route', id: m.id, result: null }); return; }
      const keep = last;
      const r = dijkstra(g, [a.v], [a.s]);
      last = { ...r, srcIndex: [0], srcWalk: [a.s] };
      const res = route(b.v, b.s);
      last = keep;
      // la ruta va de A a B: se dibuja al revés de route()
      if (res) { res.lon.reverse(); res.lat.reverse(); }
      ctx.postMessage({ type: 'route', id: m.id, result: res });
    }
  } catch (e) {
    ctx.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
