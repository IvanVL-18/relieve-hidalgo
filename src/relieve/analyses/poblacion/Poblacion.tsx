import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointsHandle } from '../../engine/mapApi';
import { GRADOS, type Localidades, type Municipio } from '../datasets';
import { POP_RAMP, classOf, fmtInt, fmtPct, fmtShort, hexToRgba, quantileBreaks } from '../scales';
import type { AnalysisProps } from '../types';
import { Bars, ClassLegend, Facts, Loading, Note, Section, Seg, Stats, oneOf, parseMuni, useAsync, useLinked } from '../ui';
import { locIndex, locKey } from '../datasets';

/** Clases de tamaño de localidad (INEGI). */
export const SIZE_BREAKS = [249, 2499, 14999, 99999];
export const SIZE_LABELS = ['1–249', '250–2 499', '2 500–14 999', '15 000–99 999', '100 000 o más'];

type Medida = 'pob' | 'densidad';
type Escala = 'lineal' | 'raiz' | 'no';
type Sel = { kind: 'mun'; id: number } | { kind: 'loc'; i: number } | null;

/** Altura de columna en km: proporcional a la población, o a su raíz para que se vean las pequeñas. */
function heights(l: Localidades, escala: Escala) {
  const max = l.pob[0] || 1, h = new Float32Array(l.n);
  for (let i = 0; i < l.n; i++) h[i] = escala === 'raiz' ? Math.sqrt(l.pob[i] / max) * 14 : (l.pob[i] / max) * 16 + 0.04;
  return h;
}

