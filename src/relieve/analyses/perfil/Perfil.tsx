import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointsHandle } from '../../engine/mapApi';
import { fmtPoints, parsePoints } from '../../shared/enlaces';
import { makeGeo } from '../../shared/geo';
import type { Profile } from '../../shared/terrain';
import { SLOPE_BREAKS, SLOPE_LABELS, SLOPE_RAMP, classOf, fmtInt, fmtMin, hexToRgba } from '../scales';
import type { AnalysisProps } from '../types';
import { Bars, Examples, Facts, Loading, Note, Section, Seg, Stats, oneOf, saveBlob, useLinked } from '../ui';
import { ProfileChart, type ChartMark } from './ProfileChart';
import { profileCsv, profileStats, slopeText, type ProfileStats } from './profile';
import { profilePng } from './png';

type Modo = 'recta' | 'carretera';
const MAX_PTS: Record<Modo, number> = { recta: 12, carretera: 8 };
const LETTERS = 'ABCDEFGHIJKL';
const VERTEX = '#eef1f5', CASING: [number, number, number, number] = [12, 17, 27, 255];
const CREDITS = 'Relieve: INEGI, Continental relief 2016 (30 m), vía Terrain Tiles · Relieve de Hidalgo';

/** Trazos de ejemplo: un corte de la Huasteca al Mezquital, una barranca y dos carreteras de montaña. */
const EJEMPLOS: [string, string, Modo, [number, number][]][] = [
  ['sierra', 'Huasteca → Mezquital', 'recta', [[-98.4194, 21.1404], [-99.2163, 20.4836]]],
  ['barranca', 'Barranca de Metztitlán', 'recta', [[-98.862, 20.566], [-98.738, 20.694]]],
  ['real', 'Pachuca → Real del Monte', 'carretera', [[-98.7333, 20.1167], [-98.6728, 20.1386]]],
  ['jacala', 'Zimapán → Jacala', 'carretera', [[-99.38, 20.7383], [-99.1903, 21.0083]]],
];

interface Result {
  prof: Profile;
  st: ProfileStats;
  marks: ChartMark[];
  /** por carretera: tiempo (flujo libre), km y carreteras principales */
  route: { minutes: number; km: number; roads: string[] } | null;
  munis: { id: number; km: number }[];
}

const fmtKm = (km: number) => (km >= 100 ? fmtInt(km) : km.toFixed(1));
const fmtSlope = (g: number) => `${g.toFixed(0)} % (${((Math.atan(g / 100) * 180) / Math.PI).toFixed(0)}°)`;
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

