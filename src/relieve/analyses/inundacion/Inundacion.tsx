import { useEffect, useMemo, useRef, useState } from 'react';
import type { RasterHandle } from '../../engine/mapApi';
import { fmtPoints, parsePoints } from '../../shared/enlaces';
import { makeGeo } from '../../shared/geo';
import { SERVICE_TYPES } from '../../shared/servicios';
import type { Flood } from '../../shared/terrain';
import type { Meta } from '../../shared/types';
import { USV_GROUPS } from '../../shared/usv';
import type { RoadLines } from '../accesibilidad/router';
import type { Localidades, Servicios, UsoSuelo } from '../datasets';
import { DEPTH_RAMP, fmtInt } from '../scales';
import type { AnalysisProps } from '../types';
import { ClassLegend, Examples, Facts, Loading, Note, Section, Seg, Stats, oneOf, useAsync, useLinked } from '../ui';

type Modo = 'rio' | 'valle';
const AGUA = USV_GROUPS.findIndex(g => g.id === 'agua');
/** profundidad que toma el color más oscuro, por modelo */
const TOPE: Record<Modo, number> = { rio: 5, valle: 10 };

/** Ejemplos: [id, nombre, lon, lat, modelo, metros]. */
const EJEMPLOS: [string, string, number, number, Modo, number][] = [
  ['tula', 'Tula (río Tula)', -99.3418, 20.0547, 'rio', 3],
  ['ixmiquilpan', 'Ixmiquilpan', -99.2379, 20.5079, 'rio', 3],
  ['tulancingo', 'Tulancingo', -98.3662, 20.1221, 'rio', 2],
  ['metztitlan', 'Laguna de Metztitlán', -98.8672, 20.6835, 'valle', 8],
  ['tecocomulco', 'Laguna de Tecocomulco', -98.3895, 19.8584, 'valle', 1.5],
];

interface Efecto {
  depth: Float32Array;
  /** área (km²), profundidad máxima (m) y volumen (hm³ = m × km²) */
  km2: number; max: number; hm3: number;
  /** localidades inundadas (índice) y profundidad en su punto */
  locs: [number, number][]; pob: number;
  /** localidades sin agua en su centro pero a menos de 250 m de ella (en ciudades, el centro suele quedar lejos del río) */
  cerca: number[]; pobCerca: number;
  /** servicios inundados por tipo (índice en SERVICE_TYPES) */
  servicios: number[];
  viasKm: number;
}

