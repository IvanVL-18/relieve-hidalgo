import '@fontsource/familjen-grotesk/latin-400.css';
import '@fontsource/familjen-grotesk/latin-600.css';
import '@fontsource/familjen-grotesk/latin-ext-400.css';
import '@fontsource/familjen-grotesk/latin-ext-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './relieve.css';

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from 'react';
import type { Datasets } from './analyses/datasets';
import { ANALYSES } from './analyses/registry';
import type { LayerKey, Layers, LoadStage, MunicipioInfo, ReadyInfo, ReliefEngine } from './engine/Engine';
import type { SearchItem } from './engine/search';
import { BASE_MAPS, type BaseMapId } from './shared/basemaps';
import { USV_GROUPS } from './shared/usv';
import { AnalysisMenu, AnalysisPanel } from './ui/Analyses';
import { IconCamera, IconChevron, IconClose, IconCompass, IconExpand, IconGrid, IconMinus, IconMoon, IconPlus, IconShrink, IconSun, IconTarget } from './ui/icons';
import { SearchBox } from './ui/SearchBox';
import { ALT_STOPS_HEX } from './worker/palette';

export interface RelieveApi {
  /** vuela a un municipio por clave INEGI («13048») o id (1–84) y lo selecciona */
  flyToMunicipio(codeOrId: string | number): void;
  select(codeOrId: string | number | null): void;
  goHome(): void;
  setMunicipioColors(colors: Record<string, string> | null, strength?: number): void;
  screenshot(): Promise<Blob>;
}

export interface RelieveHidalgoProps {
  className?: string;
  style?: CSSProperties;
  title?: string;
  /** carpeta pública con elev.bin, muni.bin y vec.bin; por omisión los empaqueta el bundler */
  dataBaseUrl?: string;
  quality?: 'auto' | 'high' | 'low';
  initialExaggeration?: number;
  /** hora local de México, 5–20 */
  initialHour?: number;
  initialLayers?: Partial<Layers>;
  /** mapa base: uso de suelo INEGI (por omisión), satélite o tintas por altitud */
  initialBaseMap?: BaseMapId;
  /** análisis abierto al cargar (id del registro, p. ej. «accesibilidad») */
  initialAnalysis?: string | null;
  onAnalysisChange?: (id: string | null) => void;
  autoRotate?: boolean;
  /** pensado para incrustar en una página con scroll: la rueda solo acerca con Ctrl/⌘ */
  cooperativeGestures?: boolean;
  showSearch?: boolean;
  showLegend?: boolean;
  showPanel?: boolean;
  showMinimap?: boolean;
  /** botón y panel de análisis */
  showAnalyses?: boolean;
  /** colores por municipio (clave INEGI → color CSS), p. ej. de un indicador del laboratorio */
  municipioColors?: Record<string, string> | null;
  onSelectMunicipio?: (m: MunicipioInfo | null) => void;
  onReady?: (info: ReadyInfo) => void;
  /** revisa errores de shaders; útil en desarrollo, en producción retrasa el arranque */
  debug?: boolean;
  /** acceso directo al motor (depuración y pruebas); su API puede cambiar */
  onEngine?: (engine: ReliefEngine) => void;
  ref?: Ref<RelieveApi>;
}

const DEFAULT_LAYERS: Layers = { water: true, places: true, borders: true, contours: false, clouds: true };
const LAYER_LABELS: [LayerKey, string][] = [
  ['water', 'Ríos y presas'], ['places', 'Localidades'], ['borders', 'Municipios'], ['contours', 'Curvas de nivel'], ['clouds', 'Nubes'],
];
const STAGE_TEXT: Record<LoadStage, string> = {
  download: 'Descargando el relieve…', build: 'Levantando el relieve…', gpu: 'Preparando la vista…',
};
const fmtHour = (h: number) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
const fmtN = (n: number) => Math.round(n).toLocaleString('es-MX').replace(/,/g, ' ');
const altRampCss = 'linear-gradient(90deg,' + ALT_STOPS_HEX.filter(s => s[0] <= 3300).map(([e, c]) => `${c} ${((e / 3300) * 100).toFixed(1)}%`).join(',') + ')';

