import { useEffect, useMemo, useRef, useState } from 'react';
import type { LinesHandle } from '../../engine/mapApi';
import { ROAD_CLASSES } from '../../shared/routing';
import { SERVICE_TYPES } from '../../shared/servicios';
import { TIME_BREAKS, TIME_LABELS, TIME_RAMP, classOf, fmtInt, fmtMin, fmtPct, hexToRgba } from '../scales';
import type { AnalysisProps } from '../types';
import { Bars, Chips, Facts, Loading, Note, Section, Seg, useAsync } from '../ui';
import type { Computed, RouteResult } from './router';

type Sector = 'pub' | 'todos';
type Modo = 'cercano' | 'ab';
const ROUTE_COLOR = '#ffcf7a';
const SERVICE_DOT = '#8fd3f0';

/** Imagen de tiempos por celda, recortada al estado: claro = cerca, oscuro = lejos. */
export function timeImage(cellMin: Uint16Array, grid: Uint8Array, W: number, H: number) {
  const rgba = new Uint8Array(W * H * 4), lut = TIME_RAMP.map(c => hexToRgba(c));
  for (let i = 0; i < W * H; i++) {
    if (!grid[i]) continue;
    const t = cellMin[i];
    if (t === 65535) { rgba.set([40, 40, 46, 200], i * 4); continue; }
    const c = classOf(t, TIME_BREAKS);
    rgba.set(lut[c], i * 4);
    rgba[i * 4 + 3] = 70 + c * 30;
  }
  return { width: W, height: H, rgba };
}