export default function Poblacion({ ctx }: AnalysisProps) {
  const { map, data, link } = ctx;
  const [all, err] = useAsync(() => Promise.all([data.municipios(), data.localidades()]), []);
  const [medida, setMedida] = useLinked<Medida>(link, 'medida', 'pob', oneOf('pob', 'densidad'));
  const [escala, setEscala] = useLinked<Escala>(link, 'columnas', 'lineal', oneOf('lineal', 'raiz', 'no'));
  const [sel, setSel] = useState<Sel>(() => { const m = parseMuni(link.initial.mun ?? ''); return m ? { kind: 'mun', id: m } : null; });
  const cols = useRef<PointsHandle | null>(null);
  const mun = all?.[0], loc = all?.[1];
  // selección de un enlace: el municipio al abrir; la localidad, cuando llegan los datos
  const linkLoc = useRef<string | undefined>(link.initial.loc);
  useEffect(() => {
    if (sel?.kind === 'mun') map.select(sel.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
  useEffect(() => {
    if (!loc || !linkLoc.current) return;
    const i = locIndex(loc, linkLoc.current);
    linkLoc.current = undefined;
    if (i >= 0) { setSel({ kind: 'loc', i }); map.setPin(loc.nombre[i], loc.lon[i], loc.lat[i]); }
  }, [map, loc]);
  useEffect(() => {
    link.set('mun', sel?.kind === 'mun' ? String(sel.id) : null);
    link.set('loc', sel?.kind === 'loc' && loc ? locKey(loc, sel.i) : linkLoc.current ?? null);
  }, [link, sel, loc]);

  const breaks = useMemo(() => (mun ? quantileBreaks(mun.map(m => m[medida]), 5) : []), [mun, medida]);

  // municipios coloreados por quintiles
  useEffect(() => {
    if (!mun) return;
    map.setMunicipioFill(Object.fromEntries(mun.map(m => [m.cve, POP_RAMP[classOf(m[medida], breaks)]])), 0.8);
  }, [map, mun, medida, breaks]);

  // columnas por localidad
  useEffect(() => {
    if (!loc || escala === 'no') return;
    const color = new Uint8Array(loc.n * 4);
    for (let i = 0; i < loc.n; i++) color.set(hexToRgba(POP_RAMP[classOf(loc.pob[i], SIZE_BREAKS)]), i * 4);
    const size = new Float32Array(loc.n);
    for (let i = 0; i < loc.n; i++) size[i] = 0.2 + 0.07 * classOf(loc.pob[i], SIZE_BREAKS);
    const h = map.addPoints({
      shape: 'column', lon: loc.lon, lat: loc.lat, color, size, height: heights(loc, escala), pickable: true,
      tooltip: i => ({ title: loc.nombre[i], lines: [`${fmtInt(loc.pob[i])} habitantes`, map.meta.names[loc.muni[i] - 1], loc.pob[i] >= 2500 ? 'Urbana' : 'Rural'] }),
    });
    cols.current = h;
    return () => { h.dispose(); cols.current = null; };
    // la escala se cambia sin rehacer la capa (efecto de abajo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, loc, escala === 'no']);
  useEffect(() => { if (loc && cols.current && escala !== 'no') cols.current.setHeights(heights(loc, escala)); }, [loc, escala]);

  // clic: columna → localidad; terreno → municipio
  useEffect(() => map.onClick(hit => {
    if (hit.point) {
      const i = hit.point.index;
      setSel({ kind: 'loc', i });
      if (loc) map.setPin(loc.nombre[i], loc.lon[i], loc.lat[i]);
      return true;
    }
    if (hit.municipio) { setSel({ kind: 'mun', id: hit.municipio }); map.setPin(null); map.select(hit.municipio); return true; }
    setSel(null); map.select(0); map.setPin(null);
    return true;
  }), [map, loc]);

  if (err) return <Note>No se pudieron cargar los datos: {err}</Note>;
  if (!mun || !loc) return <Loading />;

  const total = mun.reduce((s, m) => s + m.pob, 0), urb = mun.reduce((s, m) => s + m.pob_urbana, 0);
  const top = [...mun].sort((a, b) => b[medida] - a[medida]).slice(0, 10);
  const fmtVal = (m: Municipio) => (medida === 'pob' ? fmtInt(m.pob) : `${fmtInt(m.densidad)} hab/km²`);
  const rangeLabels = POP_RAMP.map((_, k) => {
    const lo = k ? breaks[k - 1] : Math.min(...mun.map(m => m[medida])), hi = k < breaks.length ? breaks[k] : Math.max(...mun.map(m => m[medida]));
    return `${fmtShort(lo)}–${fmtShort(hi)}`;
  });
  const m = sel?.kind === 'mun' ? mun[sel.id - 1] : null;
  const li = sel?.kind === 'loc' ? sel.i : -1;

  return (
    <>
      <Stats items={[[fmtInt(total), 'habitantes en 2020'], [fmtPct((100 * urb) / total, 0), 'en localidades urbanas'], [fmtInt(loc.n), 'localidades']]} />

      {m && (
        <Section title={m.nombre} aside={<span className="rh-mono">{m.cve}</span>}>
          <Facts items={[
            ['Habitantes', fmtInt(m.pob)], ['Densidad', `${fmtInt(m.densidad)} hab/km²`],
            ['Mujeres · hombres', `${fmtPct((100 * m.pob_fem) / m.pob, 0)} · ${fmtPct((100 * m.pob_mas) / m.pob, 0)}`],
            ['0–14 · 65+ años', `${fmtPct((100 * m.pob_0_14) / m.pob, 0)} · ${fmtPct((100 * m.pob_65) / m.pob, 0)}`],
            ['Localidades', fmtInt(m.localidades)], ['En localidades urbanas', fmtPct((100 * m.pob_urbana) / m.pob, 0)],
            ['Viviendas habitadas', fmtInt(m.viviendas)], ['Superficie', `${fmtInt(m.area_km2)} km²`],
          ]} />
        </Section>
      )}
      {li >= 0 && (
        <Section title={loc.nombre[li]} aside={<span className="rh-mono">{map.meta.names[loc.muni[li] - 1]}</span>}>
          <Facts items={[
            ['Habitantes', fmtInt(loc.pob[li])], ['Ámbito', loc.pob[li] >= 2500 ? 'Urbano' : 'Rural'],
            ['Mujeres · hombres', `${fmtInt(loc.fem[li])} · ${fmtInt(loc.mas[li])}`],
            ['0–14 · 65+ años', `${fmtInt(loc.p014[li])} · ${fmtInt(loc.p65[li])}`],
            ['Viviendas habitadas', fmtInt(loc.viv[li])], ['Altitud', `${fmtInt(loc.alt[li])} m`],
            ['Marginación (CONAPO)', GRADOS[loc.grado[li]]],
          ]} />
        </Section>
      )}

      <Section title="Municipios">
        <Seg label="Medida" value={medida} onChange={setMedida} options={[['pob', 'Habitantes'], ['densidad', 'Densidad']]} />
        <ClassLegend colors={POP_RAMP} labels={rangeLabels} caption={medida === 'pob' ? 'Habitantes · quintiles' : 'Hab/km² · quintiles'} />
      </Section>

      <Section title="Localidades en 3D">
        <Seg label="Altura de las columnas" value={escala} onChange={setEscala} options={[['lineal', 'Proporcional'], ['raiz', 'Resaltar pequeñas'], ['no', 'Ocultar']]} />
        <ClassLegend colors={POP_RAMP} labels={SIZE_LABELS} caption="Habitantes por localidad" />
        <Note>{escala === 'raiz' ? 'Altura según la raíz cuadrada de la población: las localidades pequeñas se ven, pero las diferencias se comprimen.' : 'La altura es proporcional a la población. Pasa el cursor sobre una columna para ver su localidad.'}</Note>
      </Section>

      <Section title={`10 municipios con más ${medida === 'pob' ? 'habitantes' : 'densidad'}`}>
        <Bars color={POP_RAMP[3]} rows={top.map(t => ({ id: t.id, label: t.nombre, value: t[medida], text: fmtVal(t) }))}
          onHover={id => map.highlight(typeof id === 'number' ? id : (m?.id ?? 0))}
          onPick={id => { setSel({ kind: 'mun', id: id as number }); map.select(id as number, true); }} />
      </Section>
    </>
  );
}