/** Profundidad y afectaciones con una subida h. Los cuerpos de agua del uso de suelo no cuentan como inundación. */
function evaluar(fl: Flood, h: number, meta: Meta, loc: Localidades, srv: Servicios, usv: UsoSuelo, vias: RoadLines | null): Efecto {
  const g = fl.need, w = g.width, hh = g.height, need = g.data, [W0, S0, E0, N0] = g.bounds;
  const dLon = (E0 - W0) / w, dLat = (N0 - S0) / hh, geo = makeGeo(meta);
  const depth = new Float32Array(w * hh).fill(NaN);
  let cells = 0, sum = 0, max = 0;
  for (let r = 0; r < hh; r++) {
    const uy = Math.floor(((meta.lat0 - (N0 - (r + 0.5) * dLat)) / meta.step) * usv.f);
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (!(need[i] <= h)) continue;
      const ux = Math.floor(((W0 + (c + 0.5) * dLon - meta.lon0) / meta.step) * usv.f);
      const k = uy >= 0 && ux >= 0 && uy < usv.h && ux < usv.w ? usv.clase[uy * usv.w + ux] : 0;
      if (k && usv.clases[k - 1].grupo === AGUA) continue;
      const d = Math.max(0.05, h - fl.ground[i]);
      depth[i] = d; cells++; sum += d;
      if (d > max) max = d;
    }
  }
  const cellKm2 = dLon * geo.KX * dLat * geo.KZ;
  const at = (lon: number, lat: number) => {
    const c = Math.floor((lon - W0) / dLon), r = Math.floor((N0 - lat) / dLat);
    return c >= 0 && r >= 0 && c < w && r < hh ? depth[r * w + c] : NaN;
  };
  const locs: [number, number][] = [], cerca: number[] = [], R = Math.ceil(0.25 / (dLat * geo.KZ));
  let pob = 0, pobCerca = 0;
  for (let i = 0; i < loc.n; i++) {
    const lo = loc.lon[i], la = loc.lat[i];
    if (lo < W0 - 0.01 || lo > E0 + 0.01 || la < S0 - 0.01 || la > N0 + 0.01) continue;
    const d = at(lo, la);
    if (d > 0) { locs.push([i, d]); pob += loc.pob[i]; continue; }
    const c0 = Math.floor((lo - W0) / dLon), r0 = Math.floor((N0 - la) / dLat);
    search: for (let r = Math.max(0, r0 - R); r <= Math.min(hh - 1, r0 + R); r++) for (let c = Math.max(0, c0 - R); c <= Math.min(w - 1, c0 + R); c++) {
      if (depth[r * w + c] > 0) { cerca.push(i); pobCerca += loc.pob[i]; break search; }
    }
  }
  const servicios = SERVICE_TYPES.map(() => 0);
  for (let i = 0; i < srv.n; i++) if (at(srv.lon[i], srv.lat[i]) > 0) servicios[srv.tipo[i]]++;
  let viasKm = 0;
  if (vias) for (let e = 0; e < vias.start.length; e++) {
    for (let k = vias.start[e]; k + 1 < vias.start[e] + vias.len[e]; k++) {
      const lo = (vias.lon[k] + vias.lon[k + 1]) / 2, la = (vias.lat[k] + vias.lat[k + 1]) / 2;
      if (lo < W0 || lo > E0 || la < S0 || la > N0 || !(at(lo, la) > 0)) continue;
      viasKm += Math.hypot((vias.lon[k + 1] - vias.lon[k]) * geo.KX, (vias.lat[k + 1] - vias.lat[k]) * geo.KZ);
    }
  }
  return { depth, km2: cells * cellKm2, max, hm3: sum * cellKm2, locs, pob, cerca, pobCerca, servicios, viasKm };
}

const fmt1 = (v: number) => (v >= 100 ? fmtInt(v) : v > 0 && v < 0.1 ? '< 0.1' : v.toFixed(1));

