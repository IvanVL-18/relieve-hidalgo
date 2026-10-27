import type { Lines, VecData } from './decode';

type Ctx = OffscreenCanvasRenderingContext2D;

/** Ancho de río en píxeles de una textura de 4096, según el área drenada (0–255). */
const riverWidth = (a: number) => 1.1 + Math.pow(a / 255, 1.35) * 7.5;

function strokeLines(ctx: Ctx, L: Lines, sx: number, sy: number) {
  ctx.beginPath();
  for (let l = 0; l < L.len.length; l++) {
    const s = L.start[l], n = L.len[l];
    for (let k = 0; k < n; k++) {
      const x = L.x[s + k] * sx, y = L.y[s + k] * sy;
      if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
  }
  ctx.stroke();
}

/** Ríos agrupados por ancho para dibujar cada ancho en una sola llamada. */
function strokeRivers(ctx: Ctx, v: VecData, sx: number, sy: number, widthMul: number, extra: number) {
  const R = v.rivers, buckets = new Map<number, number[]>();
  for (let l = 0; l < R.len.length; l++) {
    const s = R.start[l];
    for (let k = s; k + 1 < s + R.len[l]; k++) {
      const key = Math.round(riverWidth(R.acc[k]) * 4);
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, (arr = []));
      arr.push(R.x[k] * sx, R.y[k] * sy, R.x[k + 1] * sx, R.y[k + 1] * sy);
    }
  }
  for (const [key, arr] of buckets) {
    ctx.lineWidth = (key / 4) * widthMul + extra;
    ctx.beginPath();
    for (let k = 0; k < arr.length; k += 4) { ctx.moveTo(arr[k], arr[k + 1]); ctx.lineTo(arr[k + 2], arr[k + 3]); }
    ctx.stroke();
  }
}

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
 * Textura RG: R = ríos y presas, G = límites municipales. El píxel (0, 0) es la esquina noroeste,
 * y la columna de celda c cae en x = c · size / (W − 1).
 */
export function rasterWater(v: VecData, W: number, H: number, size: number) {
  const cv = new OffscreenCanvas(size, size);
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const sx = size / (W - 1), sy = size / (H - 1), px = size / 4096;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgb(255,0,0)';
  ctx.fillStyle = 'rgb(255,0,0)';
  strokeRivers(ctx, v, sx, sy, px * (W / 756), 0);
  fillLakes(ctx, v, sx, sy);
  ctx.strokeStyle = 'rgb(0,255,0)';
  ctx.lineWidth = Math.max(1.2, 2.6 * px);
  strokeLines(ctx, v.borders, sx, sy);
  const img = ctx.getImageData(0, 0, size, size).data;
  const rg = new Uint8Array(size * size * 2);
  for (let i = 0, j = 0; j < rg.length; i += 4, j += 2) { rg[j] = img[i]; rg[j + 1] = img[i + 1]; }
  return rg;
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