export function RelieveHidalgo(props: RelieveHidalgoProps) {
  const {
    className, style, title = 'Relieve de Hidalgo', showSearch = true, showLegend = true, showPanel = true, showMinimap = true, showAnalyses = true,
  } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLDivElement>(null);
  const tagNameRef = useRef<HTMLElement>(null);
  const tagAltRef = useRef<HTMLSpanElement>(null);
  const tagNearRef = useRef<HTMLSpanElement>(null);
  const tagInfoRef = useRef<HTMLSpanElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const whereRef = useRef<HTMLSpanElement>(null);
  const whereAltRef = useRef<HTMLSpanElement>(null);
  const needleRef = useRef<HTMLSpanElement>(null);
  const zoomRef = useRef<HTMLSpanElement>(null);
  const engineRef = useRef<ReliefEngine | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const [stage, setStage] = useState<LoadStage | 'ready' | 'error'>('download');
  const [error, setError] = useState('');
  const [info, setInfo] = useState<ReadyInfo | null>(null);
  const [layers, setLayers] = useState<Layers>({ ...DEFAULT_LAYERS, ...props.initialLayers });
  const [exag, setExag] = useState(props.initialExaggeration ?? 2.5);
  const [hour, setHour] = useState(props.initialHour ?? 16.5);
  const [baseMap, setBaseMap] = useState<BaseMapId>(props.initialBaseMap ?? 'usodesuelo');
  const [baseLoading, setBaseLoading] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(props.initialAnalysis ?? null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [datasets, setDatasets] = useState<Datasets | null>(null);
  const [small, setSmall] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [selected, setSelected] = useState<MunicipioInfo | null>(null);
  const [hint, setHint] = useState(false);
  const [full, setFull] = useState(false);
  const hintTimer = useRef(0);

  // el motor (y three.js) se carga aparte para no pesar en la página que lo incrusta
  useEffect(() => {
    let cancelled = false, engine: ReliefEngine | null = null;
    const root = rootRef.current!;
    if (root.clientWidth < 640 || root.clientHeight < 760 || props.initialAnalysis) setPanelOpen(false);
    setSmall(root.clientWidth < 640);
    let data: Datasets | null = null;
    import('./engine/Engine').then(({ ReliefEngine }) => {
      if (cancelled) return;
      try {
        engine = new ReliefEngine(
          {
            root, stage: stageRef.current!, labels: labelsRef.current!,
            tag: tagRef.current!, tagName: tagNameRef.current!, tagAlt: tagAltRef.current!, tagNear: tagNearRef.current!, tagInfo: tagInfoRef.current,
            minimap: miniRef.current, where: whereRef.current, whereAlt: whereAltRef.current,
            needle: needleRef.current, zoomRead: zoomRef.current,
          },
          {
            dataBaseUrl: props.dataBaseUrl,
            quality: props.quality,
            exaggeration: exag, hour, layers, baseMap,
            autoRotate: props.autoRotate ?? true,
            cooperativeGestures: props.cooperativeGestures ?? false,
            debug: props.debug,
            onProgress: s => setStage(s),
            onReady: i => {
              setStage('ready'); setInfo(i);
              if (propsRef.current.municipioColors) engine?.setMunicipioColors(propsRef.current.municipioColors);
              // los datos de los análisis se cargan aparte y solo cuando se abre uno
              import('./analyses/datasets').then(({ createDatasets }) => {
                if (cancelled || !engine) return;
                const e = engine;
                data = createDatasets((name, bundled) => e.dataUrl(name, bundled), e.meta);
                setDatasets(data);
              });
              propsRef.current.onReady?.(i);
            },
            onError: msg => { setStage('error'); setError(msg); },
            onSelect: m => { setSelected(m); propsRef.current.onSelectMunicipio?.(m); },
            onGestureHint: () => {
              setHint(true);
              clearTimeout(hintTimer.current);
              hintTimer.current = window.setTimeout(() => setHint(false), 1400);
            },
          },
        );
        engineRef.current = engine;
        props.onEngine?.(engine);
      } catch (e) {
        setStage('error');
        setError(e instanceof Error && /WebGL/i.test(e.message) ? 'Tu navegador o equipo no tiene WebGL activo, que se necesita para ver el relieve en 3D.' : String(e));
      }
    }).catch(() => { if (!cancelled) { setStage('error'); setError('No se pudo cargar el visor. Revisa tu conexión y recarga.'); } });
    return () => { cancelled = true; data?.dispose(); engine?.dispose(); engineRef.current = null; };
    // el motor se crea una sola vez; los cambios posteriores pasan por los efectos de abajo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (stage === 'ready') engineRef.current?.setMunicipioColors(props.municipioColors ?? null); }, [props.municipioColors, stage]);

  useEffect(() => {
    const onFs = () => setFull(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const byCodeOrId = (v: string | number) => (typeof v === 'number' ? v : /^\d{5}$/.test(v) ? Number(v.slice(2)) : Number(v));
  useImperativeHandle(props.ref, () => ({
    flyToMunicipio: v => engineRef.current?.select(byCodeOrId(v), true),
    select: v => engineRef.current?.select(v === null ? 0 : byCodeOrId(v)),
    goHome: () => engineRef.current?.goHome(),
    setMunicipioColors: (c, s) => engineRef.current?.setMunicipioColors(c, s),
    screenshot: () => engineRef.current?.screenshot() ?? Promise.reject(new Error('El relieve aún no está listo')),
  }), []);

  const eng = () => engineRef.current;
  const ready = stage === 'ready';
  const toggleLayer = (k: LayerKey) => { const on = !layers[k]; setLayers({ ...layers, [k]: on }); eng()?.setLayer(k, on); };
  const download = async () => {
    const blob = await eng()?.screenshot();
    if (!blob) return;
    const a = document.createElement('a'), d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `relieve-hidalgo-${d.toISOString().slice(0, 16).replace(/[-:T]/g, '')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else rootRef.current?.requestFullscreen().catch(() => undefined);
  };
  const isNight = info ? hour < info.sunrise - 0.1 || hour > info.sunset + 0.1 : false;
  const chooseBase = (id: BaseMapId) => {
    setBaseMap(id);
    const p = eng()?.setBaseMap(id);
    if (p && id !== 'altitud') { setBaseLoading(true); p.finally(() => setBaseLoading(false)); }
  };
  const openAnalysis = useCallback((id: string | null) => {
    setAnalysis(id);
    setMenuOpen(false);
    if (id) setPanelOpen(false);
    propsRef.current.onAnalysisChange?.(id);
  }, []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const engine = eng();
  const baseCredit = BASE_MAPS.find(b => b.id === baseMap)?.credit;
  const activeDef = analysis ? ANALYSES.find(a => a.id === analysis && a.load) : undefined;

  return (
    <div ref={rootRef} className={'rh-root' + (className ? ' ' + className : '')} style={style} role="region" aria-label={title}>
      <div className="rh-stage" ref={stageRef} />
      <div className="rh-labels" ref={labelsRef} aria-hidden="true" />

      {stage !== 'ready' && (
        <div className={'rh-loading' + (stage === 'error' ? ' rh-error' : '')} role="status">
          {stage === 'error' ? error : <><span className="rh-spinner" aria-hidden="true" />{STAGE_TEXT[stage]}</>}
        </div>
      )}
      <div className={'rh-hint' + (hint ? ' on' : '')} aria-hidden={!hint}>Usa Ctrl + rueda para acercar el mapa</div>

      <div className="rh-hud">
        <div className="rh-tl">
          <div className="rh-mark">
            <div className="rh-title" role="heading" aria-level={2}>{title}</div>
            <div className="rh-mono">
              {info ? <>De <b>{fmtN(info.minElev)} m</b> a <b>{fmtN(info.maxElev)} m</b> sobre el nivel del mar</> : 'Elevación real · 84 municipios'}
            </div>
          </div>
          {showSearch && <SearchBox disabled={!ready} search={q => eng()?.search(q) ?? []} onChoose={(r: SearchItem) => eng()?.flyToItem(r)} />}
          {showAnalyses && (
            <button type="button" className="rh-menu-btn" aria-expanded={menuOpen} aria-haspopup="dialog" disabled={!ready} onClick={() => setMenuOpen(!menuOpen)}>
              <IconGrid />Análisis{activeDef && <span>{activeDef.titulo}</span>}
            </button>
          )}
          {activeDef && engine && datasets && <AnalysisPanel id={activeDef.id} engine={engine} datasets={datasets} small={small} onClose={() => openAnalysis(null)} />}
          {!activeDef && selected && (
            <section className="rh-card" aria-label={`Municipio ${selected.name}`}>
              <header>
                <div>
                  <div className="rh-card-title">{selected.name}</div>
                  <div className="rh-mono">Clave INEGI {selected.code}</div>
                </div>
                <button type="button" className="rh-icon-btn" aria-label="Quitar selección" onClick={() => eng()?.select(0)}><IconClose /></button>
              </header>
              <dl>
                <div><dt>Altitud</dt><dd>{fmtN(selected.minElev)}–{fmtN(selected.maxElev)} m</dd></div>
                <div><dt>Media</dt><dd>{fmtN(selected.meanElev)} m</dd></div>
                <div><dt>Superficie</dt><dd>≈ {fmtN(selected.areaKm2)} km²</dd></div>
                <div><dt>Localidades en el mapa</dt><dd>{selected.places}</dd></div>
              </dl>
              <button type="button" className="rh-text-btn" onClick={() => eng()?.select(selected.id, true)}><IconTarget />Acercar</button>
            </section>
          )}
        </div>

        <div className="rh-tr">
          {showLegend && (
            <div className={'rh-legend' + (baseMap === 'usodesuelo' ? ' rh-legend-wide' : '')} aria-label={baseMap === 'altitud' ? 'Escala de altitud' : baseMap === 'usodesuelo' ? 'Uso del suelo y vegetación' : 'Imagen satelital'}>
              {baseMap === 'altitud' && (
                <>
                  <div className="rh-mono">Altitud · m s. n. m.</div>
                  <div className="rh-bar" style={{ background: altRampCss }} />
                  <div className="rh-ticks rh-mono"><span>0</span><span>1 000</span><span>2 000</span><span>3 000</span></div>
                </>
              )}
              {baseMap === 'usodesuelo' && (
                <>
                  <div className="rh-mono">Uso de suelo · INEGI Serie VII</div>
                  <ul className="rh-key rh-key2">{USV_GROUPS.map(g => <li key={g.id}><i style={{ background: g.color }} />{g.nombre}</li>)}</ul>
                  <div className="rh-mono rh-key-note">Más claro: vegetación secundaria</div>
                </>
              )}
              {baseMap === 'satelite' && <div className="rh-mono">Sentinel-2 · 2016</div>}
            </div>
          )}
          <div className="rh-rail" role="group" aria-label="Navegación">
            <button type="button" title="Acercar (+)" aria-label="Acercar" onClick={() => eng()?.zoomBy(0.6)}><IconPlus /></button>
            <button type="button" title="Alejar (−)" aria-label="Alejar" onClick={() => eng()?.zoomBy(1.6)}><IconMinus /></button>
            <div className="rh-sep" />
            <button type="button" title="Orientar al norte (N)" aria-label="Orientar al norte" onClick={() => eng()?.northUp()}><span className="rh-needle" ref={needleRef}><IconCompass /></span></button>
            <button type="button" title="Vista en planta (T)" aria-label="Vista desde arriba" onClick={() => eng()?.topView()}>2D</button>
            <button type="button" title="Vista inicial (R)" aria-label="Volver a la vista inicial" onClick={() => eng()?.goHome()}>3D</button>
            <div className="rh-sep" />
            <button type="button" title="Descargar imagen" aria-label="Descargar imagen de la vista" disabled={!ready} onClick={download}><IconCamera /></button>
            {typeof document !== 'undefined' && document.fullscreenEnabled && (
              <button type="button" title={full ? 'Salir de pantalla completa' : 'Pantalla completa'} aria-label={full ? 'Salir de pantalla completa' : 'Pantalla completa'} onClick={toggleFull}>{full ? <IconShrink /> : <IconExpand />}</button>
            )}
          </div>
        </div>

        {showPanel && (
          <div className="rh-bl">
            <div className="rh-panel">
              <div className="rh-panel-head">
                <button type="button" aria-expanded={panelOpen} onClick={() => setPanelOpen(!panelOpen)}><IconChevron />Capas y luz</button>
                <span className="rh-mono rh-zoom" ref={zoomRef}>—</span>
              </div>
              {panelOpen && (
                <div className="rh-panel-body">
                  <div className="rh-seg rh-seg3" role="radiogroup" aria-label="Mapa base" aria-busy={baseLoading}>
                    {BASE_MAPS.map(b => (
                      <button key={b.id} type="button" role="radio" aria-checked={baseMap === b.id} onClick={() => chooseBase(b.id)}>{b.label}</button>
                    ))}
                  </div>
                  <div className="rh-toggles" role="group" aria-label="Capas">
                    {LAYER_LABELS.map(([k, t]) => (
                      <button key={k} type="button" aria-pressed={layers[k]} onClick={() => toggleLayer(k)}>{t}</button>
                    ))}
                  </div>
                  <div className="rh-ctl">
                    <div className="rh-head"><label htmlFor="rh-exag">Exageración vertical</label><output htmlFor="rh-exag">{exag.toFixed(1)}×</output></div>
                    <input id="rh-exag" type="range" min={1} max={6} step={0.1} value={exag}
                      onChange={e => { const v = +e.target.value; setExag(v); eng()?.setExaggeration(v); }} />
                  </div>
                  <div className="rh-ctl">
                    <div className="rh-head">
                      <label htmlFor="rh-hour">Hora del sol</label>
                      <output htmlFor="rh-hour">{isNight ? <IconMoon /> : <IconSun />}{fmtHour(hour)}</output>
                    </div>
                    <input id="rh-hour" type="range" min={5} max={20.5} step={0.05} value={hour}
                      style={info ? ({ '--rh-rise': `${((info.sunrise - 5) / 15.5) * 100}%`, '--rh-set': `${((info.sunset - 5) / 15.5) * 100}%` } as CSSProperties) : undefined}
                      className="rh-hour"
                      onChange={e => { const v = +e.target.value; setHour(v); eng()?.setHour(v); }} />
                    {info && <div className="rh-mono rh-sunline">Hoy amanece a las {fmtHour(info.sunrise)} y anochece a las {fmtHour(info.sunset)}</div>}
                  </div>
                  <div className="rh-mono rh-keys">Arrastrar: girar · Clic derecho o Shift: mover · Rueda: acercar donde apuntas · Clic: municipio · Doble clic: ir ahí</div>
                  <div className="rh-mono rh-credits">Elevación: SRTM vía Terrain Tiles (AWS) · Ríos y presas: © OpenStreetMap y red de drenaje calculada del relieve · Límites: INEGI 2022{baseCredit && ` · ${baseCredit}`}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {showMinimap && (
          <div className="rh-br">
            <div className="rh-mini">
              <canvas ref={miniRef} width={380} height={364} aria-label="Mapa de ubicación: toca para ir a un punto" />
              <div className="rh-where rh-mono"><span ref={whereRef}>—</span><span ref={whereAltRef} /></div>
            </div>
          </div>
        )}
      </div>

      <div className="rh-tag" ref={tagRef} aria-hidden="true">
        <strong ref={tagNameRef}>—</strong>
        <span className="rh-alt" ref={tagAltRef}>—</span>
        <span className="rh-near" ref={tagNearRef} />
        <span className="rh-info" ref={tagInfoRef} hidden />
      </div>
      {menuOpen && <AnalysisMenu active={analysis} onPick={openAnalysis} onClose={closeMenu} />}
    </div>
  );
}