export default function Inundacion({ ctx }: AnalysisProps) {
  const { map, data, meta, link } = ctx;
  const [base, baseErr] = useAsync(() => Promise.all([data.localidades(), data.servicios(), data.usv()]), [data]);
  const [modo, setModo] = useLinked<Modo>(link, 'modo', 'rio', oneOf('rio', 'valle'));
  const [pick, setPick] = useState<{ lon: number; lat: number; modo: Modo; fly: boolean } | null>(() => {
    const p = parsePoints(link.initial.punto ?? '', 1);
    return p ? { lon: p[0][0], lat: p[0][1], modo: link.initial.modo === 'valle' ? 'valle' : 'rio', fly: false } : null;
  });
  useEffect(() => link.set('punto', pick ? fmtPoints([[pick.lon, pick.lat]]) : null), [link, pick]);
  const [fl, setFl] = useState<Flood | null>(null);
  const [h, setH] = useLinked(link, 'h', 3, s => { const v = Number(s); return v >= 0.25 && v <= 30 ? v : undefined; });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [vias, setVias] = useState<RoadLines | null>(null);
  const raster = useRef<RasterHandle | null>(null);

  useEffect(() => map.onClick(hit => { setPick({ lon: hit.lon, lat: hit.lat, modo, fly: false }); return true; }), [map, modo]);

  useEffect(() => {
    if (!pick) return;
    let alive = true;
    setBusy(true); setErr('');
    data.terrain().flood(pick.lon, pick.lat, { mode: pick.modo }).then(
      f => {
        if (!alive) return;
        setFl(f); setBusy(false);
        if (pick.fly) map.flyTo(f.seed[0], f.seed[1], pick.modo === 'rio' ? 14 : 22);
      },
      e => { if (alive) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); setFl(null); } },
    );
    return () => { alive = false; };
  }, [pick, data, map]);

  // la red vial (para los tramos inundados) se pide con el primer cálculo: carga el worker de rutas
  useEffect(() => {
    if (!fl || vias) return;
    let alive = true;
    data.router().ready.then(r => { if (alive) setVias(r.lines); }, () => undefined);
    return () => { alive = false; };
  }, [fl, vias, data]);

  const ef = useMemo(() => (fl && base ? evaluar(fl, h, meta, base[0], base[1], base[2], vias) : null), [fl, h, meta, base, vias]);

  // la capa se crea una vez por cálculo; al mover el nivel solo cambian sus valores
  useEffect(() => {
    if (!fl) return;
    const g = fl.need;
    const r = map.addRaster({ kind: 'continuous', bounds: g.bounds, width: g.width, height: g.height, data: new Float32Array(g.width * g.height).fill(NaN), domain: [0, TOPE[fl.mode]], palette: DEPTH_RAMP, opacity: 0.85 });
    raster.current = r;
    map.setPin(fl.mode === 'rio' ? 'Cauce' : 'Punto', fl.seed[0], fl.seed[1]);
    return () => { r.dispose(); raster.current = null; map.setPin(null); };
  }, [map, fl]);
  useEffect(() => { if (ef && fl) raster.current?.setData(ef.depth, [0, TOPE[fl.mode]]); }, [ef, fl]);

  useEffect(() => map.onHover(hit => {
    if (!fl) return null;
    const g = fl.need, [W0, S0, E0, N0] = g.bounds;
    const c = Math.floor(((hit.lon - W0) / (E0 - W0)) * g.width), r = Math.floor(((N0 - hit.lat) / (N0 - S0)) * g.height);
    if (c < 0 || r < 0 || c >= g.width || r >= g.height) return null;
    const i = r * g.width + c, d = ef?.depth[i];
    if (d !== undefined && d > 0) return [`Agua: ≈ ${d.toFixed(1)} m de profundidad`];
    const n = g.data[i];
    return Number.isNaN(n) ? null : [`Se inundaría con ${n.toFixed(1)} m de subida`];
  }), [map, fl, ef]);

  const elegir = (id: string) => {
    const e = EJEMPLOS.find(x => x[0] === id)!;
    setModo(e[4]); setH(e[5]);
    setPick({ lon: e[2], lat: e[3], modo: e[4], fly: true });
  };

  if (baseErr) return <Note>No se pudieron cargar los datos: {baseErr}</Note>;
  const maxH = fl?.maxRise ?? 30, llega = fl && fl.mode === 'valle' && h >= fl.edgeRise;
  return (
    <>
      <Section title="Modelo" aside={busy ? <span className="rh-mono">calculando…</span> : undefined}>
        <Seg label="Modelo de inundación" value={modo} onChange={m => { setModo(m); if (pick) setPick({ ...pick, modo: m, fly: false }); }}
          options={[['rio', 'Río que crece'], ['valle', 'Valle que se llena']]} />
        <Note>{modo === 'rio'
          ? 'Haz clic sobre un río: se inunda lo que queda a pocos metros sobre ese cauce, a lo largo de ~20 km río arriba y río abajo.'
          : 'Haz clic en el fondo de un valle o una laguna: el agua sube sobre ese punto y llena todo lo que queda por debajo de su nivel.'}</Note>
        <Examples onPick={elegir} options={EJEMPLOS.map(([id, nombre]) => [id, nombre] as [string, string])} />
        {err && <Note>No se pudo calcular: {err}</Note>}
      </Section>

      {fl && (
        <Section title="Nivel del agua">
          <div className="rh-ctl">
            <div className="rh-head">
              <label htmlFor="rh-nivel">{fl.mode === 'rio' ? 'Altura sobre el cauce' : 'Subida sobre el punto'}</label>
              <output htmlFor="rh-nivel">+{h.toFixed(h < 10 ? 2 : 1)} m{fl.mode === 'valle' ? ` · ${fmtInt(fl.seed[2] + h)} m s. n. m.` : ''}</output>
            </div>
            <input id="rh-nivel" type="range" min={0.25} max={maxH} step={0.25} value={Math.min(h, maxH)} onChange={e => setH(+e.target.value)} />
          </div>
          <ClassLegend caption="Profundidad" colors={DEPTH_RAMP} labels={fl.mode === 'rio' ? ['< 1 m', '1–2', '2–3', '3–4', '> 4 m'] : ['< 2 m', '2–4', '4–6', '6–8', '> 8 m']} />
        </Section>
      )}

      {fl && !ef && <Loading text="Cargando localidades y servicios…" />}
      {fl && ef && (
        <Section title="Qué quedaría bajo el agua">
          <p className="rh-a-lead">Con el agua a <b>{h.toFixed(h < 10 ? 2 : 1)} m</b> {fl.mode === 'rio' ? 'sobre el cauce' : `sobre el punto (${fmtInt(fl.seed[2] + h)} m s. n. m.)`}, se cubrirían <b>{fmt1(ef.km2)} km²</b>{ef.locs.length ? <> en <b>{fmtInt(ef.locs.length)}</b> localidades</> : ''}.</p>
          <Stats items={[[`${ef.max.toFixed(1)} m`, 'Profundidad máxima'], [`${fmt1(ef.hm3)} hm³`, 'Volumen de agua'], [fmtInt(ef.pob), 'Habitantes de las localidades inundadas']]} />
          <Facts items={[
            ...SERVICE_TYPES.map((t, k) => [t.plural, fmtInt(ef.servicios[k])] as [string, string]).filter((_, k) => ef.servicios[k] > 0 || k < 2),
            ['Carreteras y caminos', vias ? `${fmt1(ef.viasKm)} km` : 'cargando…'],
          ]} />
          {ef.locs.length > 0 && base && (
            <Note>Más pobladas: {[...ef.locs].sort((a, b) => base[0].pob[b[0]] - base[0].pob[a[0]]).slice(0, 5).map(([i, d]) => `${base[0].nombre[i]} (${fmtInt(base[0].pob[i])} hab., ≈ ${d.toFixed(1)} m en su centro)`).join(', ')}.</Note>
          )}
          {ef.cerca.length > 0 && base && <Note>Además, {fmtInt(ef.cerca.length)} localidades ({fmtInt(ef.pobCerca)} hab.) tienen agua a menos de 250 m de su centro: {[...ef.cerca].sort((a, b) => base[0].pob[b] - base[0].pob[a]).slice(0, 4).map(i => base[0].nombre[i]).join(', ')}.</Note>}
          {llega && <p className="rh-a-warn"><b>El agua llega a la orilla de la zona calculada</b> (40 × 40 km o el límite de los datos): con este nivel el área real sería mayor.</p>}
        </Section>
      )}

      <p className="rh-a-warn"><b>Ilustrativo, no es un pronóstico.</b> {modo === 'rio'
        ? 'Inunda por altura sobre el cauce, sin caudal, lluvia, tiempo, bordos ni drenaje, y el agua sube parejo en todo el tramo.'
        : 'Es un modelo de «tina»: llena el terreno hasta un nivel, sin caudal, lluvia, tiempo, bordos ni drenaje; en un río el agua se iría río abajo (usa «Río que crece»).'}
        {' '}El relieve de 30 m tiene errores de metros en lo plano y no ve bordos, puentes ni edificios.</p>
      <Note>Calculado en el navegador con el relieve de 30 m de INEGI (y el flujo a 90 m para el cauce). Las presas y lagos del uso de suelo no cuentan como área inundada. Localidades y servicios por su punto: una localidad cuenta si su centro queda bajo el agua.</Note>
    </>
  );
}
