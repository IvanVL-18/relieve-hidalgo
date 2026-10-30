import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { niceTicks, sampleAt } from '../perfil/profile';
import { CHART } from '../perfil/ProfileChart';
import { NOVIEW, VIEW_RAMP, fmtInt } from '../scales';

/** Perfil de la línea de vista de una torre a un punto. */
export interface LosData {
  /** torre (índice) y nombre del punto */
  tower: number;
  name: string;
  km: Float32Array;
  /** terreno con el abultamiento de la Tierra d·(D − d) / 2kR, así la línea de vista es una recta */
  terrain: Float32Array;
  /** suelo sin el abultamiento (para la ficha) */
  ground: Float32Array;
  /** punta de la antena y receptor (m s. n. m.) */
  zT: number;
  zR: number;
  /** metros que le faltan a la antena (≤ 0 = se ve) */
  lift: number;
  /** cuánto sobresale el terreno de la recta en su punto más alto respecto a ella (> 0 = la tapa) y esa muestra */
  over: number;
  iBlock: number;
}

/** Altura de la recta antena-receptor en la muestra i. */
export const losAt = (d: LosData, i: number) => d.zT + (d.zR - d.zT) * (d.km[i] / (d.km[d.km.length - 1] || 1));

export function LosChart({ d, letter }: { d: LosData; letter: string }) {
  const { W, H, L, R, T, B } = CHART, n = d.km.length, D = d.km[n - 1] || 1, ok = d.lift <= 0;
  const [hover, setHover] = useState(-1);
  const geo = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) if (Number.isFinite(d.terrain[i])) { lo = Math.min(lo, d.terrain[i]); hi = Math.max(hi, d.terrain[i]); }
    hi = Math.max(hi, d.zT, d.zR);
    const pad = Math.max(20, hi - lo) * 0.08, y = niceTicks(lo - pad, hi + pad, 4), x = niceTicks(0, D, 4);
    const sx = (km: number) => L + (km / D) * (W - L - R), sy = (e: number) => T + ((y.hi - e) / (y.hi - y.lo)) * (H - T - B);
    const step = Math.max(1, Math.floor(n / 600)), base = H - B;
    let line = '', x0 = -1, x1 = 0;
    for (let i = 0; i < n; i = i + step >= n && i < n - 1 ? n - 1 : i + step) {
      if (!Number.isFinite(d.terrain[i])) continue;
      const px = sx(d.km[i]);
      line += `${line ? 'L' : 'M'}${px.toFixed(1)},${sy(d.terrain[i]).toFixed(1)}`;
      if (x0 < 0) x0 = px;
      x1 = px;
    }
    const area = line ? `M${x0.toFixed(1)},${base}L${line.slice(1)}L${x1.toFixed(1)},${base}Z` : '';
    return { sx, sy, area, line, yTicks: y.ticks, xTicks: x.ticks.filter(v => v <= D + 1e-9) };
  }, [d, n, D, W, H, L, R, T, B]);
  const { sx, sy } = geo;

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    setHover(sampleAt(d.km, Math.min(1, Math.max(0, (px - L) / (W - L - R))) * D));
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    const step = Math.max(1, Math.round(n / 100)) * (e.shiftKey ? 10 : 1), cur = hover < 0 ? 0 : hover;
    const next = e.key === 'ArrowRight' ? cur + step : e.key === 'ArrowLeft' ? cur - step : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setHover(Math.min(n - 1, Math.max(0, next)));
  };

  const color = ok ? VIEW_RAMP[1] : NOVIEW, blk = d.iBlock;
  const h = hover >= 0 && Number.isFinite(d.terrain[hover]) ? hover : -1, hx = h >= 0 ? sx(d.km[h]) : 0;
  const clear = h >= 0 ? losAt(d, h) - d.terrain[h] : 0;
  return (
    <div className="rh-a-scatter rh-a-profile">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" tabIndex={0} onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(-1)} onKeyDown={key} onBlur={() => setHover(-1)}
        aria-label={`Línea de vista de la torre ${letter} a ${d.name}: ${D.toFixed(1)} km, ${ok ? 'despejada' : `tapada; le faltan ${fmtInt(d.lift)} m a la antena`}. Flechas: recorrer el perfil.`}>
        {geo.yTicks.map(v => <g key={v}><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} className="rh-a-grid" /><text x={L - 5} y={sy(v) + 3} textAnchor="end">{fmtInt(v)}</text></g>)}
        {geo.xTicks.map((v, k) => <text key={v} x={sx(v)} y={H - 6} textAnchor={k === 0 ? 'start' : 'middle'}>{k === geo.xTicks.length - 1 ? `${v} km` : v}</text>)}
        <path d={geo.area} className="rh-a-parea" />
        <path d={geo.line} className="rh-a-pline" stroke="rgba(238, 241, 245, 0.55)" />
        <g className="rh-a-pmark">
          <line x1={sx(0)} x2={sx(0)} y1={sy(d.terrain[0])} y2={sy(d.zT)} />
          <text x={sx(0)} y={sy(d.zT) - 5} textAnchor="start">{letter}</text>
          <line x1={sx(D)} x2={sx(D)} y1={sy(d.terrain[n - 1])} y2={sy(d.zR)} />
        </g>
        <line x1={sx(0)} y1={sy(d.zT)} x2={sx(D)} y2={sy(d.zR)} stroke={color} className="rh-a-pline" strokeDasharray={ok ? undefined : '5 4'} />
        {blk > 0 && blk < n - 1 && (
          <g className="rh-a-ptop">
            <circle cx={sx(d.km[blk])} cy={sy(d.terrain[blk])} r={4} fill={ok ? undefined : NOVIEW} />
          </g>
        )}
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} className="rh-a-axis" />
        {h >= 0 && (
          <g className="rh-a-pcross">
            <line x1={hx} x2={hx} y1={T} y2={H - B} />
            <circle cx={hx} cy={sy(d.terrain[h])} r={4.5} fill="#eef1f5" />
          </g>
        )}
      </svg>
      <div className="rh-a-axislabels rh-mono"><span>↑ m s. n. m.</span><span>con la curvatura de la Tierra (k = 4/3)</span></div>
      {h >= 0 && (
        <div className="rh-a-tip" style={{ left: `${(Math.min(W - 50, Math.max(50, hx)) / W) * 100}%`, top: `${(sy(d.terrain[h]) / H) * 100}%` }}>
          <strong>{clear >= 0 ? `pasa ${fmtInt(clear)} m arriba` : `tapa ${fmtInt(-clear)} m`}</strong>
          <span>km {d.km[h].toFixed(1)} · suelo {fmtInt(d.ground[h])} m</span>
        </div>
      )}
    </div>
  );
}
