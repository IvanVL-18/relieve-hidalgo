import { Component, Suspense, lazy, useEffect, useRef, useState, type ComponentType, type ErrorInfo, type LazyExoticComponent, type ReactNode } from 'react';
import type { Datasets } from '../analyses/datasets';
import { ANALYSES, GROUP_ORDER } from '../analyses/registry';
import type { AnalysisContext, AnalysisDef, AnalysisLink, AnalysisProps, SceneApi, SceneChange, ViewerMode } from '../analyses/types';
import { Loading } from '../analyses/ui';
import type { ReliefEngine } from '../engine/Engine';
import { AnalysisIcon, IconChevron, IconClose } from './icons';

const lazyCache = new Map<string, LazyExoticComponent<ComponentType<AnalysisProps>>>();
const componentFor = (def: AnalysisDef) => {
  let c = lazyCache.get(def.id);
  if (!c) { c = lazy(def.load!); lazyCache.set(def.id, c); }
  return c;
};

/** «Agua y riesgo» → «agua»: el color de cada grupo sale de relieve.css ([data-g]). */
export const groupSlug = (g: string) => g.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(' ')[0];

/** Un análisis que falla muestra su error sin tumbar el mapa ni los demás. */
class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  componentDidCatch(e: unknown, info: ErrorInfo) { console.error('Análisis con error', e, info.componentStack); }
  render() { return this.state.error ? <p className="rh-a-note">Este análisis tuvo un problema: {this.state.error}</p> : this.props.children; }
}

/**
 * Catálogo de análisis: tarjetas agrupadas con ícono y resumen; los que aún no existen aparecen como «Próximamente».
 * ids: solo esos análisis (modo escuelas), en ese orden y sin los «Próximamente».
 */
