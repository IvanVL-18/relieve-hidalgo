import { useEffect, useMemo, useState } from 'react';
import { GRADOS, type Localidades, type Municipio } from '../datasets';
import { BIVARIATE, MARG_RAMP, classOf, fmtInt, fmtPct, quantileBreaks, spearman } from '../scales';
import type { AnalysisProps } from '../types';
import { Facts, Loading, Note, Section, Seg, useAsync } from '../ui';

type Relieve = 'pendiente' | 'pct_pend_15';
const RELIEVE: Record<Relieve, { label: string; unit: (v: number) => string }> = {
  pendiente: { label: 'Pendiente media', unit: v => `${v.toFixed(1)}°` },
  pct_pend_15: { label: 'Territorio con pendiente > 15°', unit: v => fmtPct(v, 0) },
};
/** CONAPO 2020: a menor índice, mayor marginación. Se invierte para que «más» sea «más marginación». */
const marg = (m: Municipio) => -(m.im ?? NaN);
const strength = (r: number) => (Math.abs(r) < 0.2 ? 'muy débil' : Math.abs(r) < 0.4 ? 'débil' : Math.abs(r) < 0.6 ? 'moderada' : 'fuerte');

export default function Marginacion({ ctx }: AnalysisProps) {
  const { map, data } = ctx;
  const [all, err] = useAsync(() => Promise.all([data.municipios(), data.localidades()]), []);
  const [rel, setRel] = useState<Relieve>('pendiente');
  const [sel, setSel] = useState(0);
  const [hover, setHover] = useState(0);
  const mun = all?.[0], loc = all?.[1];

  const model = useMemo(() => {
    if (!mun) return null;
    const ms = mun.filter(m => m.im !== null);
    const xb = quantileBreaks(ms.map(m => m[rel]), 3), yb = quantileBreaks(ms.map(marg), 3);
    const cls = new Map(ms.map(m => [m.id, [classOf(marg(m), yb), classOf(m[rel], xb)] as const]));
    const rho = spearman(ms.map(m => m[rel]), ms.map(marg));
    const high = (m: Municipio) => m.gm === 'Alto' || m.gm === 'Muy alto';
    const steep = ms.filter(m => cls.get(m.id)![1] === 2), flat = ms.filter(m => cls.get(m.id)![1] === 0);
    const both = ms.filter(m => { const c = cls.get(m.id)!; return c[0] === 2 && c[1] === 2; });
    return { ms, cls, rho, steep, flat, steepHigh: steep.filter(high).length, flatHigh: flat.filter(high).length, both, bothPob: both.reduce((s, m) => s + m.pob, 0) };
  }, [mun, rel]);

  useEffect(() => {
    if (!model) return;
    map.setMunicipioFill(Object.fromEntries(model.ms.map(m => { const [y, x] = model.cls.get(m.id)!; return [m.cve, BIVARIATE[y][x]]; })), 0.86);
  }, [map, model]);

  useEffect(() => map.onClick(hit => { setSel(hit.municipio); map.select(hit.municipio); return true; }), [map]);
  useEffect(() => { map.highlight(hover || sel); }, [map, hover, sel]);

  if (err) return <Note>No se pudieron cargar los datos: {err}</Note>;
  if (!mun || !loc || !model) return <Loading />;
  const m = sel ? mun[sel - 1] : null;
  const R = RELIEVE[rel];

  return (
    <>
      <Section title="¿El rezago se concentra en el terreno abrupto?">
        <Seg label="Medida del relieve" value={rel} onChange={setRel} options={[['pendiente', 'Pendiente media'], ['pct_pend_15', '% con pendiente > 15°']]} />
        <p className="rh-a-lead">
          Correlación de Spearman entre {R.label.toLowerCase()} y marginación: <b>ρ = {model.rho.toFixed(2)}</b>, {strength(model.rho)}
          {model.rho > 0.2 ? ': a más relieve, más marginación.' : model.rho < -0.2 ? ': a más relieve, menos marginación.' : '.'}
        </p>
        <Note>
          De los {model.steep.length} municipios más escarpados, <b>{model.steepHigh}</b> tienen marginación alta o muy alta;
          de los {model.flat.length} más planos, <b>{model.flatHigh}</b>. En los {model.both.length} municipios con relieve y marginación
          en el tercio más alto viven {fmtInt(model.bothPob)} personas.
        </Note>
      </Section>

      <Section title="Mapa bivariado">
        <BivariateLegend xLabel={R.label} />
      </Section>

      <Section title="Municipios">
        <Scatter ms={model.ms} rel={rel} cls={model.cls} sel={sel} hover={hover} onHover={setHover} onPick={id => { setSel(id); map.select(id, true); }} />
      </Section>

      {m && (
        <Section title={m.nombre} aside={<span className="rh-mono">{m.cve}</span>}>
          <Facts items={[
            ['Grado de marginación', m.gm ?? '—'], ['Índice CONAPO', m.im?.toFixed(1) ?? '—'],
            ['Pendiente media', `${m.pendiente.toFixed(1)}°`], ['Territorio > 15°', fmtPct(m.pct_pend_15, 0)],
            ['15+ años analfabeta', fmtPct(m.analf ?? 0)], ['15+ sin educación básica', fmtPct(m.sbasc ?? 0)],
            ['Sin agua entubada', fmtPct(m.ovsae ?? 0)], ['Con piso de tierra', fmtPct(m.ovpt ?? 0)],
            ['Ingreso ≤ 2 salarios mínimos', fmtPct(m.po2sm ?? 0)], ['En localidades < 5 000 hab.', fmtPct(m.pl5000 ?? 0)],
          ]} />
        </Section>
      )}

      <Section title="Lo mismo, por localidad">
        <LocalityBins loc={loc} />
      </Section>
    </>
  );
}

