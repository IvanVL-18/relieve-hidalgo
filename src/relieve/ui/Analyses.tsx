import { Component, Suspense, lazy, useEffect, useState, type ComponentType, type ErrorInfo, type LazyExoticComponent, type ReactNode } from 'react';
import type { Datasets } from '../analyses/datasets';
import { ANALYSES, GROUP_ORDER } from '../analyses/registry';
import type { AnalysisContext, AnalysisDef, AnalysisProps } from '../analyses/types';
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
export function AnalysisMenu({ active, onPick, onClose }: { active: string | null; onPick: (id: string) => void; onClose: () => void }) {
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
          const items = ANALYSES.filter(a => a.grupo === g);
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

/** Panel del análisis activo. Crea su mapa con ámbito y lo limpia al cerrar o cambiar de análisis. */
export function AnalysisPanel({ id, engine, datasets, small, onClose }: { id: string; engine: ReliefEngine; datasets: Datasets; small: boolean; onClose: () => void }) {
  const def = ANALYSES.find(a => a.id === id)!;
  const [ctx, setCtx] = useState<AnalysisContext | null>(null);
  useEffect(() => {
    const map = engine.createScope();
    setCtx({ map, data: datasets, meta: map.meta, small });
    return () => { map.dispose(); engine.select(0); setCtx(null); };
  }, [engine, datasets, id, small]);
  const Comp = componentFor(def);
  return (
    <section className="rh-apanel" aria-label={def.titulo}>
      <header>
        <div>
          <div className="rh-mono">{def.grupo}</div>
          <div className="rh-card-title">{def.titulo}</div>
        </div>
        <button type="button" className="rh-icon-btn" aria-label="Cerrar análisis" onClick={onClose}><IconClose /></button>
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
