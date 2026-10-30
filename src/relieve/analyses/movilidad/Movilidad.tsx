import { useEffect, useMemo, useRef } from 'react';
import type { PointsHandle } from '../../engine/mapApi';
import { makeGeo } from '../../shared/geo';
import type { Traslados } from '../datasets';
import { fmtInt, fmtShort, hexToRgba } from '../scales';
import type { AnalysisProps } from '../types';
import { Bars, Chips, Facts, Loading, Note, Section, Seg, Stats, oneOf, parseMuni, useAsync, useLinked } from '../ui';

type Tipo = 'trabajo' | 'escuela';
/** salen del municipio elegido (o todos los flujos sin elegir) y llegan a él */
const SALEN = '#3987e5', LLEGAN = '#d95926';
const MINIMOS = [50, 100, 200, 500, 1000, 2000, 5000];
/** registros de la muestra con que un flujo ya es razonablemente preciso */
const MIN_N = 20;
/** los destinos lejanos se dibujan en su dirección a esta distancia (km) del centro del estado */
const CENTRO: [number, number] = [-98.9, 20.5], RMAX = 170;
const TIEMPOS = ['Hasta 15 min', '16–30 min', '31 min a 1 h', '1 a 2 h', 'Más de 2 h'];
const MEDIOS = ['Sin dato', 'Caminando', 'Bicicleta', 'Metro o tren', 'Trolebús', 'Metrobús', 'Camión, combi o colectivo', 'Transporte de personal o escolar', 'Taxi', 'Taxi por aplicación', 'Motocicleta', 'Automóvil o camioneta', 'Otro'];
const VERBO: Record<Tipo, [string, string]> = { trabajo: ['trabajan', 'trabajo'], escuela: ['estudian', 'escuela'] };
const widthOf = (f: number) => Math.min(11, 1 + 10 * Math.sqrt(f / 35000));
const pct = (a: number, b: number) => (b > 0 ? `${((100 * a) / b).toFixed(a / b < 0.1 ? 1 : 0)} %` : '—');