function BivariateLegend({ xLabel }: { xLabel: string }) {
  return (
    <div className="rh-a-bivar">
      <div className="rh-a-bivar-y rh-mono">Marginación ↑</div>
      <div className="rh-a-bivar-grid" role="img" aria-label={`Matriz de 3 por 3: ${xLabel} contra marginación`}>
        {[2, 1, 0].map(y => BIVARIATE[y].map((c, x) => <i key={`${y}${x}`} style={{ background: c }} />))}
      </div>
      <div className="rh-a-bivar-x rh-mono">{xLabel} →</div>
      <Note>Cada eje en terciles de los 84 municipios. Índigo: mucho relieve y mucha marginación. Gris claro: poco de ambos.</Note>
    </div>
  );
}

function Scatter({ ms, rel, cls, sel, hover, onHover, onPick }: {
  ms: Municipio[]; rel: Relieve; cls: Map<number, readonly [number, number]>; sel: number; hover: number;
  onHover: (id: number) => void; onPick: (id: number) => void;
}) {
  const W = 320, H = 210, L = 34, B = 26, T = 8, Rr = 8;
  const xs = ms.map(m => m[rel]), ys = ms.map(m => m.im!);
  const x0 = 0, x1 = Math.ceil(Math.max(...xs) / 5) * 5;
  const y0 = Math.floor(Math.min(...ys) / 5) * 5, y1 = Math.ceil(Math.max(...ys) / 5) * 5;
  const sx = (v: number) => L + ((v - x0) / (x1 - x0)) * (W - L - Rr);
  // eje invertido: arriba = índice bajo = más marginación
  const sy = (v: number) => T + ((v - y0) / (y1 - y0)) * (H - T - B);
  const xt = Array.from({ length: x1 / 5 + 1 }, (_, i) => i * 5).filter((_, i, a) => a.length < 8 || i % 2 === 0);
  const yt = Array.from({ length: (y1 - y0) / 10 + 1 }, (_, i) => y0 + i * 10);
  const h = ms.find(m => m.id === hover);
  return (
    <div className="rh-a-scatter">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Dispersión: ${RELIEVE[rel].label} contra índice de marginación de los 84 municipios`}>
        {yt.map(v => <g key={v}><line x1={L} x2={W - Rr} y1={sy(v)} y2={sy(v)} className="rh-a-grid" /><text x={L - 6} y={sy(v) + 3} textAnchor="end">{v}</text></g>)}
        {xt.map(v => <text key={v} x={sx(v)} y={H - 8} textAnchor="middle">{rel === 'pendiente' ? `${v}°` : `${v}%`}</text>)}
        <line x1={L} x2={W - Rr} y1={H - B} y2={H - B} className="rh-a-axis" />
        {ms.map(m => {
          const [y, x] = cls.get(m.id)!, on = m.id === hover || m.id === sel;
          return (
            <circle key={m.id} cx={sx(m[rel])} cy={sy(m.im!)} r={on ? 6 : 4} fill={BIVARIATE[y][x]} className={on ? 'on' : ''}
              onPointerEnter={() => onHover(m.id)} onPointerLeave={() => onHover(0)} onClick={() => onPick(m.id)} />
          );
        })}
      </svg>
      <div className="rh-a-axislabels rh-mono"><span>↑ más marginación (índice CONAPO)</span><span>{RELIEVE[rel].label} →</span></div>
      {h && (
        <div className="rh-a-tip" style={{ left: `${(sx(h[rel]) / W) * 100}%`, top: `${(sy(h.im!) / H) * 100}%` }}>
          <strong>{h.nombre}</strong><span>{h.gm} · {RELIEVE[rel].unit(h[rel])}</span>
        </div>
      )}
    </div>
  );
}

/** % de localidades con marginación alta o muy alta según la pendiente de su entorno. */
function LocalityBins({ loc }: { loc: Localidades }) {
  const bins = [[0, 5], [5, 10], [10, 15], [15, 20], [20, 90]] as const;
  const rows = bins.map(([a, b]) => {
    let n = 0, hi = 0;
    for (let i = 0; i < loc.n; i++) if (loc.grado[i] && loc.pend[i] >= a && loc.pend[i] < b) { n++; if (loc.grado[i] >= 4) hi++; }
    return { label: b === 90 ? `${a}°+` : `${a}–${b}°`, n, pct: n ? (100 * hi) / n : 0 };
  });
  const max = Math.max(...rows.map(r => r.pct), 1);
  return (
    <>
      <div className="rh-a-vbars" role="img" aria-label="Porcentaje de localidades con marginación alta o muy alta por pendiente del entorno">
        {rows.map(r => (
          <div key={r.label} title={`${fmtInt(r.n)} localidades`}>
            <b>{fmtPct(r.pct, 0)}</b>
            <span className="rh-a-vtrack"><i style={{ height: `${(100 * r.pct) / max}%`, background: MARG_RAMP[3] }} /></span>
            <small>{r.label}</small>
          </div>
        ))}
      </div>
      <Note>
        Porcentaje de localidades con marginación {GRADOS[4].toLowerCase()} o {GRADOS[5].toLowerCase()} (CONAPO 2020) según la pendiente
        media a 1 km a la redonda. {fmtInt(rows.reduce((s, r) => s + r.n, 0))} localidades con dato.
      </Note>
    </>
  );
}
