/**
 * Composición de cada cuadro de video o imagen grande: el relieve de la grabación, las etiquetas como en el mapa, el
 * título, el texto de la parada de un recorrido y los créditos de las fuentes. Medidas en px de la interfaz × escala.
 */
import type { CaptureFrame, LabelKind } from '../../engine/mapApi';

export interface Caption { kicker: string; title: string; text: string; alpha: number }

export interface Overlay {
  title: string;
  subtitle?: string;
  labels: boolean;
  credits: string;
  caption?: Caption | null;
}

const UI = '"Familjen Grotesk", "Helvetica Neue", Arial, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const FG = '#eef1f5', MUTED = '#8a92a3', ACCENT = '#ffcf7a', WATER = '#8fd3f0', BG = 'rgba(6,8,13,0.9)';

/** Estilo de cada tipo de etiqueta (como en relieve.css; 1 rem = 16 px). */
const STYLE: Record<LabelKind, { font: (k: number) => string; color: string; dot: number; upper?: boolean; spacing?: number }> = {
  city: { font: k => `600 ${13.1 * k}px ${UI}`, color: FG, dot: 7 },
  town: { font: k => `400 ${11.8 * k}px ${UI}`, color: FG, dot: 5 },
  village: { font: k => `400 ${10.9 * k}px ${UI}`, color: '#c9ced8', dot: 4 },
  hamlet: { font: k => `400 ${10.2 * k}px ${UI}`, color: '#b3bac6', dot: 3 },
  colonia: { font: k => `500 ${9.6 * k}px ${UI}`, color: '#c9ced7', dot: 0, upper: true, spacing: 0.06 },
  region: { font: k => `400 ${10.6 * k}px ${MONO}`, color: MUTED, dot: 0, upper: true, spacing: 0.14 },
  river: { font: k => `italic 400 ${11.8 * k}px ${UI}`, color: WATER, dot: 0 },
  lake: { font: k => `italic 400 ${11.8 * k}px ${UI}`, color: WATER, dot: 0 },
  peak: { font: k => `400 ${11.8 * k}px ${UI}`, color: FG, dot: 5 },
};

