import { useState, type KeyboardEvent } from 'react';
import { MONTHS } from '../../shared/solar';
import { niceTicks } from '../perfil/profile';
import { SUN_RAMP } from '../scales';

const W = 320, H = 150, L = 30, R = 8, T = 10, B = 20;
const FLAT = 'rgba(238, 241, 245, 0.7)';

/** Radiación media diaria de cada mes (kWh/m²·día): barras sobre el terreno y la marca de lo plano sin relieve. */
export function MonthChart({ terrain, flat }: { terrain: ArrayLike<number>; flat: ArrayLike<number> }) {
  const [hover, setHover] = useState(-1);
  let hi = 0;
  for (let m = 0; m < 12; m++) hi = Math.max(hi, terrain[m], flat[m]);
  const y = niceTicks(0, hi * 1.05, 4), sy = (v: number) => T + ((y.hi - v) / (y.hi - y.lo)) * (H - T - B);
  const slot = (W - L - R) / 12, bw = slot - 4, x = (m: number) => L + m * slot + 2;
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    const next = e.key === 'ArrowRight' ? hover + 1 : e.key === 'ArrowLeft' ? hover - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? 11 : null;
    if (next === null) return;
    e.preventDefault();
    setHover(Math.min(11, Math.max(0, next < 0 ? 0 : next)));
  };
  const h = hover;
  return (
    <div className="rh-a-scatter rh-a-profile">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" tabIndex={0} onKeyDown={key} onBlur={() => setHover(-1)} onPointerLeave={() => setHover(-1)}
        aria-label={`Radiación media diaria por mes sobre el terreno: de ${Math.min(...Array.from(terrain)).toFixed(1)} a ${Math.max(...Array.from(terrain)).toFixed(1)} kWh/m². Flechas: recorrer los meses.`}>
        {y.ticks.map(v => <g key={v}><line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} className="rh-a-grid" /><text x={L - 5} y={sy(v) + 3} textAnchor="end">{v}</text></g>)}
        {MONTHS.map((name, m) => (
          <g key={name} onPointerEnter={() => setHover(m)} onPointerDown={() => setHover(m)}>
            <rect x={L + m * slot} y={T} width={slot} height={H - T - B} fill="transparent" />
            <rect x={x(m)} y={sy(terrain[m])} width={bw} height={Math.max(0, H - B - sy(terrain[m]))} rx={2} fill={SUN_RAMP[m === h ? 5 : 3]} />
            <line x1={x(m) - 1} x2={x(m) + bw + 1} y1={sy(flat[m])} y2={sy(flat[m])} stroke={FLAT} strokeWidth={2} strokeLinecap="round" />
            <text x={x(m) + bw / 2} y={H - 6} textAnchor="middle">{name[0].toUpperCase()}</text>
          </g>
        ))}
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} className="rh-a-axis" />
      </svg>
      <div className="rh-a-axislabels rh-mono">
        <span>↑ kWh/m² por día</span>
        <span className="rh-a-keyrow"><i style={{ background: SUN_RAMP[3] }} />sobre el terreno <i className="rh-a-keyline" style={{ background: FLAT }} />plano, sin relieve</span>
      </div>
      {h >= 0 && (
        <div className="rh-a-tip" style={{ left: `${((x(h) + bw / 2) / W) * 100}%`, top: `${(Math.min(sy(terrain[h]), sy(flat[h])) / H) * 100}%` }}>
          <strong>{MONTHS[h]}: {terrain[h].toFixed(2)} kWh/m²·día</strong>
          <span>plano: {flat[h].toFixed(2)} ({flat[h] > 0 ? Math.round((100 * terrain[h]) / flat[h]) : 0} %)</span>
        </div>
      )}
    </div>
  );
}