export default function Accesibilidad({ ctx }: AnalysisProps) {
  const { map, data, meta } = ctx;
  const router = data.router();
  const [base, err] = useAsync(() => Promise.all([router.ready, data.servicios(), data.localidades()]), [router]);
  const [tipo, setTipo] = useState('hospital');
  const [sector, setSector] = useState<Sector>('pub');
  const [modo, setModo] = useState<Modo>('cercano');
  const [roadsOn, setRoadsOn] = useState(true);
  const [timesOn, setTimesOn] = useState(true);
  const [res, setRes] = useState<Computed | null>(null);
  const [busy, setBusy] = useState(false);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [routeErr, setRouteErr] = useState('');
  const [abA, setAbA] = useState<[number, number] | null>(null);
  const roads = useRef<LinesHandle | null>(null);
  const t = SERVICE_TYPES.findIndex(s => s.id === tipo), type = SERVICE_TYPES[t];
  const [ready, srv, loc] = base ?? [];

  // servicios elegidos (índices en servicios)
  const chosen = useMemo(() => {
    if (!srv) return [];
    const out: number[] = [];
    for (let i = 0; i < srv.n; i++) if (srv.tipo[i] === t && (sector === 'todos' || srv.publico[i])) out.push(i);
    return out;
  }, [srv, t, sector]);

  // red vial, coloreada por tipo de vía
  useEffect(() => {
    if (!ready) return;
    const L = ready.lines, color = new Uint8Array(L.len.length * 4);
    // solo se dibujan las vías dentro de Hidalgo; las de los estados vecinos siguen contando para las rutas
    for (let e = 0; e < L.len.length; e++) {
      const mid = L.start[e] + (L.len[e] >> 1);
      if (map.municipioAt(L.lon[mid], L.lat[mid])) color.set(hexToRgba(ROAD_CLASSES[L.cls[e]].color, L.cls[e] >= 5 ? 130 : 235), e * 4);
    }
    const h = map.addLines({ lon: L.lon, lat: L.lat, start: L.start, len: L.len, color });
    roads.current = h;
    return () => { h.dispose(); roads.current = null; };
  }, [map, ready]);
  useEffect(() => { roads.current?.setVisible(roadsOn); }, [roadsOn, ready]);

  // puntos de los servicios
  useEffect(() => {
    if (!srv || !chosen.length) return;
    const lon = Float32Array.from(chosen, i => srv.lon[i]), lat = Float32Array.from(chosen, i => srv.lat[i]);
    const color = new Uint8Array(chosen.length * 4);
    for (let k = 0; k < chosen.length; k++) color.set(hexToRgba(SERVICE_DOT), k * 4);
    const h = map.addPoints({
      shape: 'dot', lon, lat, color, size: tipo === 'hospital' ? 11 : 8, pickable: true,
      tooltip: k => ({ title: srv.nombre[chosen[k]], lines: [srv.detalle[chosen[k]], type.nombre] }),
    });
    return () => h.dispose();
  }, [map, srv, chosen, tipo, type]);

  // tiempos al servicio más cercano (worker)
  useEffect(() => {
    if (!srv || !loc || !ready) return;
    let alive = true;
    setBusy(true); setRoute(null);
    router.compute(`${tipo}:${sector}`, Float32Array.from(chosen, i => srv.lon[i]), Float32Array.from(chosen, i => srv.lat[i]), loc.lon, loc.lat)
      .then(r => { if (alive) { setRes(r); setBusy(false); } }, () => alive && setBusy(false));
    return () => { alive = false; };
  }, [router, srv, loc, ready, chosen, tipo, sector]);

  useEffect(() => { map.setOverlay(res && timesOn ? timeImage(res.cellMin, map.municipioGrid(), meta.W, meta.H) : null, 0.82); }, [map, res, timesOn, meta]);

  useEffect(() => map.onHover(hit => {
    if (!res) return null;
    const c = Math.round((hit.lon - meta.lon0) / meta.step), r = Math.round((meta.lat0 - hit.lat) / meta.step);
    const m = res.cellMin[r * meta.W + c];
    return [m === 65535 ? `Sin camino a ${type.nombre.toLowerCase()}` : `${type.nombre} más cercano: ≈ ${fmtMin(m)}`];
  }), [map, res, meta, type]);

  // clic: ruta al servicio más cercano, o de A a B
  useEffect(() => map.onClick(hit => {
    setRouteErr('');
    if (modo === 'cercano') {
      router.route(hit.lon, hit.lat).then(r => { setRoute(r); if (!r) setRouteErr('No hay camino desde ese punto.'); });
      return true;
    }
    if (!abA) { setAbA([hit.lon, hit.lat]); setRoute(null); map.setPin('A', hit.lon, hit.lat); return true; }
    router.routeAB(abA, [hit.lon, hit.lat]).then(r => { setRoute(r); if (!r) setRouteErr('No hay camino entre esos puntos.'); });
    setAbA(null);
    return true;
  }), [map, router, modo, abA]);

  useEffect(() => {
    if (!route || route.lon.length < 2) return;
    const h = map.addLines({ lon: route.lon, lat: route.lat, start: Uint32Array.of(0), len: Uint32Array.of(route.lon.length), color: Uint8Array.from(hexToRgba(ROUTE_COLOR)), onTop: true, width: 4 });
    const end = route.lon.length - 1;
    const dest = route.source >= 0 && srv ? srv.nombre[chosen[route.source]] : 'Destino';
    map.setPin(dest, route.lon[end], route.lat[end]);
    return () => h.dispose();
  }, [map, route, srv, chosen]);

  if (err) return <Note>No se pudo cargar la red vial: {err}</Note>;
  if (!ready || !srv || !loc) return <Loading text="Cargando red vial y servicios…" />;

  // población por tiempo de traslado
  const pobBy = new Array(TIME_RAMP.length).fill(0);
  let total = 0, far = 0, nofar = 0;
  if (res) for (let i = 0; i < loc.n; i++) {
    const m = res.locMin[i], p = loc.pob[i];
    total += p;
    if (!Number.isFinite(m)) { nofar += p; continue; }
    pobBy[classOf(m, TIME_BREAKS)] += p;
    if (m > 60) far += p;
  }
  const dest = route && route.source >= 0 ? chosen[route.source] : -1;

  return (
    <>
      <Section title="Destino">
        <Chips label="Tipo de servicio" value={tipo} onToggle={setTipo} options={SERVICE_TYPES.map(s => [s.id, s.plural] as [string, string])} />
        <Seg label="Sector" value={sector} onChange={setSector} options={[['pub', 'Públicos'], ['todos', 'Públicos y privados']]} />
        <Note>{fmtInt(chosen.length)} {type.plural.toLowerCase()} ({type.fuente}).{type.aviso ? ` ${type.aviso}` : ''}</Note>
      </Section>

      <Section title="Ruta" aside={busy ? <span className="rh-mono">calculando…</span> : undefined}>
        <Seg label="Modo de ruta" value={modo} onChange={v => { setModo(v); setAbA(null); setRoute(null); map.setPin(null); }} options={[['cercano', 'Al servicio más cercano'], ['ab', 'Entre dos puntos']]} />
        {!route && !routeErr && <Note>{modo === 'cercano' ? 'Haz clic en cualquier punto del mapa.' : abA ? 'Ahora haz clic en el destino.' : 'Haz clic en el origen y luego en el destino.'}</Note>}
        {routeErr && <Note>{routeErr}</Note>}
        {route && (
          <div className="rh-a-route">
            <div className="rh-a-route-time">{fmtMin(route.minutes)}<span>{route.km.toFixed(1)} km</span></div>
            {dest >= 0 && <div className="rh-a-route-dest"><b>{srv.nombre[dest]}</b><span>{srv.detalle[dest]}</span></div>}
            {route.roads.length > 0 && <div className="rh-a-route-via">por {route.roads.join(', ')}</div>}
          </div>
        )}
        <Note>Tiempos estimados sin tráfico: velocidad según el tipo de vía y su pavimento, más lenta en pendientes y curvas, y a pie desde el punto hasta el camino.</Note>
      </Section>

      <Section title={`Población según tiempo a ${type.plural.toLowerCase()}`}>
        {res ? (
          <>
            <p className="rh-a-lead"><b>{fmtInt(far)}</b> personas ({fmtPct((100 * far) / total, 1)}) viven a más de una hora del más cercano{sector === 'pub' ? ' del sector público' : ''}.</p>
            <Bars color={TIME_RAMP[3]} rows={TIME_LABELS.map((l, k) => ({ id: k, label: l, value: pobBy[k], text: fmtInt(pobBy[k]), color: TIME_RAMP[k] }))} />
            {nofar > 0 && <Note>{fmtInt(nofar)} personas en localidades sin camino conectado en el mapa.</Note>}
          </>
        ) : <Loading text="Calculando tiempos…" />}
      </Section>

      <Section title="Capas">
        <Chips label="Capas" value={new Set([...(roadsOn ? ['vias'] : []), ...(timesOn ? ['tiempos'] : [])])}
          onToggle={v => (v === 'vias' ? setRoadsOn(!roadsOn) : setTimesOn(!timesOn))} options={[['vias', 'Carreteras'], ['tiempos', 'Tiempos']]} />
        <Facts items={ROAD_CLASSES.map((c, k) => [c.nombre, <span key={k} className="rh-a-road"><i style={{ background: c.color }} />{fmtInt(ready.kmByClass[k])} km</span>])} />
      </Section>
    </>
  );
}
