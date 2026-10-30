import { useEffect, useMemo, useRef } from 'react';
import type { PointsHandle } from '../../engine/mapApi';
import type { Sitio } from '../datasets';
import { GEO_COLORS, PUEBLO_COLOR, hexToRgba } from '../scales';
import type { AnalysisProps } from '../types';
import { Chips, Loading, Note, Section, useAsync, useLinked } from '../ui';

type Grupo = Sitio['grupo'];
const GRUPOS: [Grupo, string][] = [['geologia', 'Geología'], ['biota', 'Biota'], ['cultura', 'Historia y cultura'], ['pueblo', 'Pueblos Mágicos']];
const ALL = GRUPOS.map(g => g[0]);
const parseGroups = (s: string) => { const v = s.split(',').filter((x): x is Grupo => (ALL as string[]).includes(x)); return v.length ? v : undefined; };

/** Renglón de arriba de la ficha: número, interés y municipio, o el año del nombramiento. */
const kicker = (s: Sitio) => (s.tipo === 'pueblo' ? `Pueblo Mágico desde ${s.anio}` : `Geositio ${s.n} · ${s.interes} · ${s.municipio}`);

export default function Geoparque({ ctx }: AnalysisProps) {
  const { map, link, scene } = ctx;
  const [data, error] = useAsync(() => ctx.data.geoparque(), [ctx.data]);
  const [groups, setGroups] = useLinked<Grupo[]>(link, 'ver', ALL, parseGroups, v => v.join(','));
  const [selId, setSelId] = useLinked<string>(link, 'sitio', '', s => s);
  const on = useMemo(() => new Set(groups), [groups]);
  const sites = useMemo(() => data?.sitios ?? [], [data]);
  const visible = useMemo(() => sites.filter(s => on.has(s.grupo)), [sites, on]);
  const sel = sites.find(s => s.id === selId) ?? null;
  const geo = sites.filter(s => s.tipo === 'geositio'), pueblos = sites.filter(s => s.tipo === 'pueblo');
  const count = (g: Grupo) => sites.filter(s => s.grupo === g).length;

  // municipios del geoparque resaltados mientras se ven geositios
  useEffect(() => {
    if (!data) return;
    const any = groups.some(g => g !== 'pueblo');
    map.setMunicipioFill(any ? Object.fromEntries(data.geoparque.municipios.map(c => [c, '#ffcf7a'])) : null, 0.14);
  }, [map, data, groups]);

  // geositios como círculos de color por interés y pueblos como columnas doradas (se distinguen también por la forma)
  const geoLayer = useRef<PointsHandle | null>(null), puebloLayer = useRef<PointsHandle | null>(null);
  useEffect(() => {
    if (!data) return;
    const g = data.sitios.filter(s => s.tipo === 'geositio'), p = data.sitios.filter(s => s.tipo === 'pueblo');
    const tip = (s: Sitio) => ({ title: s.nombre, lines: [kicker(s), 'Clic para ver la ficha'] });
    geoLayer.current = map.addPoints({
      shape: 'dot', lon: Float32Array.from(g, s => s.lon), lat: Float32Array.from(g, s => s.lat),
      color: new Uint8Array(g.length * 4), size: 9, pickable: true, tooltip: k => tip(g[k]),
    });
    puebloLayer.current = map.addPoints({
      shape: 'column', lon: Float32Array.from(p, s => s.lon), lat: Float32Array.from(p, s => s.lat),
      color: new Uint8Array(p.length * 4), size: 0.4, height: new Float32Array(p.length).fill(1.3), pickable: true, tooltip: k => tip(p[k]),
    });
    return () => { geoLayer.current?.dispose(); puebloLayer.current?.dispose(); geoLayer.current = puebloLayer.current = null; };
  }, [map, data]);
  useEffect(() => {
    if (!data) return;
    const paint = (list: Sitio[], h: PointsHandle | null) => {
      if (!h) return;
      const c = new Uint8Array(list.length * 4);
      list.forEach((s, i) => {
        if (!on.has(s.grupo)) return;
        const rgba = hexToRgba(s.tipo === 'pueblo' ? PUEBLO_COLOR : GEO_COLORS[s.grupo as Exclude<Grupo, 'pueblo'>]);
        // el elegido se ve igual, los demás un poco atenuados cuando hay uno elegido
        rgba[3] = sel && sel.id !== s.id ? 200 : 255;
        c.set(rgba, i * 4);
      });
      h.setColors(c);
    };
    paint(data.sitios.filter(s => s.tipo === 'geositio'), geoLayer.current);
    paint(data.sitios.filter(s => s.tipo === 'pueblo'), puebloLayer.current);
  }, [data, on, sel]);

  // clic en un punto: su ficha
  useEffect(() => map.onClick(hit => {
    if (!data || !hit.point) return;
    const list = hit.point.layer === geoLayer.current ? data.sitios.filter(s => s.tipo === 'geositio') : hit.point.layer === puebloLayer.current ? data.sitios.filter(s => s.tipo === 'pueblo') : null;
    if (!list) return;
    setSelId(list[hit.point.index].id);
    return true;
  }), [map, data, setSelId]);
  useEffect(() => { if (sel) map.setPin(sel.nombre, sel.lon, sel.lat); else map.setPin(null); }, [map, sel]);

  const choose = (s: Sitio, fly = true) => {
    setSelId(s.id);
    if (fly) map.flyTo(s.lon, s.lat, s.tipo === 'pueblo' ? 14 : 18);
  };
  const close = () => {
    if (!sel) return;
    // de cerca con la imagen de satélite y el Sol de la tarde (vuelve todo al cerrar el análisis)
    const v = { lon: sel.lon, lat: sel.lat, dist: sel.tipo === 'pueblo' ? 0.07 : 0.085, polar: 62, az: map.getView().az };
    scene.set({ baseMap: 'satelite' });
    void map.prefetch(v);
    void map.setView(v, 2600);
  };
  const step = (d: number) => {
    if (!visible.length) return;
    const i = sel ? visible.findIndex(s => s.id === sel.id) : -1;
    choose(visible[(i + d + visible.length) % visible.length]);
  };
  const toggle = (g: Grupo) => setGroups(on.has(g) ? groups.filter(x => x !== g) : ALL.filter(x => x === g || on.has(x)));

  if (error) return <p className="rh-a-warn">{error}</p>;
  if (!data) return <Loading />;
  return (
    <>
      <p className="rh-a-lead">Los <b>31 geositios</b> del {data.geoparque.nombre} ({data.geoparque.anio}) y los <b>9 Pueblos Mágicos</b> de Hidalgo. Toca un punto para ver su foto y su historia.</p>
      <Section title="Qué mostrar">
        <Chips label="Tipos de sitio" value={on} options={GRUPOS.map(([g, t]) => [g, `${t} · ${count(g)}`] as [Grupo, string])} onToggle={toggle} />
        <div className="rh-a-keys" aria-hidden="true">
          {GRUPOS.slice(0, 3).map(([g, t]) => <span key={g} className="rh-a-keyrow"><i style={{ background: GEO_COLORS[g as Exclude<Grupo, 'pueblo'>], borderRadius: '50%' }} />{t}</span>)}
          <span className="rh-a-keyrow"><i style={{ background: PUEBLO_COLOR, width: 6, height: 12 }} />Pueblo Mágico</span>
          <span className="rh-a-keyrow"><i style={{ background: 'rgba(255,207,122,0.4)' }} />Municipios del geoparque</span>
        </div>
      </Section>

      {sel ? (
        <section className="rh-geo-card" aria-label={sel.nombre}>
          {sel.foto && (
            <figure>
              <img src={sel.foto.url} alt={sel.nombre} loading="lazy" />
              <figcaption>Foto: <a href={sel.foto.pagina} target="_blank" rel="noreferrer">{sel.foto.autor}</a>, {sel.foto.licenciaUrl ? <a href={sel.foto.licenciaUrl} target="_blank" rel="noreferrer">{sel.foto.licencia}</a> : sel.foto.licencia} · Wikimedia Commons</figcaption>
            </figure>
          )}
          <div className="rh-mono">{kicker(sel)}</div>
          <h4>{sel.nombre}</h4>
          <p>{sel.texto}</p>
          <div className="rh-geo-actions">
            <button type="button" className="rh-a-btn" onClick={close}>Ver de cerca</button>
            <button type="button" className="rh-a-btn rh-a-btn2" aria-label="Sitio anterior" onClick={() => step(-1)}>‹</button>
            <button type="button" className="rh-a-btn rh-a-btn2" aria-label="Sitio siguiente" onClick={() => step(1)}>›</button>
          </div>
          <button type="button" className="rh-a-link" onClick={() => setSelId('')}>Cerrar ficha</button>
        </section>
      ) : <Note>Elige un sitio en el mapa o en la lista.</Note>}

      {groups.some(g => g !== 'pueblo') && (
        <Section title={`Geositios (${geo.filter(s => on.has(s.grupo)).length})`}>
          <ol className="rh-tour-list">
            {geo.filter(s => on.has(s.grupo)).map(s => (
              <li key={s.id}><button type="button" aria-current={s.id === selId} onClick={() => choose(s)}><span>{s.n}</span>{s.nombre}</button></li>
            ))}
          </ol>
        </Section>
      )}
      {on.has('pueblo') && (
        <Section title="Pueblos Mágicos">
          <ol className="rh-tour-list">
            {pueblos.map(s => (
              <li key={s.id}><button type="button" aria-current={s.id === selId} onClick={() => choose(s)}><span>{s.anio}</span>{s.nombre}</button></li>
            ))}
          </ol>
        </Section>
      )}
      <Note>
        El geoparque tiene cuatro georrutas: {data.geoparque.rutas.join(', ')}. El recorrido «Geoparque Comarca Minera» (en Recorridos guiados)
        vuela por los geositios principales. Ubicación de los geositios: Canet et al. (2017), Terra Digitalis (UNAM); fotos de Wikimedia
        Commons con su autor y licencia.
      </Note>
    </>
  );
}
