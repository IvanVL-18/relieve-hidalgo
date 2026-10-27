import type { Heightfield } from './heightfield';

export interface MiniView {
  /** esquinas de lo que ve la cámara, en [lon, lat] */
  footprint: [number, number][];
  target: [number, number];
  pin: [number, number] | null;
}

/** Mapa de ubicación: fondo del worker, ciudades y el trapecio de lo que se está viendo. */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private hf: Heightfield,
    bitmap: ImageBitmap,
    cities: { t: string; lon: number; lat: number }[],
    accent: string,
    onBaseChange: () => void,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.base.width = canvas.width; this.base.height = canvas.height;
    const bx = this.base.getContext('2d')!;
    bx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const drawNames = () => {
      for (const p of cities) {
        const [x, y] = this.toPx(p.lon, p.lat);
        bx.fillStyle = accent; bx.beginPath(); bx.arc(x, y, 3.2, 0, Math.PI * 2); bx.fill();
        bx.font = '600 15px "Familjen Grotesk", system-ui, sans-serif';
        bx.lineWidth = 3; bx.strokeStyle = 'rgba(6, 8, 13, 0.55)'; bx.strokeText(p.t, x + 6, y + 5);
        bx.fillStyle = '#eef1f5'; bx.fillText(p.t, x + 6, y + 5);
      }
      onBaseChange();
    };
    // las letras esperan a la fuente para no quedar en la de respaldo
    document.fonts.load('600 15px "Familjen Grotesk"').catch(() => undefined).then(drawNames);
  }

  toPx(lon: number, lat: number): [number, number] {
    const g = this.hf.geo, { width, height } = this.canvas;
    return [(g.colOf(lon) / (this.hf.W - 1)) * width, (g.rowOf(lat) / (this.hf.H - 1)) * height];
  }

  /** Punto del minimapa (coordenadas de cliente) → [lon, lat] */
  toLonLat(clientX: number, clientY: number): [number, number] {
    const r = this.canvas.getBoundingClientRect(), g = this.hf.geo;
    const fx = (clientX - r.left) / r.width, fy = (clientY - r.top) / r.height;
    return [g.lonOfCol(fx * (this.hf.W - 1)), g.latOfRow(fy * (this.hf.H - 1))];
  }

  draw(v: MiniView, accent: string) {
    const { ctx } = this, { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.base, 0, 0);
    const pts = v.footprint.map(([lon, lat]) => this.toPx(lon, lat));
    ctx.fillStyle = 'rgba(255, 207, 122, 0.13)'; ctx.strokeStyle = 'rgba(255, 207, 122, 0.9)'; ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath(); ctx.fill(); ctx.stroke();
    const [tx, ty] = this.toPx(...v.target);
    ctx.strokeStyle = accent; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(tx, ty, 5, 0, Math.PI * 2);
    ctx.moveTo(tx - 10, ty); ctx.lineTo(tx - 6, ty); ctx.moveTo(tx + 6, ty); ctx.lineTo(tx + 10, ty);
    ctx.stroke();
    if (v.pin) {
      const [px, py] = this.toPx(...v.pin);
      ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2); ctx.fill();
    }
  }
}
