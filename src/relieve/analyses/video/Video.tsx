import { useEffect, useMemo, useRef, useState } from 'react';
import type { CameraPath, View } from '../../engine/mapApi';
import { sunTimes, todayInMexico } from '../../engine/sun';
import { BASE_MAPS } from '../../shared/basemaps';
import { makeGeo } from '../../shared/geo';
import { flight, flyMs, timeline } from '../recorridos/path';
import { holdSeconds, loadTours, pathEnv } from '../recorridos/tours';
import type { AnalysisProps, SceneApi } from '../types';
import { Chips, Facts, Note, Section, Seg, oneOf, saveBlob, useLinked } from '../ui';
import type { Caption } from './compose';
import { pickEncoder, recordStill, recordVideo, type Encoder } from './record';

type Tipo = 'vuelta' | 'acercar' | 'ab' | 'recorrido';
type Formato = 'h' | 'v' | 'c';
const FORMATOS: Record<Formato, [number, number, string]> = {
  h: [1920, 1080, 'Horizontal 16:9'], v: [1080, 1920, 'Vertical 9:16'], c: [1080, 1080, 'Cuadrado'],
};
const FOTOS: [string, number, number][] = [['4k', 3840, 2160], ['8k', 7680, 4320], ['4kv', 2160, 3840]];
/** vista de todo el estado (para el acercamiento) */
const ESTADO: View = { lon: -98.86, lat: 20.47, dist: 3, polar: 48, az: 6 };
const smoother = (s: number) => { const t = Math.min(1, Math.max(0, s)); return t * t * t * (t * (t * 6 - 15) + 10); };
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const fmtMb = (b: number) => `${(b / 1048576).toLocaleString('es-MX', { maximumFractionDigits: 1 })} MB`;
const fmtTime = (s: number) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`);
const num = (lo: number, hi: number) => (s: string) => { const n = Number(s); return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined; };

/** Créditos de lo que se ve (cambian si un recorrido cambia el mapa base o las nubes). */
function credits(scene: SceneApi, extra?: string) {
  const s = scene.get(), base = BASE_MAPS.find(b => b.id === s.baseMap)?.credit;
  return [
    'Relieve: INEGI (Continental relief 2016) y USGS, vía Terrain Tiles', 'Ríos y presas: © OpenStreetMap', 'Límites y localidades: INEGI',
    base, s.layers.clouds ? (s.clouds.kind === 'hoy' ? 'Nubes: GOES-Este (NOAA), vía NASA GIBS' : 'Nubes simuladas') : '', extra,
    `Exageración vertical ${s.exaggeration.toLocaleString('es-MX')}×`,
  ].filter(Boolean).join(' · ');
}

export default function Video({ ctx }: AnalysisProps) {
  const { map, meta, link, scene } = ctx;
  const [tipo, setTipo] = useLinked<Tipo>(link, 'tipo', 'vuelta', oneOf('vuelta', 'acercar', 'ab', 'recorrido'));
  const [formato, setFormato] = useLinked<Formato>(link, 'formato', 'h', oneOf('h', 'v', 'c'));
  const [seg, setSeg] = useLinked(link, 'seg', 12, num(4, 60));
  const [grados, setGrados] = useLinked(link, 'grados', '360', oneOf('90', '180', '360'));
  const [fps, setFps] = useLinked(link, 'cps', '30', oneOf('30', '60'));
  const [labels, setLabels] = useLinked(link, 'nombres', true, s => (s === '1' ? true : s === '0' ? false : undefined), v => (v ? '1' : '0'));
  const sun = useMemo(() => { const g = makeGeo(meta); return sunTimes(todayInMexico(), g.latC, g.lonC); }, [meta]);
  const tours = useMemo(() => loadTours(sun), [sun]);
  const [tourId, setTourId] = useLinked(link, 'tour', tours[0].id, s => (tours.some(t => t.id === s) ? s : undefined));
  const [title, setTitle] = useState('Relieve de Hidalgo');
  const [subtitle, setSubtitle] = useState('');
  const [start, setStart] = useState<View | null>(null);
  const [encoder, setEncoder] = useState<Encoder | null | undefined>(undefined);
  const [busy, setBusy] = useState<{ what: 'video' | 'foto'; done: number; total: number; t0: number } | null>(null);
  const [result, setResult] = useState<{ url: string; name: string; bytes: number; seconds: number; ext: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef(false);
  const [W, H, label] = FORMATOS[formato];
  const rate = Number(fps);
  const tour = tours.find(t => t.id === tourId) ?? tours[0];

  // lo que se graba es lo que se ve: con este análisis abierto las nubes no se ocultan
  useEffect(() => { map.showClouds(true); }, [map]);
  useEffect(() => { let ok = true; pickEncoder(W, H, rate).then(e => ok && setEncoder(e)); return () => { ok = false; }; }, [W, H, rate]);
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url); }, [result]);

  // duración del recorrido (sin el vuelo inicial: empieza en la primera parada)
  const tourMs = useMemo(() => {
    const env = pathEnv(map, meta, 2.5);
    return tour.stops.reduce((s, st, i) => s + holdSeconds(st) * 1000 + (i ? flyMs(env, tour.stops[i - 1].view, st.view) : 0), 0);
  }, [tour, map, meta]);
  const seconds = tipo === 'recorrido' ? tourMs / 1000 : seg;
  const frames = Math.round(seconds * rate);
  const autoSub = () => {
    if (tipo === 'recorrido') return tour.title;
    const v = map.getView(), m = map.municipioAt(v.lon, v.lat);
    return m ? meta.names[m - 1] : '';
  };

  const record = async () => {
    if (!encoder || busy) return;
    setError(null);
    if (result) { URL.revokeObjectURL(result.url); setResult(null); }
    cancel.current = false;
    const v0 = map.getView(), ex = scene.get().exaggeration, env = pathEnv(map, meta, ex), dur = seconds * 1000, sub = subtitle.trim() || autoSub();
    let path: CameraPath | null = null;
    let caption: (i: number) => Caption | null = () => null;
    let begin = () => {};
    if (tipo === 'vuelta') {
      const deg = Number(grados);
      begin = () => { path = map.followPath(ms => (ms > dur ? null : { ...v0, az: v0.az + deg * (deg === 360 ? ms / dur : smoother(ms / dur)) })); };
    } else if (tipo === 'acercar' || tipo === 'ab') {
      const from = tipo === 'ab' && start ? start : { ...ESTADO, az: v0.az }, f = flight(env, from, v0);
      begin = () => { path = map.followPath(ms => (ms > dur ? null : f(ms / dur))); };
    } else {
      // recorrido: la escena de cada parada al empezar su vuelo y el Sol moviéndose hacia la hora de la parada
      const T = tour, tl = timeline(env, T.stops[0].view, T.stops.map(s => ({ view: s.view, hold: holdSeconds(s) }))), skip = tl.legs[1].t0;
      const holds = tl.legs.filter(l => l.kind === 'hold');
      const first = T.stops[0].scene;
      scene.set(first);
      let last = -1, phase = '', h0 = scene.get().hour, lastHour = -1e9;
      begin = () => {
        path = map.followPath(ms => {
          const t = ms + skip;
          if (t > tl.total) return null;
          const st = tl.at(t), s = T.stops[st.stop];
          if (st.stop !== last || st.phase !== phase) {
            if (st.phase === 'fly') { h0 = scene.get().hour; scene.set({ ...s.scene, hour: undefined }); map.setPin(null); }
            else { if (s.scene.hour !== undefined) scene.set({ hour: s.scene.hour }); if (s.mark) map.setPin(s.mark, s.view.lon, s.view.lat); }
            last = st.stop; phase = st.phase;
          } else if (st.phase === 'fly' && s.scene.hour !== undefined && ms - lastHour > 120) {
            lastHour = ms;
            scene.set({ hour: h0 + (s.scene.hour - h0) * smoother(st.p) });
          }
          return st.view;
        });
      };
      caption = i => {
        const t = (i * 1000) / rate + skip, st = tl.at(t);
        if (st.phase !== 'hold') return null;
        const L = holds[st.stop], a = Math.min(1, (t - L.t0) / 700, (L.t1 - t) / 500), s = T.stops[st.stop];
        return { kicker: `${T.title} · ${st.stop + 1} de ${T.stops.length}`, title: s.title, text: s.text, alpha: Math.max(0, a) };
      };
    }
    setBusy({ what: 'video', done: 0, total: frames, t0: performance.now() });
    try {
      let shown = 0;
      const r = await recordVideo({
        map, width: W, height: H, fps: rate, frames, encoder, begin,
        overlay: i => ({ title, subtitle: sub, labels, credits: credits(scene), caption: caption(i) }),
        onProgress: d => { const now = performance.now(); if (now - shown > 250 || d === frames) { shown = now; setBusy(b => b && { ...b, done: d }); } },
        cancelled: () => cancel.current,
      });
      if (r) {
        const name = `relieve-hidalgo-${tipo === 'recorrido' ? tour.id : tipo}-${stamp()}.${r.ext}`;
        saveBlob(r.blob, name);
        setResult({ url: URL.createObjectURL(r.blob), name, bytes: r.blob.size, seconds: r.seconds, ext: r.ext });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      (path as CameraPath | null)?.stop();
      setBusy(null);
    }
  };

  const photo = async (id: string) => {
    const f = FOTOS.find(x => x[0] === id)!;
    setError(null);
    setBusy({ what: 'foto', done: 0, total: 1, t0: performance.now() });
    try {
      const blob = await recordStill(map, f[1], f[2], { title, subtitle: subtitle.trim() || autoSub(), labels, credits: credits(scene) });
      saveBlob(blob, `relieve-hidalgo-${id}-${stamp()}.png`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const eta = busy && busy.done > 2 ? ((performance.now() - busy.t0) / busy.done) * (busy.total - busy.done) / 1000 : null;
  const live = !!busy;

  return (
    <>
      <p className="rh-a-lead">Para redes sociales o presentaciones. Se dibuja <b>cuadro por cuadro</b>: el video sale fluido aunque el equipo sea lento.</p>

      <Section title="Qué grabar">
        <Seg label="Tipo de vuelo" value={tipo} onChange={setTipo} options={[['vuelta', 'Vuelta'], ['acercar', 'Acercamiento'], ['ab', 'De A a B'], ['recorrido', 'Recorrido']]} />
        {tipo === 'vuelta' && (
          <>
            <Note>Gira alrededor del punto que ves ahora, a la misma distancia e inclinación.</Note>
            <Seg label="Giro" value={grados} onChange={setGrados} options={[['90', '90°'], ['180', '180°'], ['360', 'Vuelta completa']]} />
          </>
        )}
        {tipo === 'acercar' && <Note>Del estado completo a lo que ves ahora. Acomoda primero la vista de llegada.</Note>}
        {tipo === 'ab' && (
          <Note>
            {start ? <>Inicio guardado. Ahora mueve el mapa a la vista de llegada. <button type="button" className="rh-a-link" onClick={() => setStart(null)}>Borrar</button></>
              : <>Acomoda la vista de inicio y guárdala; luego mueve el mapa a la de llegada. <button type="button" className="rh-a-link" onClick={() => setStart(map.getView())}>Guardar inicio</button></>}
          </Note>
        )}
        {tipo === 'recorrido' && (
          <>
            <Seg label="Recorrido" value={tourId} onChange={setTourId} options={tours.map(t => [t.id, t.title.replace('Hidalgo de un vistazo', 'Hidalgo').replace('Geoparque Comarca Minera', 'Geoparque').replace('El camino del agua', 'Agua')] as [string, string])} />
            <Note>{tour.stops.length} paradas con su texto en pantalla, {fmtTime(tourMs / 1000)}. Grabarlo toma varios minutos.</Note>
          </>
        )}
        {tipo !== 'recorrido' && (
          <div className="rh-ctl">
            <div className="rh-head"><label htmlFor="rh-v-seg">Duración</label><output htmlFor="rh-v-seg">{seg} s</output></div>
            <input id="rh-v-seg" type="range" min={4} max={60} step={1} value={seg} onChange={e => setSeg(+e.target.value)} />
          </div>
        )}
      </Section>

      <Section title="Formato">
        <Seg label="Formato" value={formato} onChange={setFormato} options={(Object.keys(FORMATOS) as Formato[]).map(k => [k, FORMATOS[k][2]] as [Formato, string])} />
        <Seg label="Cuadros por segundo" value={fps} onChange={setFps} options={[['30', '30 cps'], ['60', '60 cps (más fluido)']]} />
        <input className="rh-a-input" type="text" aria-label="Título" placeholder="Título" value={title} maxLength={60} onChange={e => setTitle(e.target.value)} />
        <input className="rh-a-input" type="text" aria-label="Subtítulo" placeholder={`Subtítulo (${autoSub() || 'opcional'})`} value={subtitle} maxLength={80} onChange={e => setSubtitle(e.target.value)} />
        <Chips label="Opciones" value={labels ? 'n' : ''} options={[['n', 'Nombres de lugares']]} onToggle={() => setLabels(!labels)} />
      </Section>

      <Section>
        <Facts items={[
          ['Video', `${W} × ${H} · ${rate} cps · ${fmtTime(seconds)}`],
          ['Cuadros', frames.toLocaleString('es-MX')],
          ['Codificador', encoder === undefined ? '…' : !encoder ? 'no disponible' : encoder.kind === 'webcodecs' ? 'MP4 (H.264), cuadro por cuadro' : `${encoder.mime.includes('mp4') ? 'MP4' : 'WebM'} en tiempo real`],
        ]} />
        {encoder === null && <p className="rh-a-warn">Este navegador no puede grabar video. Prueba con Chrome, Edge o Safari recientes.</p>}
        {encoder?.kind === 'mediarecorder' && <Note>Este navegador graba en tiempo real: si el equipo es lento, el video puede salir con tirones.</Note>}
        {tipo === 'ab' && !start && <Note>Falta guardar la vista de inicio.</Note>}
        {busy?.what === 'video' ? (
          <div className="rh-a-progress" role="status">
            <div className="rh-a-ptrack"><i style={{ width: `${(100 * busy.done) / busy.total}%` }} /></div>
            <span>Cuadro {busy.done.toLocaleString('es-MX')} de {busy.total.toLocaleString('es-MX')}{eta !== null && ` · faltan ≈ ${fmtTime(eta)}`}</span>
            <button type="button" className="rh-a-link" onClick={() => { cancel.current = true; }}>Cancelar</button>
          </div>
        ) : (
          <button type="button" className="rh-a-btn" disabled={!encoder || live || (tipo === 'ab' && !start)} onClick={record}>Grabar video ({label.split(' ')[0].toLowerCase()})</button>
        )}
        {error && <p className="rh-a-warn">{error}</p>}
        {result && (
          <>
            <video className="rh-a-video" src={result.url} controls muted loop playsInline style={{ aspectRatio: `${W} / ${H}` }} />
            <Note>Listo: <b>{result.name}</b> · {fmtMb(result.bytes)} · {fmtTime(result.seconds)}. <button type="button" className="rh-a-link" onClick={() => fetch(result.url).then(r => r.blob()).then(b => saveBlob(b, result.name))}>Descargar otra vez</button></Note>
          </>
        )}
      </Section>

      <Section title="Imagen grande">
        <Note>La vista actual con nombres y créditos. Espera a que llegue todo el detalle; 8K puede tardar unos segundos.</Note>
        <div className="rh-toggles" role="group" aria-label="Imagen grande">
          {FOTOS.map(([id, w, h]) => (
            <button key={id} type="button" disabled={live} onClick={() => photo(id)}>{id === '4kv' ? 'Vertical 4K' : id.toUpperCase()} · {w} × {h}</button>
          ))}
        </div>
        {busy?.what === 'foto' && <div className="rh-a-loading"><span className="rh-spinner" aria-hidden="true" />Dibujando la imagen…</div>}
      </Section>

      <Note>Mientras se graba, el mapa muestra los cuadros y no responde al ratón. Los créditos de las fuentes van en el video: consérvalos al publicarlo.</Note>
    </>
  );
}