export default function Perfil({ ctx }: AnalysisProps) {
  const { map, data, meta, link } = ctx;
  const geo = useMemo(() => makeGeo(meta), [meta]);
  const [modo, setModo] = useLinked<Modo>(link, 'modo', 'recta', oneOf('recta', 'carretera'));
  const [pts, setPts] = useLinked<[number, number][]>(link, 'pts', [], s => parsePoints(s, 12), fmtPoints);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [hover, setHover] = useState(-1);
  const verts = useRef<PointsHandle | null>(null);
  const lastClick = useRef({ t: 0, lon: 0, lat: 0 });

  // clic: agrega un punto; clic sobre un punto: lo quita
  useEffect(() => map.onClick(hit => {
    if (hit.point && hit.point.layer === verts.current) {
      const k = hit.point.index;
      setPts(p => p.filter((_, i) => i !== k));
      return true;
    }
    const now = performance.now(), L = lastClick.current;
    // segundo clic de un doble clic (el mapa vuela ahí): no es otro punto
    if (now - L.t < 400 && Math.hypot(hit.lon - L.lon, hit.lat - L.lat) < 0.01) return true;
    lastClick.current = { t: now, lon: hit.lon, lat: hit.lat };
    setPts(p => (p.length >= MAX_PTS[modo] ? p : [...p, [hit.lon, hit.lat]]));
    return true;
  }), [map, modo, setPts]);

  // perfil: por carretera, primero la ruta de cada tramo con el router de accesibilidad
  useEffect(() => {
    if (pts.length < 2) { setRes(null); setErr(''); setBusy(false); return; }
    let alive = true;
    setBusy(true); setErr('');
    (async (): Promise<Result> => {
      const lon: number[] = [], lat: number[] = [], legEnds: number[] = [];
      let route: Result['route'] = null;
      if (modo === 'carretera') {
        const router = data.router();
        await router.ready;
        let minutes = 0, km = 0;
        const roads: string[] = [];
        for (let k = 1; k < pts.length; k++) {
          const leg = await router.routeAB(pts[k - 1], pts[k]);
          if (!leg || leg.lon.length < 2) throw new Error(`no hay camino por carretera entre ${LETTERS[k - 1]} y ${LETTERS[k]}`);
          for (let i = lon.length ? 1 : 0; i < leg.lon.length; i++) { lon.push(leg.lon[i]); lat.push(leg.lat[i]); }
          legEnds.push(lon.length - 1);
          minutes += leg.minutes; km += leg.km;
          for (const r of leg.roads) if (!roads.includes(r)) roads.push(r);
        }
        route = { minutes, km, roads };
      } else {
        for (const [x, y] of pts) { lon.push(x); lat.push(y); }
        for (let k = 1; k < pts.length; k++) legEnds.push(k);
      }
      // km de cada vértice con las mismas cuentas que el perfil
      const cum = [0];
      for (let i = 1; i < lon.length; i++) cum.push(cum[i - 1] + Math.hypot((lon[i] - lon[i - 1]) * geo.KX, (lat[i] - lat[i - 1]) * geo.KZ));
      const total = cum[cum.length - 1];
      if (total < 0.06) throw new Error('los puntos están demasiado cerca');
      // muestras cada 30 m (más espaciadas en trazos de más de 450 km)
      const prof = await data.terrain().profile(lon, lat, Math.max(30, (total * 1000) / 15000));
      const st = profileStats(prof);
      const marks = [{ km: 0, label: 'A' }, ...legEnds.map((e, k) => ({ km: cum[e], label: LETTERS[k + 1] }))];
      // municipios por los que pasa, en orden
      const order: number[] = [], kmBy = new Map<number, number>();
      for (let i = 1; i < prof.km.length; i++) {
        const m = map.municipioAt(prof.lon[i], prof.lat[i]);
        if (!kmBy.has(m)) { kmBy.set(m, 0); order.push(m); }
        kmBy.set(m, kmBy.get(m)! + prof.km[i] - prof.km[i - 1]);
      }
      const munis = order.map(id => ({ id, km: kmBy.get(id)! })).filter(x => x.km >= 0.25);
      return { prof, st, marks, route, munis };
    })().then(
      r => { if (alive) { setRes(r); setBusy(false); setHover(-1); } },
      e => { if (alive) { setRes(null); setErr(e instanceof Error ? e.message : String(e)); setBusy(false); } },
    );
    return () => { alive = false; };
  }, [pts, modo, data, map, geo]);

  // puntos del trazo (se pueden quitar con un clic)
  useEffect(() => {
    if (!pts.length) return;
    const color = new Uint8Array(pts.length * 4);
    for (let k = 0; k < pts.length; k++) color.set(hexToRgba(VERTEX), k * 4);
    const h = map.addPoints({
      shape: 'dot', lon: Float32Array.from(pts, p => p[0]), lat: Float32Array.from(pts, p => p[1]), color, size: 10, pickable: true,
      tooltip: i => ({ title: `Punto ${LETTERS[i]}`, lines: ['Clic para quitarlo'] }),
    });
    verts.current = h;
    return () => { h.dispose(); verts.current = null; };
  }, [map, pts]);

  // el trazo en el mapa, con borde oscuro y coloreado por pendiente
  useEffect(() => {
    if (!res) return;
    const { prof, st } = res, n = prof.km.length;
    const all = { lon: prof.lon, lat: prof.lat, start: Uint32Array.of(0), len: Uint32Array.of(n), onTop: true };
    const casing = map.addLines({ ...all, color: Uint8Array.from(CASING), width: 6 });
    const cls = (i: number) => classOf(Math.max(Math.abs(st.slope[i - 1]) || 0, Math.abs(st.slope[i]) || 0), SLOPE_BREAKS);
    const lon: number[] = [], lat: number[] = [], start: number[] = [], len: number[] = [], color: number[] = [];
    for (let a = 0; a < n - 1;) {
      const c = cls(a + 1);
      let b = a + 1;
      while (b < n - 1 && cls(b + 1) === c) b++;
      start.push(lon.length); len.push(b - a + 1); color.push(...hexToRgba(SLOPE_RAMP[c]));
      for (let i = a; i <= b; i++) { lon.push(prof.lon[i]); lat.push(prof.lat[i]); }
      a = b;
    }
    const top = map.addLines({ lon: Float32Array.from(lon), lat: Float32Array.from(lat), start: Uint32Array.from(start), len: Uint32Array.from(len), color: Uint8Array.from(color), onTop: true, width: 3.5 });
    return () => { top.dispose(); casing.dispose(); };
  }, [map, res]);

  // marcador: donde está el cursor de la gráfica, o el punto más alto
  useEffect(() => {
    if (!res) return;
    const { prof, st } = res;
    if (hover >= 0) map.setPin(`${fmtInt(st.elev[hover])} m · km ${prof.km[hover].toFixed(1)}`, prof.lon[hover], prof.lat[hover]);
    else if (st.iMax >= 0) map.setPin(`Punto más alto · ${fmtInt(st.max)} m`, prof.lon[st.iMax], prof.lat[st.iMax]);
    return () => map.setPin(null);
  }, [map, res, hover]);

  // ficha del cursor sobre el trazo
  useEffect(() => map.onHover(hit => {
    if (!res) return null;
    const { prof, st } = res, near = Math.max(0.15, st.km * 0.01);
    let best = -1, bd = Infinity;
    const stride = Math.max(1, Math.floor(prof.km.length / 4000));
    for (let i = 0; i < prof.km.length; i += stride) {
      const d = Math.hypot((prof.lon[i] - hit.lon) * geo.KX, (prof.lat[i] - hit.lat) * geo.KZ);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0 || bd > near || !Number.isFinite(st.elev[best])) return null;
    const g = st.slope[best];
    return [`Perfil: km ${prof.km[best].toFixed(1)} · ${fmtInt(st.elev[best])} m${Number.isFinite(g) ? ` · ${slopeText(g)}` : ''}`];
  }), [map, res, geo]);

  const pick = (id: string) => {
    const e = EJEMPLOS.find(x => x[0] === id)!, p = e[3];
    setModo(e[2]); setPts(p);
    const lon = p.map(q => q[0]), lat = p.map(q => q[1]);
    const w = Math.max((Math.max(...lon) - Math.min(...lon)) * geo.KX, (Math.max(...lat) - Math.min(...lat)) * geo.KZ);
    map.flyTo((Math.min(...lon) + Math.max(...lon)) / 2, (Math.min(...lat) + Math.max(...lat)) / 2, Math.max(8, w * 1.4));
  };

  const st = res?.st;
  const path = res ? res.marks.map(m => m.label).join(' → ') : '';
  const exportPng = async () => {
    if (!res || !st) return;
    const blob = await profilePng(res.prof, st, res.marks, {
      title: 'Perfil de elevación',
      subtitle: `${path}${res.route ? ' por carretera' : ' en línea recta'} · ${fmtKm(st.km)} km · sube ${fmtInt(st.up)} m · baja ${fmtInt(st.down)} m · pendiente máx. ${st.maxSlope.toFixed(0)} %`,
      credits: CREDITS,
    });
    saveBlob(blob, `perfil-hidalgo-${stamp()}.png`);
  };

  return (
    <>
      <Section title="Trazo" aside={busy ? <span className="rh-mono">calculando…</span> : undefined}>
        <Seg label="Tipo de trazo" value={modo} onChange={m => { setModo(m); setPts(p => p.slice(0, MAX_PTS[m])); }}
          options={[['recta', 'En línea recta'], ['carretera', 'Por carretera']]} />
        <Note>
          {pts.length === 0 && (modo === 'recta' ? 'Haz clic en el mapa para marcar el punto A y luego B; puedes seguir agregando puntos para un corte quebrado.' : 'Haz clic en el origen y en el destino: el perfil sigue la ruta por la red vial. Más clics agregan paradas.')}
          {pts.length === 1 && 'Ahora haz clic en el punto B.'}
          {pts.length >= 2 && `${pts.length} puntos. Clic en el mapa: otro punto (hasta ${MAX_PTS[modo]}); clic sobre un punto: quitarlo.`}
        </Note>
        <Examples onPick={pick} options={EJEMPLOS.map(([id, nombre]) => [id, nombre] as [string, string])} />
        {pts.length > 0 && (
          <div className="rh-a-keys">
            <button type="button" className="rh-a-link" onClick={() => setPts(p => p.slice(0, -1))}>Quitar el último punto</button>
            <button type="button" className="rh-a-link" onClick={() => setPts([])}>Borrar el trazo</button>
          </div>
        )}
        {err && <Note>No se pudo calcular el perfil: {err}.</Note>}
        {busy && !res && modo === 'carretera' && <Loading text="Cargando la red vial y calculando la ruta…" />}
      </Section>

      {res && st && (
        <Section title="Perfil">
          <p className="rh-a-lead">
            <b>{fmtKm(st.km)} km</b> de {path}{res.route ? ' por carretera' : ''}: sube <b>{fmtInt(st.up)} m</b> y baja <b>{fmtInt(st.down)} m</b>.
          </p>
          <ProfileChart prof={res.prof} st={st} marks={res.marks} hover={hover} onHover={setHover} />
          <Stats items={[
            [`${fmtInt(st.max - st.min)} m`, 'Desnivel (más alto − más bajo)'],
            [`${st.meanSlope.toFixed(0)} %`, 'Pendiente media'],
            [`${st.maxSlope.toFixed(0)} %`, 'Pendiente máxima (en 100 m)'],
          ]} />
          <Facts items={[
            ['Punto más alto', `${fmtInt(st.max)} m · km ${res.prof.km[st.iMax].toFixed(1)}`],
            ['Punto más bajo', `${fmtInt(st.min)} m · km ${res.prof.km[st.iMin].toFixed(1)}`],
            ['Altitud en A', `${fmtInt(st.start)} m`],
            [`Altitud en ${res.marks[res.marks.length - 1].label}`, `${fmtInt(st.end)} m`],
            ...(res.route ? [['Tiempo sin tráfico', `≈ ${fmtMin(res.route.minutes)}`], ['Pendiente más fuerte', fmtSlope(st.maxSlope)]] as [string, string][] : []),
          ]} />
          {res.route && res.route.roads.length > 0 && <Note>Por {res.route.roads.join(', ')}.</Note>}
          {st.valid < 0.98 && <p className="rh-a-warn"><b>Parte del trazo sin relieve:</b> el {fmtInt((1 - st.valid) * 100)} % queda fuera de la zona con datos (Hidalgo y unos 3 km alrededor).</p>}
        </Section>
      )}

      {res && st && (
        <Section title="Pendiente a lo largo del trazo" aside={<span className="rh-mono">km</span>}>
          <Bars color={SLOPE_RAMP[2]} rows={SLOPE_LABELS.map((l, c) => ({ id: c, label: l, value: st.classKm[c], text: `${fmtKm(st.classKm[c])} km`, color: SLOPE_RAMP[c] }))} />
          <Note>Los mismos colores marcan el trazo en el mapa y la línea de la gráfica. En carreteras, más de 10 % ya es una cuesta fuerte para vehículos pesados.</Note>
        </Section>
      )}

      {res && res.munis.length > 0 && (
        <Section title="Municipios que atraviesa">
          <p className="rh-a-note">
            {res.munis.slice(0, 10).map((m, k) => (
              <span key={m.id}>{k > 0 && ' → '}<b>{m.id ? meta.names[m.id - 1] : 'otro estado'}</b> {fmtKm(m.km)} km</span>
            ))}
            {res.munis.length > 10 && ` → y ${res.munis.length - 10} más`}
          </p>
        </Section>
      )}

      {res && st && (
        <Section title="Exportar">
          <div className="rh-a-keys">
            <button type="button" className="rh-a-link" onClick={() => saveBlob(new Blob([profileCsv(res.prof, st)], { type: 'text/csv;charset=utf-8' }), `perfil-hidalgo-${stamp()}.csv`)}>
              Tabla CSV ({fmtInt(res.prof.km.length)} puntos)
            </button>
            <button type="button" className="rh-a-link" onClick={exportPng}>Imagen PNG de la gráfica</button>
          </div>
        </Section>
      )}

      <Note>
        Relieve de INEGI a 30 m (90 m donde aún no hay teselas), con una muestra cada 30 m. La pendiente se mide sobre unos
        100 m y la subida acumulada ignora vaivenes de menos de 3 m, para no contar el ruido del relieve. En puentes, túneles
        y cortes el relieve no ve la obra: el perfil baja al fondo de la barranca o sube a la loma. Los tiempos por carretera
        son estimados sin tráfico.
      </Note>
    </>
  );
}