export default function Movilidad({ ctx }: AnalysisProps) {
  const { map, data, meta, link } = ctx;
  const geo = useMemo(() => makeGeo(meta), [meta]);
  const [dat, err] = useAsync(() => data.movilidad(), [data]);
  const [tipo, setTipo] = useLinked<Tipo>(link, 'tipo', 'trabajo', oneOf('trabajo', 'escuela'));
  const [mun, setMun] = useLinked(link, 'mun', 0, parseMuni);
  const [minimo, setMinimo] = useLinked(link, 'min', 500, s => (MINIMOS.includes(Number(s)) ? Number(s) : undefined));
  const [todas, setTodas] = useLinked(link, 'muestra', false, s => (s === 'todas' ? true : undefined), v => (v ? 'todas' : ''));
  const dots = useRef<PointsHandle | null>(null);

  // posición dibujada de cada lugar: los lejanos, en su dirección a RMAX km del centro
  const pos = useMemo(() => dat?.lugares.map(l => {
    const dx = (l.lon - CENTRO[0]) * geo.KX, dz = (l.lat - CENTRO[1]) * geo.KZ, d = Math.hypot(dx, dz), k = d > RMAX ? RMAX / d : 1;
    return [CENTRO[0] + (l.lon - CENTRO[0]) * k, CENTRO[1] + (l.lat - CENTRO[1]) * k, d] as [number, number, number];
  }) ?? [], [dat, geo]);

  const shown = useMemo(() => (dat ? dat.flujos[tipo].filter(([o, p, f, n]) => (todas || n >= MIN_N) && f >= minimo && (!mun || o === mun - 1 || p === mun - 1)) : []), [dat, tipo, todas, minimo, mun]);

  useEffect(() => { map.select(mun); }, [map, mun]);

  // arcos: del origen (tenue) al destino (fuerte); con un municipio elegido, azul lo que sale y naranja lo que llega
  useEffect(() => {
    if (!shown.length || !pos.length) return;
    const n = shown.length, lon0 = new Float32Array(n), lat0 = new Float32Array(n), lon1 = new Float32Array(n), lat1 = new Float32Array(n);
    const width = new Float32Array(n), color = new Uint8Array(n * 4);
    shown.forEach(([o, p, f], i) => {
      lon0[i] = pos[o][0]; lat0[i] = pos[o][1]; lon1[i] = pos[p][0]; lat1[i] = pos[p][1];
      width[i] = widthOf(f);
      color.set(hexToRgba(mun && p === mun - 1 ? LLEGAN : SALEN, 240), i * 4);
    });
    const h = map.addArcs({ lon0, lat0, lon1, lat1, width, color, lift: 0.12 });
    return () => h.dispose();
  }, [map, shown, pos, mun]);

  // lugares de los flujos dibujados (destinos de fuera incluidos), con lo que sale y llega en la vista
  useEffect(() => {
    if (!dat || !shown.length) return;
    const n = dat.lugares.length, salen = new Float64Array(n), llegan = new Float64Array(n);
    for (const [o, p, f] of shown) { salen[o] += f; llegan[p] += f; }
    const idx = [...Array(n).keys()].filter(i => salen[i] || llegan[i]);
    const color = new Uint8Array(idx.length * 4), size = new Float32Array(idx.length);
    idx.forEach((i, k) => {
      color.set(hexToRgba(i >= 84 ? '#eef1f5' : '#c3cad6'), k * 4);
      size[k] = Math.min(12, 4 + 1.2 * Math.log10(1 + salen[i] + llegan[i]));
    });
    const h = map.addPoints({
      shape: 'dot', lon: Float32Array.from(idx, i => pos[i][0]), lat: Float32Array.from(idx, i => pos[i][1]), color, size, pickable: true,
      tooltip: k => {
        const i = idx[k], l = dat.lugares[i], far = pos[i][2] > RMAX;
        return {
          title: l.nombre + (l.en ? ` (sobre todo ${l.en})` : ''),
          lines: [
            ...(llegan[i] ? [`Llegan ${fmtInt(llegan[i])} personas en los flujos del mapa`] : []),
            ...(salen[i] ? [`Salen ${fmtInt(salen[i])} personas en los flujos del mapa`] : []),
            ...(far ? [`A ${fmtInt(pos[i][2])} km: se dibuja más cerca`] : []),
            ...(i < 84 ? ['Clic para ver sus traslados'] : []),
          ],
        };
      },
    });
    dots.current = h;
    return () => { h.dispose(); dots.current = null; };
  }, [map, dat, shown, pos]);

  useEffect(() => map.onClick(hit => {
    if (hit.point && hit.point.layer === dots.current && dat) {
      // el índice del punto es el del lugar entre los que tienen flujo; se busca por posición
      const k = hit.point.index, spec = dots.current.spec, lon = spec.lon[k], lat = spec.lat[k];
      const i = pos.findIndex(p => p[0] === lon && p[1] === lat);
      if (i >= 0 && i < 84) setMun(i + 1);
      return true;
    }
    setMun(hit.municipio);
    return true;
  }), [map, dat, pos, setMun]);

  useEffect(() => map.onHover(hit => {
    if (!dat || !hit.municipio) return null;
    const R = dat.municipios[tipo][hit.municipio - 1], fuera = R.hgo + R.fuera + R.ext;
    return [`${VERBO[tipo][0][0].toUpperCase()}${VERBO[tipo][0].slice(1)} fuera de su municipio: ${pct(fuera, R.total)} (${fmtInt(fuera)} de ${fmtInt(R.total)})`];
  }), [map, dat, tipo]);

  const resumen = useMemo(() => {
    if (!dat) return null;
    const list = dat.municipios[tipo], sum = (k: keyof Omit<Traslados, 'tiempo' | 'medio'>) => list.reduce((s, R) => s + R[k], 0);
    const tot = { total: sum('total'), mismo: sum('mismo'), hgo: sum('hgo'), fuera: sum('fuera'), ext: sum('ext') };
    // fuera del estado, por entidad (el Estado de México con lo que no tiene lugar)
    const porEnt = new Map<number, number>();
    for (const [, p, f] of dat.flujos[tipo]) { const e = dat.lugares[p].ent; if (e !== 13) porEnt.set(e, (porEnt.get(e) ?? 0) + f); }
    porEnt.set(15, (porEnt.get(15) ?? 0) + dat.sinLugar[tipo].edomex);
    const nombreEnt = (e: number) => (e === 9 ? 'Ciudad de México' : e === 15 ? 'Estado de México' : dat.lugares.find(l => l.ent === e)?.nombre ?? `Estado ${e}`);
    const ents = [...porEnt].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([e, f]) => ({ id: e, label: nombreEnt(e), value: f, text: fmtShort(f) }));
    const atraen = new Map<number, number>();
    for (const [, p, f] of dat.flujos[tipo]) if (p < 84) atraen.set(p, (atraen.get(p) ?? 0) + f);
    return { tot, ents, atraen: [...atraen].sort((a, b) => b[1] - a[1]).slice(0, 6) };
  }, [dat, tipo]);

  if (err) return <Note>No se pudieron cargar los traslados: {err}</Note>;
  if (!dat || !resumen) return <Loading text="Cargando los traslados del censo…" />;
  const name = (i: number) => dat.lugares[i]?.nombre ?? '';
  const R = mun ? dat.municipios[tipo][mun - 1] : null;
  const fl = dat.flujos[tipo];
  const van = mun ? fl.filter(x => x[0] === mun - 1).slice(0, 8) : [], llegan = mun ? fl.filter(x => x[1] === mun - 1) : [];
  const llegaTot = llegan.reduce((s, x) => s + x[2], 0);
  const [verbo, cosa] = VERBO[tipo];
  const t = resumen.tot;
  const rowsOf = (list: [number, number, number, number][], end: 0 | 1) => list.map(([o, p, f, n]) => ({
    id: end ? o : p, label: name(end ? o : p) + (n < MIN_N ? ' · muestra chica' : ''), value: f, text: fmtInt(f), color: end ? LLEGAN : SALEN,
  }));
  return (
    <>
      <Section title="Traslados">
        <Seg label="Tipo de traslado" value={tipo} onChange={setTipo} options={[['trabajo', 'Al trabajo'], ['escuela', 'A la escuela']]} />
        <div className="rh-ctl">
          <div className="rh-head"><label htmlFor="rh-min">Flujos de al menos</label><output htmlFor="rh-min">{fmtInt(minimo)} personas</output></div>
          <input id="rh-min" type="range" min={0} max={MINIMOS.length - 1} step={1} value={MINIMOS.indexOf(minimo)} onChange={e => setMinimo(MINIMOS[+e.target.value])} />
        </div>
        <Chips label="Muestra" value={todas ? 'todas' : ''} onToggle={() => setTodas(v => !v)} options={[['todas', `Incluir flujos con menos de ${MIN_N} registros`]]} />
        <div className="rh-a-legend">
          <span className="rh-a-keyrow rh-mono"><i style={{ background: SALEN }} />{mun ? `salen de ${name(mun - 1)}` : 'del municipio donde viven al de su ' + cosa}{mun ? <><i style={{ background: LLEGAN, marginLeft: 10 }} />llegan</> : null}</span>
        </div>
        <Note>{shown.length} flujos en el mapa: el grosor es proporcional a las personas y el arco se ve más fuerte en el destino. {mun ? 'Clic en otro municipio para cambiar; fuera del estado, para ver todo Hidalgo.' : 'Clic en un municipio para ver de dónde y adónde se mueve su gente.'}</Note>
      </Section>

      {!R && (
        <Section title="Hidalgo">
          <p className="rh-a-lead">De <b>{fmtShort(t.total)}</b> personas que {verbo}, {pct(t.mismo, t.total)} lo hace en su municipio, <b>{pct(t.hgo, t.total)}</b> en otro de Hidalgo y <b>{pct(t.fuera + t.ext, t.total)}</b> fuera del estado.</p>
          <Stats items={[[fmtShort(t.hgo), 'A otro municipio de Hidalgo'], [fmtShort(t.fuera), 'A otro estado'], [fmtShort(t.ext), 'Al extranjero']]} />
          <div className="rh-a-sechead"><h3>Fuera del estado</h3></div>
          <Bars color={SALEN} rows={resumen.ents} />
          <div className="rh-a-sechead"><h3>Los flujos más grandes</h3></div>
          <Bars color={SALEN} onPick={id => setMun(Math.floor(Number(id) / 1000) + 1)} rows={fl.slice(0, 8).map(([o, p, f]) => ({ id: o * 1000 + p, label: `${name(o)} → ${name(p)}`, value: f, text: fmtInt(f) }))} />
          <div className="rh-a-sechead"><h3>Municipios que más atraen</h3></div>
          <Bars color={LLEGAN} onPick={id => setMun(Number(id) + 1)} rows={resumen.atraen.map(([p, f]) => ({ id: p, label: name(p), value: f, text: `${fmtShort(f)} llegan` }))} />
        </Section>
      )}

      {R && (
        <Section title={name(mun - 1)} aside={<button type="button" className="rh-a-link" onClick={() => setMun(0)}>Ver todo Hidalgo</button>}>
          <p className="rh-a-lead">Aquí viven <b>{fmtInt(R.total)}</b> personas que {verbo}: {pct(R.mismo, R.total)} en su municipio, <b>{pct(R.hgo, R.total)}</b> en otro de Hidalgo y <b>{pct(R.fuera + R.ext, R.total)}</b> fuera del estado. Llegan <b>{fmtInt(llegaTot)}</b> de otros municipios de Hidalgo.</p>
          <div className="rh-a-sechead"><h3>Adónde van</h3></div>
          {van.length ? <Bars color={SALEN} onPick={id => Number(id) < 84 && setMun(Number(id) + 1)} rows={rowsOf(van, 0)} /> : <Note>Casi nadie sale del municipio.</Note>}
          <div className="rh-a-sechead"><h3>De dónde llegan</h3></div>
          {llegan.length ? <Bars color={LLEGAN} onPick={id => setMun(Number(id) + 1)} rows={rowsOf(llegan.slice(0, 8), 1)} /> : <Note>No llegan personas de otros municipios de Hidalgo en la muestra.</Note>}
          <div className="rh-a-sechead"><h3>Cuánto tardan</h3></div>
          <Bars color={SALEN} max={R.total} rows={TIEMPOS.map((l, k) => ({ id: k, label: l, value: R.tiempo[k + 1], text: pct(R.tiempo[k + 1], R.total) }))} />
          <Facts items={[...R.medio.map((v, k) => [k, v] as const)].filter(([k]) => k > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => [MEDIOS[k], pct(v, R.total)] as [string, string])} />
          {R.n < 400 && <p className="rh-a-warn"><b>Muestra chica:</b> {fmtInt(R.n)} personas encuestadas en el municipio; las cifras de flujos pequeños son aproximadas.</p>}
        </Section>
      )}

      <Note>
        INEGI, Censo de Población y Vivienda 2020, muestra (cuestionario ampliado): municipio donde trabajó la semana anterior o donde está su
        escuela, con el factor de expansión. Solo cuenta a quienes viven en Hidalgo: quien vive en otro estado y viene a trabajar aquí no aparece.
        La Ciudad de México va como un solo lugar (la mitad no dijo la alcaldía); del Estado de México se dibujan los municipios con más de 300
        personas ({fmtShort(dat.sinLugar[tipo].edomex)} más van a uno sin especificar o pequeño). Los estados lejanos se dibujan en su dirección,
        más cerca. Los flujos con menos de {MIN_N} registros de la muestra son imprecisos y se ocultan si no se piden.
      </Note>
    </>
  );
}
