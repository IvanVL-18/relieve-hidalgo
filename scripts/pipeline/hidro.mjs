/**
 * Hidrología sobre una rejilla de elevación: relleno de depresiones (Priority-Flood + ε, Barnes et al. 2014),
 * dirección de flujo D8, acumulación y red de cauces con orden de Strahler. Sin dependencias.
 */

/** Vecinos D8 en el orden de los códigos de dirección 0–7. */
export const D8 = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

/** Baja `depth` metros (una sola vez) las celdas que cruzan las líneas, en coordenadas de la rejilla, para guiar el flujo. */
export function burnLines(z, w, h, lines, depth) {
  const burnt = new Uint8Array(w * h);
  let n = 0;
  for (const pts of lines) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [c0, r0] = pts[k], [c1, r1] = pts[k + 1];
      const steps = Math.ceil(Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0)) * 2) + 1;
      for (let s = 0; s <= steps; s++) {
        const c = Math.round(c0 + ((c1 - c0) * s) / steps), r = Math.round(r0 + ((r1 - r0) * s) / steps);
        if (r < 0 || c < 0 || r >= h || c >= w || burnt[r * w + c]) continue;
        burnt[r * w + c] = 1; z[r * w + c] -= depth; n++;
      }
    }
  }
  return n;
}

/** Rellena depresiones: cada celda queda con al menos un camino descendente hacia el borde de la rejilla. */
export function priorityFlood(src, w, h, eps = 1e-4) {
  const n = w * h, z = Float64Array.from(src), closed = new Uint8Array(n);
  // montículo binario de mínimos sobre arreglos tipados
  const hk = new Float64Array(n), hv = new Int32Array(n);
  let hs = 0;
  const push = (k, v) => {
    let i = hs++;
    while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
    hk[i] = k; hv[i] = v;
  };
  const pop = () => {
    const top = hv[0], k = hk[--hs], v = hv[hs];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= hs) break;
      if (c + 1 < hs && hk[c + 1] < hk[c]) c++;
      if (hk[c] >= k) break;
      hk[i] = hk[c]; hv[i] = hv[c]; i = c;
    }
    hk[i] = k; hv[i] = v;
    return top;
  };
  const pit = new Int32Array(n);
  let p0 = 0, p1 = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    if (r && c && r < h - 1 && c < w - 1) continue;
    const i = r * w + c;
    closed[i] = 1; push(z[i], i);
  }
  while (hs || p0 < p1) {
    const i = p0 < p1 ? pit[p0++] : pop();
    if (p0 === p1) p0 = p1 = 0;
    const r = (i / w) | 0, c = i - r * w, zi = z[i];
    for (let k = 0; k < 8; k++) {
      const rr = r + D8[k][0], cc = c + D8[k][1];
      if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      const j = rr * w + cc;
      if (closed[j]) continue;
      closed[j] = 1;
      if (z[j] <= zi + eps) { z[j] = zi + eps; pit[p1++] = j; } else push(z[j], j);
    }
  }
  return z;
}

/** Dirección D8 (0–7, −1 = sale de la rejilla) por la mayor pendiente; dxm, dzm en metros. */
export function flowDir(z, w, h, dxm, dzm) {
  const dir = new Int8Array(w * h).fill(-1), dist = D8.map(([dr, dc]) => Math.hypot(dr * dzm, dc * dxm));
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const i = r * w + c;
    let best = 0, bk = -1;
    for (let k = 0; k < 8; k++) {
      const rr = r + D8[k][0], cc = c + D8[k][1];
      if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
      const s = (z[i] - z[rr * w + cc]) / dist[k];
      if (s > best) { best = s; bk = k; }
    }
    dir[i] = bk;
  }
  return dir;
}

export const downOf = (dir, w, i) => { const k = dir[i]; return k < 0 ? -1 : i + D8[k][0] * w + D8[k][1]; };

/** Área drenada en celdas (incluida la propia), en orden topológico. */
export function accumulate(dir, w, h) {
  const n = w * h, acc = new Float32Array(n).fill(1), indeg = new Uint8Array(n), q = new Int32Array(n);
  for (let i = 0; i < n; i++) { const j = downOf(dir, w, i); if (j >= 0) indeg[j]++; }
  let q0 = 0, q1 = 0;
  for (let i = 0; i < n; i++) if (!indeg[i]) q[q1++] = i;
  while (q0 < q1) {
    const i = q[q0++], j = downOf(dir, w, i);
    if (j < 0) continue;
    acc[j] += acc[i];
    if (--indeg[j] === 0) q[q1++] = j;
  }
  return acc;
}

/**
 * Red de cauces: celdas con acumulación ≥ minCells, partida en tramos entre confluencias.
 * Cada tramo: celdas de arriba hacia abajo y orden de Strahler.
 */
export function channelNetwork(dir, acc, w, h, minCells) {
  const n = w * h, up = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (acc[i] < minCells) continue;
    const j = downOf(dir, w, i);
    if (j >= 0 && acc[j] >= minCells) up[j]++;
  }
  const segs = [];
  for (let i = 0; i < n; i++) {
    if (acc[i] < minCells || up[i] === 1) continue;   // empieza en una cabecera (0) o en una confluencia (≥ 2)
    const cells = [i];
    let k = downOf(dir, w, i);
    while (k >= 0 && acc[k] >= minCells) {
      cells.push(k);
      if (up[k] >= 2) break;                            // termina en la siguiente confluencia
      k = downOf(dir, w, k);
    }
    if (cells.length >= 2) segs.push({ cells, order: 0 });
  }
  // Strahler: de aguas arriba hacia aguas abajo (la acumulación crece río abajo)
  const endingAt = new Map();
  for (const s of segs) { const e = s.cells[s.cells.length - 1]; (endingAt.get(e) || endingAt.set(e, []).get(e)).push(s); }
  segs.sort((a, b) => acc[a.cells[0]] - acc[b.cells[0]]);
  for (const s of segs) {
    const inc = endingAt.get(s.cells[0]);
    if (!inc || up[s.cells[0]] === 0) { s.order = 1; continue; }
    const m = Math.max(...inc.map(t => t.order));
    s.order = inc.filter(t => t.order === m).length >= 2 ? m + 1 : m;
  }
  return segs;
}

/** Suavizado de Chaikin que conserva los extremos (las confluencias siguen unidas). */
export function chaikin(pts, iter = 2) {
  for (let it = 0; it < iter; it++) {
    const out = [pts[0]];
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      out.push(a.map((v, j) => 0.75 * v + 0.25 * b[j]), a.map((v, j) => 0.25 * v + 0.75 * b[j]));
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}
