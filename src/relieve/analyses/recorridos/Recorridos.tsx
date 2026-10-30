import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CameraPath } from '../../engine/mapApi';
import { sunTimes, todayInMexico } from '../../engine/sun';
import { makeGeo } from '../../shared/geo';
import { IconChevron, IconPause, IconPlay } from '../../ui/icons';
import type { AnalysisProps, SceneApi } from '../types';
import { Note, Section, Seg, useLinked } from '../ui';
import { flyMs, timeline } from './path';
import { holdSeconds, loadTours, pathEnv, type Stop } from './tours';

/** el kiosco sigue solo si nadie toca la pantalla en este tiempo */
const KIOSK_IDLE_MS = 45000;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);
const fmtDur = (ms: number) => { const m = Math.round(ms / 60000); return m < 1 ? 'menos de 1 min' : `≈ ${m} min`; };

/** Voz del navegador en español (local en Windows y macOS; en algunos navegadores es un servicio en línea). */
function speak(text: string) {
  if (typeof speechSynthesis === 'undefined') return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text), voices = speechSynthesis.getVoices();
  u.lang = 'es-MX';
  const v = voices.find(x => x.lang === 'es-MX') ?? voices.find(x => x.lang.startsWith('es'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
const hush = () => { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); };

interface Playing { tour: number; stop: number; phase: 'fly' | 'hold'; t0: number; total: number; startStop: number }

export default function Recorridos({ ctx }: AnalysisProps) {
  const { map, meta, link, scene, mode } = ctx;
  const kiosk = mode === 'kiosco';
  const sun = useMemo(() => { const g = makeGeo(meta); return sunTimes(todayInMexico(), g.latC, g.lonC); }, [meta]);
  const tours = useMemo(() => loadTours(sun), [sun]);
  const [tourId, setTourId] = useLinked(link, 'tour', tours[0].id, s => (tours.some(t => t.id === s) ? s : undefined));
  const ti = Math.max(0, tours.findIndex(t => t.id === tourId)), tour = tours[ti];
  const [stop, setStop] = useLinked(link, 'parada', 0, s => { const n = Number(s) - 1; return Number.isInteger(n) && n >= 0 && n < 40 ? n : undefined; }, v => String(v + 1));
  const [play, setPlay] = useState<Playing | null>(null);
  const [voice, setVoice] = useState(false);
  const [loop, setLoop] = useState(kiosk);
  const [paused, setPaused] = useState<'user' | null>(null);
  const [ended, setEnded] = useState(false);
  const reduce = useMemo(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const path = useRef<CameraPath | null>(null);
  const opts = useRef({ voice, loop, kiosk, tours, scene });
  opts.current = { voice, loop, kiosk, tours, scene };

  // las nubes son parte de la escena de los recorridos
  useEffect(() => { map.showClouds(true); }, [map]);

  /** Aplica la escena de una parada (la hora se mueve aparte, durante el vuelo). */
  const applyStop = useCallback((sc: SceneApi, s: Stop, withHour: boolean) => {
    const { hour, ...rest } = s.scene;
    sc.set(withHour && hour !== undefined ? { ...rest, hour } : rest);
  }, []);

  /** Arranca el recorrido t en la parada i, desde donde esté la cámara. */
  const start = useCallback((t: number, i: number) => {
    const T = opts.current.tours[t], sc = opts.current.scene;
    path.current?.stop();
    hush();
    setPaused(null);
    setEnded(false);
    const ex = T.stops.slice(0, i + 1).reduceRight<number | undefined>((v, s) => v ?? s.scene.exaggeration, undefined) ?? sc.get().exaggeration;
    if (ex !== sc.get().exaggeration) sc.set({ exaggeration: ex });
    const env = pathEnv(map, meta, ex), stops = T.stops.slice(i);
    const tl = timeline(env, map.getView(), stops.map(s => ({ view: s.view, hold: holdSeconds(s, opts.current.voice) })), { cuts: reduce });
    let last = -1, phase = '', h0 = sc.get().hour, lastHourMs = -1e9;
    setPlay({ tour: t, stop: i, phase: 'fly', t0: performance.now(), total: tl.total, startStop: i });
    const p = map.followPath(ms => {
      if (ms > tl.total) return null;
      const st = tl.at(ms), k = i + st.stop, s = T.stops[k];
      if (st.stop !== last || st.phase !== phase) {
        if (st.phase === 'fly') {
          h0 = sc.get().hour;
          applyStop(sc, s, reduce);
          map.setPin(null);
        } else {
          if (s.scene.hour !== undefined) sc.set({ hour: s.scene.hour });
          if (s.mark) map.setPin(s.mark, s.view.lon, s.view.lat);
          if (opts.current.voice) speak(`${s.title}. ${s.text}`);
          const next = T.stops[k + 1];
          if (next) void map.prefetch(next.view);
        }
        last = st.stop; phase = st.phase;
        setStop(k);
        setPlay(pl => pl && { ...pl, stop: k, phase: st.phase });
      } else if (st.phase === 'fly' && s.scene.hour !== undefined && !reduce && ms - lastHourMs > 120) {
        // el Sol se mueve durante el vuelo hacia la hora de la parada
        lastHourMs = ms;
        sc.set({ hour: lerp(h0, s.scene.hour, smooth(st.p)) });
      }
      return st.view;
    });
    path.current = p;
    void map.prefetch(stops[0].view);
    p.done.then(why => {
      if (path.current !== p) return;
      path.current = null;
      if (why === 'end') {
        const o = opts.current;
        if (o.loop || o.kiosk) {
          // en el kiosco se pasa al siguiente recorrido; si no, se repite
          const nt = o.kiosk ? (t + 1) % o.tours.length : t;
          setTourId(o.tours[nt].id);
          start(nt, 0);
          return;
        }
        setPlay(null);
        setEnded(true);
      } else {
        hush();
        setPlay(null);
        if (why === 'user') setPaused('user');
      }
    });
  }, [map, meta, reduce, applyStop, setStop, setTourId]);

  const stopPlaying = useCallback(() => { path.current?.stop(); path.current = null; hush(); setPlay(null); }, []);
  useEffect(() => () => { path.current?.stop(); hush(); }, []);

  // sin reproducir: ir a una parada (vuelo normal) y mostrarla
  const goTo = (i: number) => {
    if (play) { start(ti, i); return; }
    const s = tour.stops[i];
    setStop(i);
    applyStop(scene, s, true);
    map.setPin(s.mark ?? null, s.view.lon, s.view.lat);
    void map.setView(s.view, reduce ? 0 : Math.min(6000, flyMs(pathEnv(map, meta, scene.get().exaggeration), map.getView(), s.view)));
  };

  // kiosco: arranca solo y, si alguien toma el mapa, sigue tras un rato sin tocarlo
  const idle = useRef(0);
  useEffect(() => {
    if (!kiosk) return;
    const t = setTimeout(() => start(ti, 0), 1200);
    return () => clearTimeout(t);
    // solo al abrir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kiosk]);
  useEffect(() => {
    if (!kiosk || play) return;
    const arm = () => { clearTimeout(idle.current); idle.current = window.setTimeout(() => start(ti, Math.min(stop + 1, tour.stops.length - 1)), KIOSK_IDLE_MS); };
    arm();
    const evs = ['pointerdown', 'wheel', 'keydown'] as const;
    for (const e of evs) addEventListener(e, arm, { passive: true });
    return () => { clearTimeout(idle.current); for (const e of evs) removeEventListener(e, arm); };
  }, [kiosk, play, start, ti, stop, tour]);

  // progreso de la barra (solo mientras se reproduce)
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!play) return;
    let raf = 0;
    const tick = () => { setNow(performance.now()); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [play]);

  const env0 = useMemo(() => pathEnv(map, meta, 2.5), [map, meta]);
  const totalMs = useMemo(() => tour.stops.reduce((s, st, i) => s + holdSeconds(st, voice) * 1000 + (i ? flyMs(env0, tour.stops[i - 1].view, st.view) : 4000), 0), [tour, voice, env0]);
  const cur = tour.stops[Math.min(stop, tour.stops.length - 1)];
  const progress = play ? Math.min(1, (now - play.t0) / play.total) : 0;
  const flying = play?.phase === 'fly';
  const pick = (id: string) => { if (id === tourId) return; stopPlaying(); setTourId(id); setStop(0); setPaused(null); };

  return (
    <>
      {!kiosk && (
        <>
          <p className="rh-a-lead">Vuelos narrados por el estado. Puedes mover el mapa en cualquier momento: el recorrido se detiene y sigue con <b>▶</b>.</p>
          <Section title="Recorrido">
            <Seg label="Recorrido" value={tourId} onChange={pick} options={tours.map(t => [t.id, t.title.replace('Hidalgo de un vistazo', 'Hidalgo').replace('Geoparque Comarca Minera', 'Geoparque').replace('El camino del agua', 'Agua')] as [string, string])} />
            <Note>{tour.summary} {fmtDur(totalMs)}.</Note>
          </Section>
        </>
      )}

      <div className="rh-tour" aria-live="polite">
        <div className="rh-tour-bar">
          <button type="button" className="rh-icon-btn rh-tour-prev" aria-label="Parada anterior" disabled={stop === 0} onClick={() => goTo(stop - 1)}><IconChevron /></button>
          <button type="button" className="rh-tour-play" aria-label={play ? 'Pausa' : 'Reproducir'} onClick={() => (play ? stopPlaying() : start(ti, ended ? 0 : stop))}>
            {play ? <IconPause /> : <IconPlay />}
          </button>
          <button type="button" className="rh-icon-btn rh-tour-next" aria-label="Parada siguiente" disabled={stop >= tour.stops.length - 1} onClick={() => goTo(stop + 1)}><IconChevron /></button>
          <div className="rh-tour-track" role="progressbar" aria-label="Avance del recorrido" aria-valuemin={1} aria-valuemax={tour.stops.length} aria-valuenow={stop + 1}>
            {tour.stops.map((s, i) => (
              <button key={i} type="button" title={s.title} aria-label={`Parada ${i + 1}: ${s.title}`} aria-current={i === stop}
                className={i < stop ? 'done' : i === stop ? 'on' : ''} onClick={() => goTo(i)} />
            ))}
            {play && <i style={{ width: `${(100 * progress).toFixed(1)}%` }} />}
          </div>
        </div>
        <div className="rh-tour-card">
          <div className="rh-mono">{kiosk && <>{tour.title} · </>}{flying ? 'Rumbo a' : 'Parada'} {stop + 1} de {tour.stops.length}</div>
          <h4>{cur.title}</h4>
          <p className={flying ? 'rh-tour-dim' : ''}>{cur.text}</p>
        </div>
        {paused === 'user' && <Note>{kiosk ? 'El recorrido sigue solo en un momento.' : 'Pausado: tomaste el mapa. ▶ sigue desde esta parada.'}</Note>}
      </div>

      {!kiosk && (
        <>
          <Section title="Opciones">
            <div className="rh-toggles" role="group" aria-label="Opciones del recorrido">
              <button type="button" aria-pressed={voice} disabled={typeof speechSynthesis === 'undefined'} onClick={() => { setVoice(!voice); if (voice) hush(); }}>Leer en voz alta</button>
              <button type="button" aria-pressed={loop} onClick={() => setLoop(!loop)}>Repetir</button>
            </div>
            {reduce && <Note>Tu sistema pide reducir el movimiento: el recorrido salta de parada en parada sin volar.</Note>}
          </Section>
          <Section title="Paradas">
            <ol className="rh-tour-list">
              {tour.stops.map((s, i) => (
                <li key={i}><button type="button" aria-current={i === stop} onClick={() => goTo(i)}><span>{i + 1}</span>{s.title}</button></li>
              ))}
            </ol>
          </Section>
          <Note>Para el módulo de una feria abre el visor con <b>?kiosco</b>: los recorridos se repiten solos y, si alguien toma el mapa, siguen tras {KIOSK_IDLE_MS / 1000} s sin tocarlo.</Note>
        </>
      )}
    </>
  );
}
