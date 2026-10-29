import type { Lines, VecData } from './decode';

type Ctx = OffscreenCanvasRenderingContext2D;

function fillLakes(ctx: Ctx, v: VecData, sx: number, sy: number) {
  const { outer, inner, rings } = v.lakes;
  let ring = 0;
  for (let l = 0; l < outer.length; l++) {
    ctx.beginPath();
    for (let q = 0; q < outer[l] + inner[l]; q++, ring++) {
      const s = rings.start[ring], n = rings.len[ring];
      for (let k = 0; k < n; k++) {
        const x = rings.x[s + k] * sx, y = rings.y[s + k] * sy;
        if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
}

/**
 * Campos de distancia de las líneas sobre una textura de size × size (RGBA, ver LinesResult). El texel (i, j) cubre las
 * celdas i·(W − 1)/size … (i + 1)·(W − 1)/size, igual que la coordenada de textura del terreno.
 *   r, g  ríos y límites: distancia con signo (lado del tramo más cercano), en raíz cuadrada: 128 ± 127·√(d / range);
 *         255 = sin línea a menos de range texeles. Con signo, interpolar entre texeles reproduce exacta la distancia
 *         a un tramo recto (sin signo, una línea entre dos filas de texeles quedaba a medio texel, ~25 m, y las finas se
 *         cortaban de cerca); la raíz da precisión de centímetros junto a la línea.
 *   b     presas: distancia con signo lineal, negativa dentro.
 *   a     tamaño (área drenada) del río más cercano.
 * Solo se recorre una franja de ancho range alrededor de cada tramo, con la distancia exacta al segmento.
 */
export function lineField(v: VecData, W: number, H: number, size: number, range: number) {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; }
  const sx = size / (W - 1), sy = size / (H - 1), k = 255 / range, R = range, R2 = range * range;
  const lakeD = new Uint8Array(size * size).fill(255);

  /**
   * Tramo a–b (texeles): guarda la distancia mínima en el canal ch (o en lakeD) y, para ríos, el tamaño.
   * Cada fila recorre solo el intervalo de la cápsula (discos de los extremos y franja a lo largo del tramo).
   */
  const seg = (ax: number, ay: number, bx: number, by: number, ch: number, acc: number) => {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
    const ux = L ? dx / L : 1, uy = L ? dy / L : 0;
    const yA = Math.max(0, Math.ceil(Math.min(ay, by) - R - 0.5)), yB = Math.min(size - 1, Math.floor(Math.max(ay, by) + R - 0.5));
    for (let y = yA; y <= yB; y++) {
      const py = y + 0.5, wy = py - ay;
      let xl = Infinity, xr = -Infinity, e = R2 - wy * wy;
      if (e > 0) { e = Math.sqrt(e); xl = ax - e; xr = ax + e; }
      e = R2 - (py - by) * (py - by);
      if (e > 0) { e = Math.sqrt(e); xl = Math.min(xl, bx - e); xr = Math.max(xr, bx + e); }
      if (L > 0) {
        // franja: |(x − ax)·uy − wy·ux| < R  y  0 ≤ (x − ax)·ux + wy·uy ≤ L
        let lo = -Infinity, hi = Infinity;
        if (Math.abs(uy) > 1e-9) { const p1 = ax + (wy * ux - R) / uy, p2 = ax + (wy * ux + R) / uy; lo = Math.min(p1, p2); hi = Math.max(p1, p2); }
        else if (Math.abs(wy) >= R) lo = Infinity;
        const s0 = wy * uy;
        if (Math.abs(ux) > 1e-9) { const p1 = ax - s0 / ux, p2 = ax + (L - s0) / ux; lo = Math.max(lo, Math.min(p1, p2)); hi = Math.min(hi, Math.max(p1, p2)); }
        else if (s0 < 0 || s0 > L) lo = Infinity;
        if (lo < hi) { xl = Math.min(xl, lo); xr = Math.max(xr, hi); }
      }
      const x0 = Math.max(0, Math.ceil(xl - 0.5)), x1 = Math.min(size - 1, Math.floor(xr - 0.5));
      for (let x = x0; x <= x1; x++) {
        const wx = x + 0.5 - ax;
        let t = L2 > 0 ? (wx * dx + wy * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = wx - t * dx, qy = wy - t * dy, d2 = qx * qx + qy * qy;
        if (d2 >= R2) continue;
        const p = y * size + x;
        if (ch < 0) { const q = (Math.sqrt(d2) * k + 0.5) | 0; if (q < lakeD[p]) lakeD[p] = q; continue; }
        // magnitud en raíz cuadrada; signo según el lado del tramo (producto cruz)
        const m = Math.round(127 * Math.sqrt(Math.sqrt(d2) / R)), o = p * 4 + ch, cur = Math.abs(out[o] - 128);
        if (m < cur) { out[o] = dx * wy - dy * wx >= 0 ? 128 + m : 128 - m; if (ch === 0) out[p * 4 + 3] = acc; }
        else if (ch === 0 && m === cur && acc > out[p * 4 + 3]) out[p * 4 + 3] = acc;
      }
    }
  };
  const polylines = (L: Lines, ch: number, acc?: Uint8Array) => {
    for (let l = 0; l < L.len.length; l++) {
      const s = L.start[l];
      for (let j = s; j + 1 < s + L.len[l]; j++) seg(L.x[j] * sx, L.y[j] * sy, L.x[j + 1] * sx, L.y[j + 1] * sy, ch, acc ? Math.max(acc[j], acc[j + 1]) : 0);
    }
  };
  polylines(v.rivers, 0, v.rivers.acc);
  polylines(v.borders, 1);
  polylines(v.lakes.rings, -1);

  // presas: dentro / fuera por par-impar sobre los centros de los texeles, para el signo de la distancia
  const inside = new Uint8Array(size * size), { outer, inner, rings } = v.lakes;
  let ring = 0;
  for (let l = 0; l < outer.length; l++) {
    const edges: number[] = [];
    let yMin = Infinity, yMax = -Infinity;
    for (let q = 0; q < outer[l] + inner[l]; q++, ring++) {
      const s = rings.start[ring], n = rings.len[ring];
      for (let j = 0; j < n; j++) {
        const a = s + j, b = s + ((j + 1) % n);
        const ax = rings.x[a] * sx, ay = rings.y[a] * sy, bx = rings.x[b] * sx, by = rings.y[b] * sy;
        if (ay === by) continue;
        edges.push(...(ay < by ? [ax, ay, bx, by] : [bx, by, ax, ay]));
        yMin = Math.min(yMin, ay, by); yMax = Math.max(yMax, ay, by);
      }
    }
    const xs: number[] = [];
    for (let y = Math.max(0, Math.ceil(yMin - 0.5)); y <= Math.min(size - 1, Math.floor(yMax - 0.5)); y++) {
      const py = y + 0.5;
      xs.length = 0;
      for (let e = 0; e < edges.length; e += 4) {
        if (py >= edges[e + 1] && py < edges[e + 3]) xs.push(edges[e] + ((py - edges[e + 1]) / (edges[e + 3] - edges[e + 1])) * (edges[e + 2] - edges[e]));
      }
      xs.sort((a, b) => a - b);
      for (let j = 0; j + 1 < xs.length; j += 2) {
        for (let x = Math.max(0, Math.ceil(xs[j] - 0.5)); x <= Math.min(size - 1, Math.floor(xs[j + 1] - 0.5)); x++) inside[y * size + x] ^= 1;
      }
    }
  }
  for (let p = 0; p < size * size; p++) out[p * 4 + 2] = inside[p] ? Math.round(128 - lakeD[p] * (128 / 255)) : Math.round(128 + lakeD[p] * (127 / 255));
  return out;
}

/**
 * Distancia con signo al contorno del estado en los nodos de una rejilla w × h que subdivide f veces la del visor (la de
 * los municipios de ~50 m): 128 = orilla, menos = dentro (1 a range nodos o más), más = afuera (255).
 * El terreno se recorta donde es positiva: el borde queda sobre el polígono de INEGI, no sobre la rejilla.
 * Rápida: dentro/fuera se rellena por renglones y la distancia solo se calcula en una franja alrededor del contorno.
 */
export function stateField(outline: Lines, w: number, h: number, f: number, range: number): Uint8Array {
  const out = new Uint8Array(w * h).fill(255), R = range, k = 127 / R;
  // dentro / fuera por par-impar sobre cada nodo (cruces del contorno por renglón)
  const rowsX: number[][] = Array.from({ length: h }, () => []);
  for (let l = 0; l < outline.len.length; l++) {
    const s0 = outline.start[l], n = outline.len[l];
    for (let j = 0; j < n; j++) {
      const p = s0 + j, q = s0 + ((j + 1) % n);
      const ax = outline.x[p] * f, ay = outline.y[p] * f, bx = outline.x[q] * f, by = outline.y[q] * f;
      if (ay === by) continue;
      const [lx, ly, hx, hy] = ay < by ? [ax, ay, bx, by] : [bx, by, ax, ay];
      for (let y = Math.max(0, Math.ceil(ly)); y <= Math.min(h - 1, Math.ceil(hy) - 1); y++) rowsX[y].push(lx + ((y - ly) / (hy - ly)) * (hx - lx));
    }
  }
  for (let y = 0; y < h; y++) {
    const xs = rowsX[y].sort((p, q) => p - q);
    for (let j = 0; j + 1 < xs.length; j += 2) {
      const x0 = Math.max(0, Math.ceil(xs[j])), x1 = Math.min(w - 1, Math.ceil(xs[j + 1]) - 1);
      if (x1 >= x0) out.fill(1, y * w + x0, y * w + x1 + 1);
    }
  }
  // franja: distancia mínima a los tramos (cuantizada), luego con el signo de cada nodo
  const band = new Uint8Array(w * h).fill(255), boxes: number[] = [];
  for (let l = 0; l < outline.len.length; l++) {
    const s0 = outline.start[l];
    for (let j = s0; j + 1 < s0 + outline.len[l]; j++) {
      const ax = outline.x[j] * f, ay = outline.y[j] * f, dx = outline.x[j + 1] * f - ax, dy = outline.y[j + 1] * f - ay, L2 = dx * dx + dy * dy;
      const x0 = Math.max(0, Math.ceil(Math.min(ax, ax + dx) - R)), x1 = Math.min(w - 1, Math.floor(Math.max(ax, ax + dx) + R));
      const y0 = Math.max(0, Math.ceil(Math.min(ay, ay + dy) - R)), y1 = Math.min(h - 1, Math.floor(Math.max(ay, ay + dy) + R));
      boxes.push(x0, x1, y0, y1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const wx = x - ax, wy = y - ay;
        const t = L2 > 0 ? Math.max(0, Math.min(1, (wx * dx + wy * dy) / L2)) : 0;
        const d = Math.hypot(wx - t * dx, wy - t * dy);
        if (d >= R) continue;
        const qd = Math.round(d * k), p = y * w + x;
        if (qd < band[p]) band[p] = qd;
      }
    }
  }
  for (let i = 0; i < boxes.length; i += 4) {
    for (let y = boxes[i + 2]; y <= boxes[i + 3]; y++) for (let x = boxes[i]; x <= boxes[i + 1]; x++) {
      const p = y * w + x, d = band[p];
      if (d === 255) continue;
      out[p] = out[p] === 1 ? 128 - d : 128 + d;
    }
    // que no se vuelva a escribir en las cajas que se traslapan
    for (let y = boxes[i + 2]; y <= boxes[i + 3]; y++) band.fill(255, y * w + boxes[i], y * w + boxes[i + 1] + 1);
  }
  return out;
}

/** Fondo del minimapa: relieve sombreado, límites, ríos principales y presas. Las letras se dibujan en el hilo principal. */
export function rasterMini(
  v: VecData, W: number, H: number, mw: number, mh: number,
  pixel: (fr: number, fc: number, out: Uint8ClampedArray, k: number) => void,
) {
  const cv = new OffscreenCanvas(mw, mh);
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(mw, mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) pixel((y / (mh - 1)) * (H - 1), (x / (mw - 1)) * (W - 1), img.data, (y * mw + x) * 4);
  ctx.putImageData(img, 0, 0);
  const sx = mw / (W - 1), sy = mh / (H - 1), R = v.rivers;
  ctx.strokeStyle = 'rgba(120, 200, 240, 0.85)';
  ctx.lineCap = 'round';
  for (let l = 0; l < R.len.length; l++) {
    const s = R.start[l];
    for (let k = s; k + 1 < s + R.len[l]; k++) {
      if (R.acc[k] < 110) continue;
      ctx.lineWidth = 0.6 + (R.acc[k] / 255) * 1.6;
      ctx.beginPath(); ctx.moveTo(R.x[k] * sx, R.y[k] * sy); ctx.lineTo(R.x[k + 1] * sx, R.y[k + 1] * sy); ctx.stroke();
    }
  }
  ctx.fillStyle = 'rgba(120, 200, 240, 0.95)';
  fillLakes(ctx, v, sx, sy);
  return cv.transferToImageBitmap();
}
