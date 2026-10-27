import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointsHandle } from '../../engine/mapApi';
import { fold } from '../../engine/search';
import { SERVICE_TYPES } from '../../shared/servicios';
import { GRADOS } from '../datasets';
import { SIZE_BREAKS, SIZE_LABELS } from '../poblacion/Poblacion';
import { MARG_RAMP, POP_RAMP, TIME_BREAKS, TIME_LABELS, TIME_RAMP, classOf, fmtInt, fmtMin, hexToRgba } from '../scales';
import type { AnalysisProps } from '../types';
import { Bars, Chips, ClassLegend, Facts, Loading, Note, Section, Seg, useAsync } from '../ui';

type ColorBy = 'tamano' | 'marginacion' | 'hospital';
const NO_DATA = '#5a5f6b';
const SIZE_IDS = ['0', '1', '2', '3', '4'];

export default function Localidades({ ctx }: AnalysisProps) {
  const { map, data } = ctx;
  const [loc, err] = useAsync(() => data.localidades(), []);
  const [sizes, setSizes] = useState(() => new Set(SIZE_IDS));
  const [colorBy, setColorBy] = useState<ColorBy>('tamano');
  const [muni, setMuni] = useState(0);
  const [onlyMuni, setOnlyMuni] = useState(false);
  const [sel, setSel] = useState(-1);
  const [q, setQ] = useState('');
  const [times, setTimes] = useState<{ hospital?: Float32Array; salud?: Float32Array; error?: string }>({});
  const dots = useRef<PointsHandle | null>(null);

  // tiempos a hospital y centro de salud públicos (para aislamiento); el worker los calcula en orden
  useEffect(() => {
    if (!loc) return;
    let alive = true;
    const router = data.router();
    Promise.all([router.ready, data.servicios()]).then(async ([, srv]) => {
      const pick = (id: string) => { const t = SERVICE_TYPES.findIndex(s => s.id === id), idx: number[] = []; for (let i = 0; i < srv.n; i++) if (srv.tipo[i] === t && srv.publico[i]) idx.push(i); return idx; };
      const run = async (id: string) => { const idx = pick(id); return (await router.compute(`${id}:pub`, Float32Array.from(idx, i => srv.lon[i]), Float32Array.from(idx, i => srv.lat[i]), loc.lon, loc.lat)).locMin; };
      const salud = await run('salud');
      const hospital = await run('hospital');
      if (alive) setTimes({ hospital, salud });
    }).catch(e => alive && setTimes({ error: e instanceof Error ? e.message : String(e) }));
    return () => { alive = false; };
  }, [data, loc]);

  const visible = useMemo(() => {
    if (!loc) return new Uint8Array(0);
    const v = new Uint8Array(loc.n);
    for (let i = 0; i < loc.n; i++) v[i] = sizes.has(String(classOf(loc.pob[i], SIZE_BREAKS))) && (!onlyMuni || !muni || loc.muni[i] === muni) ? 1 : 0;
    return v;
  }, [loc, sizes, onlyMuni, muni]);

  // capa de puntos (una vez); colores y filtros se actualizan sin rehacerla
  useEffect(() => {
    if (!loc) return;
    const max = loc.pob[0] || 1, size = new Float32Array(loc.n);
    for (let i = 0; i < loc.n; i++) size[i] = 3 + Math.sqrt(loc.pob[i] / max) * 16;
    const h = map.addPoints({
      shape: 'dot', lon: loc.lon, lat: loc.lat, color: new Uint8Array(loc.n * 4), size, pickable: true,
      tooltip: i => ({ title: loc.nombre[i], lines: [`${fmtInt(loc.pob[i])} habitantes`, map.meta.names[loc.muni[i] - 1], `Marginación: ${GRADOS[loc.grado[i]].toLowerCase()}`] }),
    });
    dots.current = h;
    return () => { h.dispose(); dots.current = null; };
  }, [map, loc]);

  useEffect(() => {
    if (!loc || !dots.current) return;
    const c = new Uint8Array(loc.n * 4), hosp = times.hospital;
    for (let i = 0; i < loc.n; i++) {
      const hex = colorBy === 'tamano' ? POP_RAMP[classOf(loc.pob[i], SIZE_BREAKS)]
        : colorBy === 'marginacion' ? (loc.grado[i] ? MARG_RAMP[loc.grado[i] - 1] : NO_DATA)
        : hosp && Number.isFinite(hosp[i]) ? TIME_RAMP[classOf(hosp[i], TIME_BREAKS)] : NO_DATA;
      c.set(hexToRgba(hex, visible[i] ? 255 : 0), i * 4);
    }
    dots.current.setColors(c);
  }, [loc, colorBy, visible, times]);

  useEffect(() => map.onClick(hit => {
    if (hit.point && loc) {
      const i = hit.point.index;
      setSel(i); setMuni(loc.muni[i]); map.setPin(loc.nombre[i], loc.lon[i], loc.lat[i]);
      return true;
    }
    setMuni(hit.municipio); map.select(hit.municipio); setSel(-1); map.setPin(null);
    return true;
  }), [map, loc]);

  const results = useMemo(() => {
    if (!loc || fold(q).length < 2) return [];
    const f = fold(q), out: number[] = [];
    for (let i = 0; i < loc.n && out.length < 8; i++) if (fold(loc.nombre[i]).includes(f)) out.push(i);
    return out;
  }, [loc, q]);

  if (err) return <Note>No se pudieron cargar las localidades: {err}</Note>;
  if (!loc) return <Loading />;

  const go = (i: number) => { setSel(i); setMuni(loc.muni[i]); map.setPin(loc.nombre[i], loc.lon[i], loc.lat[i]); map.flyTo(loc.lon[i], loc.lat[i], 12); };
  let shown = 0, shownPob = 0;
  for (let i = 0; i < loc.n; i++) if (visible[i]) { shown++; shownPob += loc.pob[i]; }
  const hosp = times.hospital, salud = times.salud;
  const isolated = hosp ? Array.from({ length: loc.n }, (_, i) => i).filter(i => visible[i] && loc.pob[i] >= 100 && Number.isFinite(hosp[i])).sort((a, b) => hosp[b] - hosp[a]).slice(0, 12) : [];
  let over2h = 0, over2hPob = 0;
  if (hosp) for (let i = 0; i < loc.n; i++) if (hosp[i] > 120) { over2h++; over2hPob += loc.pob[i]; }

  return (
    <>
      <Section title="Buscar localidad">
        <input className="rh-a-input" type="search" placeholder="Nombre de la localidad" value={q} onChange={e => setQ(e.target.value)} aria-label="Buscar localidad del censo" />
        {results.length > 0 && <Bars color={POP_RAMP[3]} rows={results.map(i => ({ id: i, label: `${loc.nombre[i]} · ${map.meta.names[loc.muni[i] - 1]}`, value: loc.pob[i], text: fmtInt(loc.pob[i]) }))} onPick={id => go(id as number)} />}
      </Section>

      {sel >= 0 && (
        <Section title={loc.nombre[sel]} aside={<span className="rh-mono">{map.meta.names[loc.muni[sel] - 1]}</span>}>
          <Facts items={[
            ['Habitantes', fmtInt(loc.pob[sel])], ['Ámbito', loc.pob[sel] >= 2500 ? 'Urbano' : 'Rural'],
            ['Altitud', `${fmtInt(loc.alt[sel])} m`], ['Pendiente del entorno', `${loc.pend[sel]}°`],
            ['Marginación (CONAPO)', GRADOS[loc.grado[sel]]], ['Índice', Number.isFinite(loc.im[sel]) ? loc.im[sel].toFixed(1) : '—'],
            ['Al hospital público', hosp ? fmtMin(hosp[sel]) : '…'], ['Al centro de salud público', salud ? fmtMin(salud[sel]) : '…'],
          ]} />
        </Section>
      )}

      <Section title="Filtrar por tamaño" aside={<span className="rh-mono">{fmtInt(shown)} · {fmtInt(shownPob)} hab.</span>}>
        <Chips label="Tamaño de localidad" value={sizes} options={SIZE_IDS.map((id, k) => [id, SIZE_LABELS[k]] as [string, string])}
          onToggle={id => { const s = new Set(sizes); if (s.has(id)) s.delete(id); else s.add(id); setSizes(s); }} />
        {muni > 0 && <Chips label="Municipio" value={onlyMuni ? 'm' : ''} options={[['m', `Solo ${map.meta.names[muni - 1]}`]]} onToggle={() => setOnlyMuni(!onlyMuni)} />}
      </Section>

      <Section title="Color">
        <Seg label="Colorear por" value={colorBy} onChange={setColorBy} options={[['tamano', 'Tamaño'], ['marginacion', 'Marginación'], ['hospital', 'Al hospital']]} />
        {colorBy === 'tamano' && <ClassLegend colors={POP_RAMP} labels={SIZE_LABELS} caption="Habitantes" />}
        {colorBy === 'marginacion' && <ClassLegend colors={[...MARG_RAMP, NO_DATA]} labels={[...GRADOS.slice(1), 'Sin dato']} caption="Grado de marginación (CONAPO 2020)" />}
        {colorBy === 'hospital' && <ClassLegend colors={TIME_RAMP} labels={TIME_LABELS} caption="Tiempo al hospital público más cercano" />}
      </Section>

      <Section title="Las más aisladas">
        {times.error ? <Note>No se pudieron calcular los tiempos: {times.error}</Note> : !hosp ? <Loading text="Calculando tiempos por carretera…" /> : (
          <>
            <p className="rh-a-lead"><b>{fmtInt(over2h)}</b> localidades, con {fmtInt(over2hPob)} habitantes, están a más de 2 horas del hospital público más cercano.</p>
            <Bars color={TIME_RAMP[4]} max={Math.max(...isolated.map(i => hosp[i]))}
              rows={isolated.map(i => ({ id: i, label: `${loc.nombre[i]} · ${fmtInt(loc.pob[i])} hab.`, value: hosp[i], text: fmtMin(hosp[i]), color: TIME_RAMP[classOf(hosp[i], TIME_BREAKS)] }))}
              onPick={id => go(id as number)} />
            <Note>Localidades de 100 habitantes o más (entre las filtradas), ordenadas por tiempo estimado al hospital público más cercano.</Note>
          </>
        )}
      </Section>
    </>
  );
}