export function AnalysisMenu({ active, onPick, onClose, ids, title = 'Análisis' }: {
  active: string | null; onPick: (id: string) => void; onClose: () => void; ids?: string[]; title?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    // el foco entra al catálogo: al análisis abierto o al primero
    (box.current?.querySelector<HTMLButtonElement>('.rh-cat-card[aria-current="true"]') ?? box.current?.querySelector<HTMLButtonElement>('.rh-cat-card:not(:disabled)'))?.focus({ preventScroll: true });
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  const ready = ANALYSES.filter(a => a.load).length;
  return (
    <div className="rh-cat-wrap">
      <div className="rh-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="rh-catalog" role="dialog" aria-modal="true" aria-labelledby="rh-cat-title" ref={box}>
        <header>
          <div>
            <div className="rh-cat-title" id="rh-cat-title" role="heading" aria-level={2}>{title}</div>
            <p>{ids
              ? 'Temas para clase sobre el mapa 3D de Hidalgo: elige uno y el panel explica lo que ves.'
              : `${ready} análisis sobre el relieve de Hidalgo. Al elegir uno, el mapa cambia y el panel explica qué estás viendo, con cifras, gráficas y fuentes.`}</p>
          </div>
          <button type="button" className="rh-icon-btn rh-cat-close" aria-label="Cerrar" onClick={onClose}><IconClose /></button>
        </header>
        <div className="rh-cat-body">
          {GROUP_ORDER.map(g => {
            const items = ids ? ids.map(id => ANALYSES.find(a => a.id === id && a.load && a.grupo === g)).filter((a): a is AnalysisDef => !!a) : ANALYSES.filter(a => a.grupo === g);
            if (!items.length) return null;
            return (
              <section key={g} data-g={groupSlug(g)} aria-label={g}>
                <div className="rh-cat-group">{g}</div>
                <ul>
                  {items.map(a => (
                    <li key={a.id}>
                      <button type="button" className="rh-cat-card" disabled={!a.load} aria-current={active === a.id} onClick={() => onPick(a.id)}>
                        <span className="rh-a-icon"><AnalysisIcon id={a.id} group={a.grupo} /></span>
                        <span className="rh-cat-text">
                          <b>{a.titulo}{active === a.id && <small>Abierto</small>}{!a.load && <small>Próximamente</small>}</b>
                          <em>{a.resumen}</em>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Panel del análisis activo. Crea su mapa con ámbito y lo limpia al cerrar o cambiar de análisis. initialParams: el
 * estado que traía un enlace (solo para el análisis con el que se abrió); onParams avisa el estado actual.
 * minimized: solo el encabezado (el análisis sigue montado y su capa en el mapa); onBrowse abre el catálogo.
 */
export function AnalysisPanel({ id, engine, datasets, small, onClose, initialParams, onParams, scene, mode = 'normal', minimized = false, onMinimize, onBrowse, browseLabel = 'Análisis' }: {
  id: string; engine: ReliefEngine; datasets: Datasets; small: boolean; onClose?: () => void;
  initialParams?: Record<string, string> | null; onParams?: (params: Record<string, string>) => void;
  scene: SceneApi; mode?: ViewerMode;
  minimized?: boolean; onMinimize?: (min: boolean) => void; onBrowse?: () => void; browseLabel?: string;
}) {
  const def = ANALYSES.find(a => a.id === id)!;
  const [ctx, setCtx] = useState<AnalysisContext | null>(null);
  // el estado sobrevive si el análisis se vuelve a montar (p. ej. al cambiar a pantalla chica)
  const params = useRef<{ id: string; values: Record<string, string>; initial: Record<string, string>; reported: boolean } | null>(null);
  const notify = useRef(onParams);
  notify.current = onParams;
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // al volver a montar (también el doble efecto de StrictMode), lo último que avisó el análisis; si aún no avisó nada, lo del enlace
    if (params.current?.id !== id) params.current = { id, values: {}, initial: { ...(initialParams ?? {}) }, reported: false };
    else if (params.current.reported) params.current.initial = { ...params.current.values };
    const st = params.current;
    const link: AnalysisLink = {
      initial: st.initial,
      set: (k, v) => {
        st.reported = true;
        if (v === null ? !(k in st.values) : st.values[k] === v) return;
        if (v === null) delete st.values[k]; else st.values[k] = v;
        notify.current?.({ ...st.values });
      },
    };
    notify.current?.({ ...st.values });
    const map = engine.createScope();
    // lo que el análisis cambie del panel «Capas y luz» se anota la primera vez para volverlo al cerrar
    const saved: SceneChange = {};
    const sc: SceneApi = {
      get: () => scene.get(),
      set: ch => {
        const cur = scene.get();
        if (ch.baseMap !== undefined && saved.baseMap === undefined) saved.baseMap = cur.baseMap;
        if (ch.hour !== undefined && saved.hour === undefined) saved.hour = cur.hour;
        if (ch.exaggeration !== undefined && saved.exaggeration === undefined) saved.exaggeration = cur.exaggeration;
        for (const k of Object.keys(ch.layers ?? {}) as (keyof typeof cur.layers)[]) if (!(k in (saved.layers ??= {}))) saved.layers[k] = cur.layers[k];
        for (const k of Object.keys(ch.clouds ?? {}) as (keyof typeof cur.clouds)[]) if (!(k in (saved.clouds ??= {}))) (saved.clouds as Record<string, unknown>)[k] = cur.clouds[k];
        scene.set(ch);
      },
    };
    setCtx({ map, data: datasets, meta: map.meta, small, link, scene: sc, mode });
    return () => { map.dispose(); engine.select(0); setCtx(null); if (Object.keys(saved).length) scene.set(saved); };
    // initialParams solo cuenta al abrir el análisis
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, datasets, id, small]);
  // otro análisis empieza arriba
  useEffect(() => { body.current?.scrollTo({ top: 0 }); }, [id]);
  const Comp = componentFor(def);
  return (
    <section className={'rh-apanel' + (minimized ? ' rh-min' : '')} aria-label={def.titulo} data-g={groupSlug(def.grupo)}>
      <header className="rh-apanel-head">
        <span className="rh-a-icon"><AnalysisIcon id={def.id} group={def.grupo} /></span>
        <div className="rh-apanel-titles">
          <div className="rh-crumb">
            {onBrowse && <><button type="button" className="rh-crumb-btn" onClick={onBrowse} title="Ver todos los análisis">{browseLabel}</button><span aria-hidden="true">›</span></>}
            <span>{def.grupo}</span>
          </div>
          <div className="rh-apanel-title" role="heading" aria-level={3}>{def.titulo}</div>
        </div>
        <div className="rh-apanel-actions">
          {onMinimize && (
            <button type="button" className="rh-icon-btn rh-min-btn" aria-expanded={!minimized} title={minimized ? 'Mostrar el panel' : 'Contraer el panel'}
              aria-label={minimized ? 'Mostrar el panel' : 'Contraer el panel'} onClick={() => onMinimize(!minimized)}><IconChevron /></button>
          )}
          {onClose && <button type="button" className="rh-icon-btn" title="Cerrar el análisis" aria-label="Cerrar el análisis" onClick={onClose}><IconClose /></button>}
        </div>
      </header>
      <div className="rh-apanel-body" ref={body} hidden={minimized}>
        <p className="rh-apanel-sum">{def.resumen}</p>
        <Boundary key={id}>
          <Suspense fallback={<Loading text="Cargando análisis…" />}>{ctx && <Comp ctx={ctx} />}</Suspense>
        </Boundary>
        {def.fuentes && (
          <div className="rh-a-sources">
            <b>Fuentes</b>
            <ul>{def.fuentes.map(f => <li key={f}>{f}</li>)}</ul>
          </div>
        )}
      </div>
    </section>
  );
}
