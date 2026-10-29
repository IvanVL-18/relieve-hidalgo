import { useMemo, type KeyboardEvent, type PointerEvent } from 'react';
import type { Profile } from '../../shared/terrain';
import { SLOPE_BREAKS, SLOPE_RAMP, classOf, fmtInt } from '../scales';
import { decimate, niceTicks, sampleAt, slopeText, verticalExaggeration, type ProfileStats } from './profile';

/** Medidas de la gráfica (unidades del viewBox; se escala al ancho del panel). */
export const CHART = { W: 320, H: 176, L: 38, R: 10, T: 16, B: 20 };

export interface ChartMark { km: number; label: string }

/** Escalas del perfil compartidas por la gráfica del panel y la imagen PNG. */
export function chartScales(st: ProfileStats, W: number, H: number, L: number, R: number, T: number, B: number) {
  const span = Math.max(20, st.max - st.min), pad = span * 0.08;
  const y = niceTicks(st.min - pad, st.max + pad, 4), x = niceTicks(0, st.km, 4);
  const sx = (km: number) => L + (km / (st.km || 1)) * (W - L - R);
  const sy = (e: number) => T + ((y.hi - e) / (y.hi - y.lo)) * (H - T - B);
  return { sx, sy, yTicks: y.ticks, xTicks: x.ticks.filter(v => v <= st.km + 1e-9), exag: verticalExaggeration(W - L - R, H - T - B, st.km || 1, y.hi - y.lo) };
}

/** Tramos del trazo a dibujar, agrupados por clase de pendiente (la más fuerte de cada tramo, para no esconder rampas). */
export function slopeRuns(st: ProfileStats, maxPoints: number) {
  const idx = decimate(st.elev, maxPoints), runs: number[][][] = SLOPE_RAMP.map(() => []);
  let prevC = -1;
  for (let k = 1; k < idx.length; k++) {
    const a = idx[k - 1], b = idx[k];
    if (!Number.isFinite(st.elev[a]) || !Number.isFinite(st.elev[b])) { prevC = -1; continue; }
    let g = 0;
    for (let i = a + 1; i <= b; i++) if (Math.abs(st.slope[i]) > g) g = Math.abs(st.slope[i]);
    const c = classOf(g, SLOPE_BREAKS), list = runs[c];
    if (c === prevC) list[list.length - 1].push(b); else list.push([a, b]);
    prevC = c;
  }
  return { idx, runs };
}

export function ProfileChart({ prof, st, marks, hover, onHover }: {
  prof: Profile; st: ProfileStats; marks: ChartMark[]; hover: number; onHover: (i: number) => void;
}) {
  const { W, H, L, R, T, B } = CHART, n = prof.km.length;
  const geo = useMemo(() => {
    const sc = chartScales(st, W, H, L, R, T, B), { sx, sy } = sc, base = H - B;
    const { idx, runs } = slopeRuns(st, 640);
    const pts = idx.filter(i => Number.isFinite(st.elev[i]));
    const area = pts.length > 1
      ? `M${sx(prof.km[pts[0]]).toFixed(1)},${base}` + pts.map(i => `L${sx(prof.km[i]).toFixed(1)},${sy(st.elev[i]).toFixed(1)}`).join('') + `L${sx(prof.km[pts[pts.length - 1]]).toFixed(1)},${base}Z`
      : '';
    const paths = runs.map(list => list.map(r => r.map((i, k) => `${k ? 'L' : 'M'}${sx(prof.km[i]).toFixed(1)},${sy(st.elev[i]).toFixed(1)}`).join('')).join(''));
    return { ...sc, area, paths };
  }, [prof, st, W, H, L, R, T, B]);
  const { sx, sy } = geo;

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    onHover(sampleAt(prof.km, Math.min(1, Math.max(0, (px - L) / (W - L - R))) * st.km));
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = Math.max(1, Math.round(n / 100)) * (e.shiftKey ? 10 : 1), cur = hover < 0 ? 0 : hover;
    const next = e.key === 'ArrowRight' ? cur + step : e.key === 'ArrowLeft' ? cur - step : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (next === null) return;
    e.preventDefault();
    onHover(Math.min(n - 1, Math.max(0, next)));
  };

  const top = st.iMax >= 0 ? { x: sx(prof.km[st.iMax]), y: sy(st.max) } : null;
  const h = hover >= 0 && Number.isFinite(st.elev[hover]) ? hover : -1;
  const hx = h >= 0 ? sx(prof.km[h]) : 0, hy = h >= 0 ? sy(st.elev[h]) : 0, g = h >= 0 ? st.slope[h] : NaN;
  return (
    <div className="rh-a-scatter rh-a-profile">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" tabIndex={0} onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => onHover(-1)} onKeyDown={key} onBlur={() => onHover(-1)}
        aria-label={`Perfil de elevación de ${st.km.toFixed(1)} km, de ${fmtInt(st.min)} a ${fmtInt(st.max)} m. Flechas: recorrer el perfil.`}>
        {geo.yTicks.map(v => <g key={v}><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} className="rh-a-grid" /><text x={L - 5} y={sy(v) + 3} textAnchor="end">{fmtInt(v)}</text></g>)}
        {geo.xTicks.map((v, k) => <text key={v} x={sx(v)} y={H - 6} textAnchor={k === 0 ? 'start' : 'middle'}>{k === geo.xTicks.length - 1 ? `${v} km` : v}</text>)}
        {marks.map((m, k) => (
          <g key={k} className="rh-a-pmark">
            <line x1={sx(m.km)} x2={sx(m.km)} y1={T - 2} y2={H - B} />
            <text x={sx(m.km)} y={T - 5} textAnchor={k === 0 ? 'start' : k === marks.length - 1 ? 'end' : 'middle'}>{m.label}</text>
          </g>
        ))}
        <path d={geo.area} className="rh-a-parea" />
        {geo.paths.map((d, c) => d && <path key={c} d={d} stroke={SLOPE_RAMP[c]} className="rh-a-pline" />)}
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} className="rh-a-axis" />
        {top && (
          <g className="rh-a-ptop">
            <circle cx={top.x} cy={top.y} r={4} />
            <text x={Math.min(W - R - 18, Math.max(L + 18, top.x))} y={Math.max(9, top.y - 8)} textAnchor="middle">{fmtInt(st.max)} m</text>
          </g>
        )}
        {h >= 0 && (
          <g className="rh-a-pcross">
            <line x1={hx} x2={hx} y1={T} y2={H - B} />
            <circle cx={hx} cy={hy} r={4.5} fill={SLOPE_RAMP[classOf(Math.abs(g), SLOPE_BREAKS)]} />
          </g>
        )}
      </svg>
      <div className="rh-a-axislabels rh-mono"><span>↑ m s. n. m.</span><span>exageración vertical ×{geo.exag >= 10 ? fmtInt(geo.exag) : geo.exag.toFixed(1)}</span></div>
      {h >= 0 && (
        <div className="rh-a-tip" style={{ left: `${(Math.min(W - 50, Math.max(50, hx)) / W) * 100}%`, top: `${(hy / H) * 100}%` }}>
          <strong>{fmtInt(st.elev[h])} m</strong>
          <span>km {prof.km[h].toFixed(prof.km[h] < 10 ? 2 : 1)}{Number.isFinite(g) ? ` · ${slopeText(g)}` : ''}</span>
        </div>
      )}
    </div>
  );
}
