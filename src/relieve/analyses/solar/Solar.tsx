import { useEffect, useMemo, useRef, useState } from 'react';
import type { RasterHandle } from '../../engine/mapApi';
import { fmtPoints, parsePoints } from '../../shared/enlaces';
import { makeGeo, type Geo } from '../../shared/geo';
import { MONTH_DAYS, climateAt, dirAzimuths, dirWeights, horizonAt, irradiation, skyView, slopeAspect, sunTable } from '../../shared/solar';
import type { TerrainApi } from '../../shared/terrain';
import type { Meta } from '../../shared/types';
import type { Solar as SolarData } from '../datasets';
import { SUN_DIVERGING, SUN_RAMP, fmtInt } from '../scales';
import type { AnalysisProps } from '../types';
import { Bars, Facts, Loading, Note, Section, Seg, oneOf, parseMuni, useAsync, useLinked } from '../ui';
import { MonthChart } from './MonthChart';

type Vista = 'anual' | 'relativa';
type Orden = 'mas' | 'menos';
const RAD = Math.PI / 180;
/** valores que van a los extremos de cada rampa: kWh/m²·año y % de lo plano */
const DOMAIN: Record<Vista, [number, number]> = { anual: [1500, 2300], relativa: [60, 140] };
/** rendimiento de un sistema fotovoltaico (pérdidas por temperatura, cables, inversor…) */
const PR = 0.8;
const ORIENT = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];
const orient = (a: number) => ORIENT[Math.round(a / (Math.PI / 4)) % 8];

/** Ejemplos: [id, nombre, lon, lat]. */
const EJEMPLOS: [string, string, number, number][] = [
  ['pachuca', 'Pachuca (plano)', -98.737, 20.1224],
  ['barranca', 'Pared de la barranca de Metztitlán', -98.7362, 20.7271],
  ['sierra', 'Ladera norte en la Sierra Alta', -98.6221, 20.9996],
  ['mezquital', 'Ladera sur en el Mezquital', -99.2496, 20.5479],
];

interface Punto {
  lon: number; lat: number; elev: number;
  slope: number; aspect: number; V: number;
  /** horizonte más alto (rad) y su azimut */
  horMax: number; horAz: number;
  months: Float64Array; flat: number[];
  year: number; yearFlat: number;
  /** fracción de la directa del año que tapa el horizonte */
  beamLoss: number;
  panel: { tilt: number; year: number };
}

/** Radiación de cada mes en un punto con el mismo modelo que la capa (relieve de 90 m en 30 km a la redonda). */
async function analizar(terrain: TerrainApi, solar: SolarData, geo: Geo, lon: number, lat: number): Promise<Punto> {
  const R = 30, g = await terrain.grid('elevacion', [lon - R / geo.KX, lat - R / geo.KZ, lon + R / geo.KX, lat + R / geo.KZ], 90);
  const [W0, S0, E0, N0] = g.bounds, w = g.width, h = g.height, dx = (E0 - W0) / w, dy = (N0 - S0) / h, z = g.data;
  const c = Math.min(w - 1, Math.max(0, Math.floor((lon - W0) / dx))), r = Math.min(h - 1, Math.max(0, Math.floor((N0 - lat) / dy)));
  if (!(z[r * w + c] > 0)) throw new Error('el punto queda fuera de la zona con relieve');
  const dxm = dx * geo.KX * 1000, dzm = dy * geo.KZ * 1000;
  const hor = horizonAt(z, w, h, c, r, dxm, dzm), { slope, aspect } = slopeAspect(z, w, h, c, r, dxm, dzm);
  const dirAz = dirAzimuths(dxm, dzm), wts = dirWeights(dirAz), t = sunTable(lat, dirAz), cl = climateAt(solar.clima, lon, lat);
  const V = skyView(slope, aspect, hor, dirAz, wts), months = new Float64Array(12), parts = new Float64Array(36);
  const year = irradiation(t, slope, aspect, hor, V, cl.ghi, cl.dhi, months, parts);
  const beamOf = (p: Float64Array) => MONTH_DAYS.reduce((s, d, m) => s + p[m * 3] * d, 0), beam = beamOf(parts);
  // la misma superficie con alrededores planos: cuánto de la directa tapa el horizonte
  const open = new Float64Array(hor.length);
  irradiation(t, slope, aspect, open, skyView(slope, aspect, open, dirAz, wts), cl.ghi, cl.dhi, undefined, parts);
  const beamOpen = beamOf(parts);
  // panel hacia el sur con el horizonte del lugar: la inclinación que más recibe
  let panel = { tilt: 0, year: 0 };
  for (let tilt = 0; tilt <= 45; tilt++) {
    const s = tilt * RAD, y = irradiation(t, s, Math.PI, hor, skyView(s, Math.PI, hor, dirAz, wts), cl.ghi, cl.dhi);
    if (y > panel.year) panel = { tilt, year: y };
  }
  let k = 0;
  for (let i = 1; i < hor.length; i++) if (hor[i] > hor[k]) k = i;
  return {
    lon, lat, elev: z[r * w + c], slope, aspect, V, horMax: hor[k], horAz: dirAz[k], months, flat: cl.ghi,
    year, yearFlat: cl.ghi.reduce((s, x, m) => s + x * MONTH_DAYS[m], 0), beamLoss: beamOpen > 0 ? Math.max(0, 1 - beam / beamOpen) : 0, panel,
  };
}

