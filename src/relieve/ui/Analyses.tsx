import { Component, Suspense, lazy, useEffect, useRef, useState, type ComponentType, type ErrorInfo, type LazyExoticComponent, type ReactNode } from 'react';
import type { Datasets } from '../analyses/datasets';
import { ANALYSES, GROUP_ORDER } from '../analyses/registry';
import type { AnalysisContext, AnalysisDef, AnalysisLink, AnalysisProps, SceneApi, SceneChange, ViewerMode } from '../analyses/types';
import { Loading } from '../analyses/ui';
import type { ReliefEngine } from '../engine/Engine';
import { IconClose } from './icons';

const lazyCache = new Map<string, LazyExoticComponent<ComponentType<AnalysisProps>>>();
const componentFor = (def: AnalysisDef) => {
  let c = lazyCache.get(def.id);
  if (!c) { c = lazy(def.load!); lazyCache.set(def.id, c); }
  return c;
};

/** Un análisis que falla muestra su error sin tumbar el mapa ni los demás. */
class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  componentDidCatch(e: unknown, info: ErrorInfo) { console.error('Análisis con error', e, info.componentStack); }
  render() { return this.state.error ? <p className="rh-a-note">Este análisis tuvo un problema: {this.state.error}</p> : this.props.children; }
}

/** Menú con todos los análisis, agrupados; los que aún no existen aparecen como «Próximamente». */
/** ids: solo esos análisis (modo escuelas), en ese orden y sin los «Próximamente» */
export function AnalysisMenu({ active, onPick, onClose, ids }: { active: string | null; onPick: (id: string) => void; onClose: () => void; ids?: string[] }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="rh-drawer" role="dialog" aria-label="Análisis disponibles">
      <header>
        <div className="rh-card-title">Análisis</div>
        <button type="button" className="rh-icon-btn" aria-label="Cerrar menú" onClick={onClose}><IconClose /></button>
      </header>
      <div className="rh-drawer-body">
        {GROUP_ORDER.map(g => {
          const items = ids ? ids.map(id => ANALYSES.find(a => a.id === id && a.load && a.grupo === g)).filter((a): a is AnalysisDef => !!a) : ANALYSES.filter(a => a.grupo === g);
          if (!items.length) return null;
          return (
            <section key={g}>
              <div className="rh-mono">{g}</div>
              <ul>
                {items.map(a => (
                  <li key={a.id}>
                    <button type="button" disabled={!a.load} aria-current={active === a.id} onClick={() => onPick(a.id)}>
                      <span>{a.titulo}{!a.load && <small>Próximamente</small>}</span>
                      <em>{a.resumen}</em>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Panel del análisis activo. Crea su mapa con ámbito y lo limpia al cerrar o cambiar de análisis. initialParams: el
 * estado que traía un enlace (solo para el análisis con el que se abrió); onParams avisa el estado actual.
 */
export function AnalysisPanel({ id, engine, datasets, small, onClose, initialParams, onParams, scene, mode = 'normal' }: {
  id: string; engine: ReliefEngine; datasets: Datasets; small: boolean; onClose?: () => void;
  initialParams?: Record<string, string> | null; onParams?: (params: Record<string, string>) => void;
  scene: SceneApi; mode?: ViewerMode;
}) {
  const def = ANALYSES.find(a => a.id === id)!;
  const [ctx, setCtx] = useState<AnalysisContext | null>(null);
  // el estado sobrevive si el análisis se vuelve a montar (p. ej. al cambiar a pantalla chica)
  const params = useRef<{ id: string; values: Record<string, string>; initial: Record<string, string>; reported: boolean } | null>(null);
  const notify = useRef(onParams);
  notify.current = onParams;
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
  const Comp = componentFor(def);
  return (
    <section className="rh-apanel" aria-label={def.titulo}>
      <header>
        <div>
          <div className="rh-mono">{def.grupo}</div>
          <div className="rh-card-title">{def.titulo}</div>
        </div>
        {onClose && <button type="button" className="rh-icon-btn" aria-label="Cerrar análisis" onClick={onClose}><IconClose /></button>}
      </header>
      <div className="rh-apanel-body">
        <Boundary key={id}>
          <Suspense fallback={<Loading text="Cargando análisis…" />}>{ctx && <Comp ctx={ctx} />}</Suspense>
        </Boundary>
        {def.fuentes && <p className="rh-mono rh-credits">Fuentes: {def.fuentes.join(' · ')}</p>}
      </div>
    </section>
  );
}
