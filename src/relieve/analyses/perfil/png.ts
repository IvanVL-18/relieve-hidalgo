import type { Profile } from '../../shared/terrain';
import { SLOPE_LABELS, SLOPE_RAMP, fmtInt } from '../scales';
import { chartScales, slopeRuns, type ChartMark } from './ProfileChart';
import type { ProfileStats } from './profile';

const BG = '#0e121a', FG = '#eef1f5', MUTED = '#8a92a3', GRID = 'rgba(238, 241, 245, 0.10)';
const UI = '"Familjen Grotesk", system-ui, sans-serif', MONO = '"JetBrains Mono", ui-monospace, monospace';

/** Imagen del perfil (1920 × 1080) con título, cifras, leyenda de pendientes y créditos, para informes. */
export async function profilePng(prof: Profile, st: ProfileStats, marks: ChartMark[], opts: { title: string; subtitle: string; credits: string }): Promise<Blob> {
  const W = 960, H = 540, k = 2, L = 78, R = 36, T = 118, B = 96;
  const cv = document.createElement('canvas');
  cv.width = W * k; cv.height = H * k;
  const ctx = cv.getContext('2d')!;
  await document.fonts?.ready;
  ctx.scale(k, k);
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = FG; ctx.font = `600 26px ${UI}`; ctx.textBaseline = 'alphabetic';
  ctx.fillText(opts.title, L, 46);
  ctx.fillStyle = MUTED; ctx.font = `13px ${MONO}`;
  ctx.fillText(opts.subtitle, L, 72);

  const { sx, sy, yTicks, xTicks, exag } = chartScales(st, W, H, L, R, T, B), base = H - B;
  ctx.lineWidth = 1; ctx.font = `12px ${MONO}`;
  for (const v of yTicks) {
    ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(L, sy(v) + 0.5); ctx.lineTo(W - R, sy(v) + 0.5); ctx.stroke();
    ctx.fillStyle = MUTED; ctx.textAlign = 'right'; ctx.fillText(`${fmtInt(v)} m`, L - 8, sy(v) + 4);
  }
  xTicks.forEach((v, i) => { ctx.textAlign = i === 0 ? 'left' : 'center'; ctx.fillText(i === xTicks.length - 1 ? `${v} km` : String(v), sx(v), base + 20); });

  for (const m of marks) {
    ctx.strokeStyle = 'rgba(238, 241, 245, 0.22)'; ctx.beginPath(); ctx.moveTo(sx(m.km) + 0.5, T - 6); ctx.lineTo(sx(m.km) + 0.5, base); ctx.stroke();
    ctx.fillStyle = FG; ctx.textAlign = 'center'; ctx.font = `600 13px ${UI}`; ctx.fillText(m.label, Math.min(W - R - 6, Math.max(L + 6, sx(m.km))), T - 12);
  }

  const { idx, runs } = slopeRuns(st, 1600), pts = idx.filter(i => Number.isFinite(st.elev[i]));
  if (pts.length > 1) {
    ctx.beginPath(); ctx.moveTo(sx(prof.km[pts[0]]), base);
    for (const i of pts) ctx.lineTo(sx(prof.km[i]), sy(st.elev[i]));
    ctx.lineTo(sx(prof.km[pts[pts.length - 1]]), base); ctx.closePath();
    ctx.fillStyle = 'rgba(238, 241, 245, 0.08)'; ctx.fill();
  }
  ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  runs.forEach((list, c) => {
    ctx.strokeStyle = SLOPE_RAMP[c]; ctx.beginPath();
    for (const r of list) r.forEach((i, j) => (j ? ctx.lineTo(sx(prof.km[i]), sy(st.elev[i])) : ctx.moveTo(sx(prof.km[i]), sy(st.elev[i]))));
    ctx.stroke();
  });
  ctx.strokeStyle = 'rgba(238, 241, 245, 0.3)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, base + 0.5); ctx.lineTo(W - R, base + 0.5); ctx.stroke();
  if (st.iMax >= 0) {
    const x = sx(prof.km[st.iMax]), y = sy(st.max);
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = FG; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = BG; ctx.stroke();
    ctx.fillStyle = FG; ctx.font = `600 13px ${UI}`; ctx.textAlign = 'center';
    ctx.fillText(`${fmtInt(st.max)} m`, Math.min(W - R - 30, Math.max(L + 30, x)), Math.max(T - 2, y - 11));
  }

  // leyenda de pendientes y exageración
  let x = L;
  const ly = H - 46;
  ctx.font = `12px ${MONO}`; ctx.textAlign = 'left';
  ctx.fillStyle = MUTED; ctx.fillText('Pendiente:', x, ly + 4); x += 84;
  SLOPE_LABELS.forEach((t, c) => {
    ctx.fillStyle = SLOPE_RAMP[c]; ctx.fillRect(x, ly - 2, 18, 4);
    ctx.fillStyle = MUTED; ctx.fillText(t, x + 24, ly + 4);
    x += 24 + ctx.measureText(t).width + 18;
  });
  ctx.textAlign = 'right'; ctx.fillText(`exageración vertical ×${exag >= 10 ? fmtInt(exag) : exag.toFixed(1)}`, W - R, ly + 4);
  ctx.textAlign = 'left'; ctx.font = `11px ${MONO}`;
  ctx.fillText(opts.credits, L, H - 18);

  return new Promise((ok, fail) => cv.toBlob(b => (b ? ok(b) : fail(new Error('No se pudo crear la imagen'))), 'image/png'));
}