/** Parte un texto en renglones que quepan en maxW. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  const lines: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Dibuja el cuadro completo en ctx (del tamaño de la grabación). */
export function composeFrame(ctx: CanvasRenderingContext2D, f: CaptureFrame, o: Overlay) {
  const { width: W, height: H, scale: k } = f;
  // cielo como el del visor: un resplandor del color de la hora detrás del relieve
  const bg = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.6);
  bg.addColorStop(0, f.glow);
  bg.addColorStop(1, '#06080d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(f.canvas, 0, 0, W, H);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  // franja oscura abajo para los créditos (y sin etiquetas en ella)
  const m = 26 * k, band = 64 * k, fade = ctx.createLinearGradient(0, H - band, 0, H);
  fade.addColorStop(0, 'rgba(6,8,13,0)');
  fade.addColorStop(1, 'rgba(6,8,13,0.78)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, H - band, W, band);

  if (o.labels) {
    for (const l of f.labels) {
      if (l.y > H - band * 0.7) continue;
      const s = STYLE[l.kind], text = s.upper ? l.text.toUpperCase() : l.text;
      ctx.font = s.font(k);
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = s.spacing ? `${s.spacing}em` : '0px';
      const centered = !s.dot;
      let x = l.x;
      if (s.dot) {
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(6,8,13,0.6)';
        ctx.beginPath(); ctx.arc(l.x, l.y, (s.dot / 2 + 2) * k, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = l.kind === 'city' || l.kind === 'peak' ? ACCENT : FG;
        ctx.beginPath(); ctx.arc(l.x, l.y, (s.dot / 2) * k, 0, Math.PI * 2); ctx.fill();
        x = l.x + (s.dot / 2 + 6) * k;
      }
      ctx.shadowColor = BG; ctx.shadowBlur = 5 * k;
      ctx.fillStyle = s.color;
      const tw = ctx.measureText(text).width;
      ctx.fillText(text, centered ? l.x - tw / 2 : x, l.y);
      if (l.sub) { ctx.font = `400 ${11 * k}px ${MONO}`; ctx.fillStyle = ACCENT; ctx.fillText(l.sub, (centered ? l.x - tw / 2 : x) + tw + 5 * k, l.y); }
    }
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
  }
  ctx.shadowBlur = 0;
  if (f.pin) {
    // marcador: etiqueta sobre una línea vertical, como en el mapa
    ctx.font = `600 ${13.6 * k}px ${UI}`;
    const tw = ctx.measureText(f.pin.text).width, bw = tw + 20 * k, bh = 28 * k, x = f.pin.x - bw / 2, y = f.pin.y - 22 * k - bh;
    ctx.fillStyle = ACCENT;
    ctx.fillRect(f.pin.x - k, f.pin.y - 22 * k, 2 * k, 22 * k);
    roundRect(ctx, x, y, bw, bh, 8 * k); ctx.fill();
    ctx.fillStyle = '#1a1408';
    ctx.fillText(f.pin.text, x + 10 * k, y + bh / 2);
  }

  // título
  ctx.shadowColor = BG; ctx.shadowBlur = 8 * k;
  ctx.fillStyle = FG;
  ctx.font = `600 ${22 * k}px ${UI}`;
  ctx.fillText(o.title, m, m + 12 * k);
  if (o.subtitle) {
    ctx.font = `400 ${11 * k}px ${MONO}`;
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0.06em';
    ctx.fillStyle = 'rgba(238,241,245,0.8)';
    ctx.fillText(o.subtitle.toUpperCase(), m, m + 38 * k);
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
  }
  ctx.shadowBlur = 0;

  // créditos (abajo, en uno o dos renglones)
  ctx.font = `400 ${9.5 * k}px ${MONO}`;
  const credit = wrap(ctx, o.credits, W - 2 * m), ch = 14 * k;
  let bottom = H - m * 0.7 - (credit.length - 1) * ch;
  ctx.fillStyle = 'rgba(238,241,245,0.72)';
  ctx.shadowColor = BG; ctx.shadowBlur = 4 * k;
  credit.forEach((line, i) => ctx.fillText(line, m, bottom + i * ch));
  ctx.shadowBlur = 0;

  // texto de la parada de un recorrido
  const c = o.caption;
  if (c && c.alpha > 0.01) {
    const vertical = H > W, cw = vertical ? W - 2 * m : Math.min(W * 0.46, 620 * k), pad = 18 * k;
    ctx.font = `400 ${15 * k}px ${UI}`;
    const lines = wrap(ctx, c.text, cw - 2 * pad), lh = 22 * k, hh = pad * 2 + 16 * k + 30 * k + lines.length * lh;
    bottom -= ch;
    const x = m, y = bottom - hh - 6 * k;
    ctx.globalAlpha = c.alpha;
    ctx.fillStyle = 'rgba(12,15,22,0.8)';
    roundRect(ctx, x, y, cw, hh, 12 * k); ctx.fill();
    ctx.strokeStyle = 'rgba(238,241,245,0.14)'; ctx.lineWidth = k; ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.font = `400 ${10.5 * k}px ${MONO}`;
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0.06em';
    ctx.fillText(c.kicker.toUpperCase(), x + pad, y + pad + 6 * k);
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
    ctx.fillStyle = FG;
    ctx.font = `600 ${22 * k}px ${UI}`;
    ctx.fillText(c.title, x + pad, y + pad + 16 * k + 14 * k);
    ctx.font = `400 ${15 * k}px ${UI}`;
    lines.forEach((line, i) => ctx.fillText(line, x + pad, y + pad + 16 * k + 30 * k + (i + 0.5) * lh));
    ctx.globalAlpha = 1;
  }
}