/** Radiación del terreno ÷ la de lo plano en el mismo lugar (%), por nodo. */
function relativa(s: SolarData, meta: Meta) {
  const a = s.clima.anual, step = meta.step / s.f, out = new Float32Array(s.w * s.h).fill(NaN);
  for (let r = 0; r < s.h; r++) {
    const y = Math.max(0, Math.min(a.ny - 1.000001, (a.lat0 - (meta.lat0 - r * step)) / a.step)), y0 = Math.floor(y), fy = y - y0;
    for (let c = 0; c < s.w; c++) {
      const q = s.e[r * s.w + c];
      if (!q) continue;
      const x = Math.max(0, Math.min(a.nx - 1.000001, (meta.lon0 + c * step - a.lon0) / a.step)), x0 = Math.floor(x), fx = x - x0, i = y0 * a.nx + x0;
      const g = (a.ghi[i] * (1 - fx) + a.ghi[i + 1] * fx) * (1 - fy) + (a.ghi[i + a.nx] * (1 - fx) + a.ghi[i + a.nx + 1] * fx) * fy;
      out[r * s.w + c] = (100 * (s.q.offset + q * s.q.step)) / (g * 365);
    }
  }
  return out;
}

export default function Solar({ ctx }: AnalysisProps) {
  const { map, data, meta, link } = ctx;
  const geo = useMemo(() => makeGeo(meta), [meta]);
  const [solar, err] = useAsync(() => data.solar(), [data]);
  const [vista, setVista] = useLinked<Vista>(link, 'vista', 'anual', oneOf('anual', 'relativa'));
  const [mun, setMun] = useLinked(link, 'mun', 0, parseMuni);
  const [orden, setOrden] = useState<Orden>('mas');
  const [pick, setPick] = useState<[number, number] | null>(() => parsePoints(link.initial.punto ?? '', 1)?.[0] ?? null);
  useEffect(() => link.set('punto', pick ? fmtPoints([pick]) : null), [link, pick]);
  const [pt, setPt] = useState<Punto | null>(null);
  const [busy, setBusy] = useState(false);
  const [ptErr, setPtErr] = useState('');
  const raster = useRef<RasterHandle | null>(null);
  const rel = useMemo(() => (solar && vista === 'relativa' ? relativa(solar, meta) : null), [solar, vista, meta]);

  useEffect(() => { if (mun) map.select(mun); }, [map, mun]);

  // capa: una sola, cambia de datos y de rampa con la vista
  useEffect(() => {
    if (!solar) return;
    const s = meta.step / solar.f, b = (v: number) => (v - solar.q.offset) / solar.q.step;
    const r = map.addRaster({
      kind: 'continuous', width: solar.w, height: solar.h, data: solar.e, nodata: 0, palette: SUN_RAMP, domain: [b(DOMAIN.anual[0]), b(DOMAIN.anual[1])], opacity: 0.85,
      bounds: [meta.lon0 - s / 2, meta.lat0 - (solar.h - 1) * s - s / 2, meta.lon0 + (solar.w - 1) * s + s / 2, meta.lat0 + s / 2],
    });
    raster.current = r;
    return () => { r.dispose(); raster.current = null; };
  }, [map, solar, meta]);
  useEffect(() => {
    const r = raster.current;
    if (!r || !solar) return;
    if (vista === 'relativa' && rel) { r.setData(rel, DOMAIN.relativa); r.setPalette(SUN_DIVERGING, DOMAIN.relativa); }
    else if (vista === 'anual') {
      const b = (v: number) => (v - solar.q.offset) / solar.q.step;
      r.setData(solar.e, [b(DOMAIN.anual[0]), b(DOMAIN.anual[1])]); r.setPalette(SUN_RAMP, [b(DOMAIN.anual[0]), b(DOMAIN.anual[1])]);
    }
  }, [vista, rel, solar]);

  useEffect(() => map.onClick(hit => { setPick([hit.lon, hit.lat]); return true; }), [map]);

  useEffect(() => {
    if (!pick || !solar) { setPt(null); return; }
    let alive = true;
    setBusy(true); setPtErr('');
    analizar(data.terrain(), solar, geo, pick[0], pick[1]).then(
      p => { if (alive) { setPt(p); setBusy(false); } },
      e => { if (alive) { setPt(null); setPtErr(e instanceof Error ? e.message : String(e)); setBusy(false); } },
    );
    return () => { alive = false; };
  }, [pick, solar, data, geo]);

  useEffect(() => {
    if (!pt) return;
    map.setPin(`${fmtInt(pt.year)} kWh/m² al año`, pt.lon, pt.lat);
    return () => map.setPin(null);
  }, [map, pt]);

  useEffect(() => map.onHover(hit => {
    if (!solar) return null;
    const s = meta.step / solar.f, c = Math.round((hit.lon - meta.lon0) / s), r = Math.round((meta.lat0 - hit.lat) / s);
    if (c < 0 || r < 0 || c >= solar.w || r >= solar.h) return null;
    const q = solar.e[r * solar.w + c];
    if (!q) return null;
    const e = solar.q.offset + q * solar.q.step, cl = climateAt(solar.clima, hit.lon, hit.lat), flat = cl.ghi.reduce((sum, x, m) => sum + x * MONTH_DAYS[m], 0);
    return [`Sol sobre el terreno: ${fmtInt(e)} kWh/m² al año (${Math.round((100 * e) / flat)} % de lo plano)`];
  }), [map, solar, meta]);

  const estado = useMemo(() => {
    if (!solar) return null;
    const km2 = solar.clases.map(() => 0).concat(0);
    for (const m of solar.municipios) m.km2.forEach((v, k) => { km2[k] += v; });
    return { km2, total: km2.reduce((a, b) => a + b, 0) };
  }, [solar]);

  if (err) return <Note>No se pudo cargar el potencial solar: {err}</Note>;
  if (!solar || !estado) return <Loading text="Cargando la radiación solar…" />;
  const ramp = vista === 'anual' ? SUN_RAMP : SUN_DIVERGING;
  const M = mun ? solar.municipios[mun - 1] : null;
  const lista = [...solar.municipios].sort((a, b) => (orden === 'mas' ? b.media - a.media : a.media - b.media)).slice(0, 8);
  const labels = solar.clases.map((v, k) => (k === 0 ? `< ${fmtInt(v)}` : `${fmtInt(solar.clases[k - 1])}–${fmtInt(v)}`)).concat(`> ${fmtInt(solar.clases.at(-1)!)}`);
  return (
    <>
      <Section title="Mapa" aside={busy ? <span className="rh-mono">calculando…</span> : undefined}>
        <Seg label="Qué mostrar" value={vista} onChange={setVista} options={[['anual', 'kWh/m² al año'], ['relativa', 'Comparado con lo plano']]} />
        <div className="rh-a-legend">
          <div className="rh-mono">{vista === 'anual' ? 'Radiación sobre el terreno · kWh/m² al año' : 'Radiación ÷ la de un terreno plano en el mismo lugar'}</div>
          <div className="rh-a-gradient" style={{ background: `linear-gradient(90deg, ${ramp.join(', ')})` }} />
          <div className="rh-a-gradticks rh-mono">
            {(vista === 'anual' ? [1500, 1700, 1900, 2100, 2300] : [60, 80, 100, 120, 140]).map(v => <span key={v}>{vista === 'anual' ? fmtInt(v) : `${v} %`}</span>)}
          </div>
        </div>
        <Note>{vista === 'anual'
          ? 'Cuánta energía del Sol llega cada año a cada pedazo de terreno, según el clima, la pendiente, hacia dónde mira y lo que tapan los cerros.'
          : 'Azul: recibe menos que un terreno plano y despejado en el mismo lugar (laderas que miran al norte, fondos de barranca). Naranja: más (laderas que miran al sur).'}
          {' '}Haz clic en el mapa para ver los meses de un punto.</Note>
        {!pick && <div className="rh-a-keys">{EJEMPLOS.map(([id, name, lon, lat]) => <button key={id} type="button" className="rh-a-link" onClick={() => { setPick([lon, lat]); map.flyTo(lon, lat, 14); }}>{name}</button>)}</div>}
      </Section>

      {ptErr && <Note>No se pudo calcular el punto: {ptErr}.</Note>}
      {pt && (
        <Section title="En este punto" aside={<button type="button" className="rh-a-link" onClick={() => setPick(null)}>Cerrar</button>}>
          <p className="rh-a-lead">
            El terreno {pt.slope < 3 * RAD ? 'casi plano' : `con pendiente de ${fmtInt(pt.slope / RAD)}° hacia el ${orient(pt.aspect)}`} recibe <b>{fmtInt(pt.year)} kWh/m²</b> al
            año: <b>{Math.round((100 * pt.year) / pt.yearFlat)} %</b> de lo que recibiría un terreno plano y despejado aquí ({fmtInt(pt.yearFlat)}).
          </p>
          <MonthChart terrain={pt.months} flat={pt.flat} />
          <Facts items={[
            ['Altitud', `${fmtInt(pt.elev)} m`],
            ['Horizonte más alto', pt.horMax > 0.5 * RAD ? `${fmtInt(pt.horMax / RAD)}° hacia el ${orient(pt.horAz)}` : 'despejado'],
            ['Sol directo que tapan los cerros', `${fmtInt(pt.beamLoss * 100)} % al año`],
            ['Cielo visible', `${fmtInt(pt.V * 100)} %`],
            [`Panel solar a ${pt.panel.tilt}° al sur`, `${fmtInt(pt.panel.year)} kWh/m² · ≈ ${fmtInt(pt.panel.year * PR)} kWh por kWp al año`],
          ]} />
        </Section>
      )}

      <Section title="Hidalgo">
        <p className="rh-a-lead">El terreno de Hidalgo recibe en promedio <b>{fmtInt(solar.estado.media)} kWh/m²</b> al año; nueve de cada diez lugares, entre {fmtInt(solar.estado.p5)} y {fmtInt(solar.estado.p95)}.</p>
        <Bars color={SUN_RAMP[3]} rows={labels.map((l, k) => ({ id: k, label: `${l} kWh/m²`, value: estado.km2[k], text: `${fmtInt(estado.km2[k])} km² · ${Math.round((100 * estado.km2[k]) / estado.total)} %`, color: SUN_RAMP[Math.min(5, k + 1)] }))} />
      </Section>

      <Section title="Municipios" aside={<span className="rh-mono">kWh/m² al año</span>}>
        <Seg label="Orden" value={orden} onChange={setOrden} options={[['mas', 'Más sol'], ['menos', 'Menos sol']]} />
        <Bars color={SUN_RAMP[3]} max={DOMAIN.anual[1]} onPick={id => setMun(Number(id))} onHover={id => map.highlight(id === null ? 0 : Number(id))}
          rows={lista.map(m => ({ id: m.id, label: meta.names[m.id - 1] ?? '', value: m.media, text: fmtInt(m.media) }))} />
        {M && (
          <Facts items={[
            [meta.names[M.id - 1] ?? '', `${fmtInt(M.media)} kWh/m² en promedio (de ${fmtInt(M.min)} a ${fmtInt(M.max)})`],
            ['Si fuera plano', `${fmtInt(M.plano)} kWh/m²: el relieve le quita ${Math.max(0, Math.round(100 - (100 * M.media) / M.plano))} %`],
            ['Con más de 2 000 kWh/m²', `${fmtInt(M.km2[3] + M.km2[4])} km² (${Math.round((100 * (M.km2[3] + M.km2[4])) / M.km2.reduce((a, b) => a + b, 0))} %)`],
          ]} />
        )}
      </Section>

      <p className="rh-a-warn"><b>Es potencial, no producción.</b> No toma en cuenta la sombra de árboles ni edificios, ni el polvo o la temperatura de los paneles; el clima es el promedio de muchos años (un año nublado da menos).</p>
      <Note>
        Clima: radiación global y difusa del Global Solar Atlas (Banco Mundial, Solargis; promedio {solar.periodos.atlas}), suavizada a ~5 km, repartida
        en los meses con NASA POWER ({solar.periodos.meses}). Relieve de INEGI a 90 m con horizontes en 16 direcciones, la posición del Sol cada media
        hora en un día de cada mes, difusa de Hay y Davies y reflejo del suelo de 20 %. Lo plano coincide con el Atlas a ±1 % y un panel a la
        inclinación óptima queda 1–2.5 % abajo del suyo.
      </Note>
    </>
  );
}
