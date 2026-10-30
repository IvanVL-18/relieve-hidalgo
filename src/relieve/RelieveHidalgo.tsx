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
import { CLOUD_DEFAULTS, CLOUD_KINDS, skyFor, windName, type CloudKind, type CloudSettings } from './shared/clouds';
import { archiveRange, dayIso, dayStartOf, mxHour, type LiveCloudsStatus } from './shared/goes';
import { viewStateUrl, type ViewState } from './shared/enlaces';
import type { SearchItem } from './engine/search';
import { BASE_MAPS, type BaseMapId } from './shared/basemaps';
import { USV_GROUPS } from './shared/usv';
import { AnalysisMenu, AnalysisPanel } from './ui/Analyses';
import {
  IconArrow, IconCamera, IconChevron, IconClose, IconCompass, IconExpand, IconGrid, IconLink, IconMinus, IconMoon, IconPause, IconPlay, IconPlus, IconShrink, IconSun, IconTarget,
} from './ui/icons';
import { SearchBox } from './ui/SearchBox';
import { ALT_STOPS_HEX } from './worker/palette';

export interface RelieveApi {
  /** vuela a un municipio por clave INEGI («13048») o id (1–84) y lo selecciona */
  flyToMunicipio(codeOrId: string | number): void;
  select(codeOrId: string | number | null): void;
  goHome(): void;
  setMunicipioColors(colors: Record<string, string> | null, strength?: number): void;
  screenshot(): Promise<Blob>;
  /** estado para un enlace a esta vista (null mientras carga) */
  getViewState(): ViewState | null;
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
  /** cielo inicial: tipo de nubes (auto = según la hora), cantidad 0–1, viento (grados desde el norte) y lapso de tiempo */
  initialClouds?: Partial<CloudSettings>;
  /**
   * nubes del satélite («Del satélite» en el panel, kind: 'hoy'): servidor de las imágenes de GOES. Por omisión NASA GIBS,
   * que el navegador de cada visitante consulta solo al elegir esa opción; puede ser un proxy del anfitrión con las mismas
   * rutas (/wms/epsg4326/best/wms.cgi y /wmts/epsg4326/best/1.0.0/…). null quita la opción
   */
  liveCloudsUrl?: string | null;
  /** mapa base: uso de suelo INEGI (por omisión), satélite o tintas por altitud */
  initialBaseMap?: BaseMapId;
  /** análisis abierto al cargar (id del registro, p. ej. «accesibilidad») */
  initialAnalysis?: string | null;
  onAnalysisChange?: (id: string | null) => void;
  /**
   * vista inicial de un enlace (decodeViewState(location.search)): cámara, mapa base, hora, exageración, nubes,
   * municipio y análisis con sus parámetros; lo que traiga manda sobre las demás props initial*
   */
  initialView?: ViewState;
  /** avisa el estado al detenerse la cámara o cambiar algo (para que el anfitrión actualice la URL con history.replaceState) */
  onViewChange?: (state: ViewState) => void;
  /** dirección del botón «Copiar enlace»; por omisión, la página actual con el estado en la consulta (viewStateUrl) */
  shareUrl?: (state: ViewState) => string;
  /** botón «Copiar enlace» */
  showShare?: boolean;
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
/** «11 sep» (fecha en México) */
const fmtDay = (ms: number) => new Date(ms - 6 * 3600e3).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' });
/** «vie 11 sep 2026» (o sin el día de la semana) de «2026-09-11» */
const fmtDate = (day: string, weekday = true) => {
  const d = new Date(day + 'T12:00:00Z'), f = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('es-MX', { ...o, timeZone: 'UTC' }).replace(/\./g, '');
  return (weekday ? f({ weekday: 'short' }) + ' ' : '') + f({ day: 'numeric', month: 'short', year: 'numeric' });
};
/** «12 min» o «1 h 5 min» desde un instante */
const fmtAgo = (ms: number) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60e3)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const fmtN = (n: number) => Math.round(n).toLocaleString('es-MX').replace(/,/g, ' ');
/** Corre fn cuando el navegador está libre (o a los 1.5 s donde no hay requestIdleCallback, como Safari). */
const whenIdle = (fn: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500));
const altRampCss = 'linear-gradient(90deg,' + ALT_STOPS_HEX.filter(s => s[0] <= 3300).map(([e, c]) => `${c} ${((e / 3300) * 100).toFixed(1)}%`).join(',') + ')';

export function RelieveHidalgo(props: RelieveHidalgoProps) {
  const {
    className, style, title = 'Relieve de Hidalgo', showSearch = true, showLegend = true, showPanel = true, showMinimap = true, showAnalyses = true, showShare = true,
  } = props;
  const iv = props.initialView ?? {};
  const firstAnalysis = iv.analysis ?? props.initialAnalysis ?? null;
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
  const [layers, setLayers] = useState<Layers>(() => ({ ...DEFAULT_LAYERS, ...props.initialLayers, ...(iv.clouds ? { clouds: iv.clouds !== 'no' } : {}) }));
  const [clouds, setClouds] = useState<CloudSettings>(() => ({
    ...CLOUD_DEFAULTS, ...props.initialClouds, ...(iv.clouds && iv.clouds !== 'no' ? { kind: iv.clouds } : {}), ...(iv.cloudDay ? { day: iv.cloudDay } : {}),
  }));
  const [exag, setExag] = useState(iv.exaggeration ?? props.initialExaggeration ?? 2.5);
  const [hour, setHour] = useState(Math.min(20.5, Math.max(5, iv.hour ?? props.initialHour ?? 16.5)));
  const [baseMap, setBaseMap] = useState<BaseMapId>(iv.baseMap ?? props.initialBaseMap ?? 'usodesuelo');
  const [baseLoading, setBaseLoading] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(firstAnalysis);
  const [params, setParams] = useState<Record<string, string>>({});
  // los parámetros del enlace solo valen para el análisis con el que se abrió
  const linkParams = useRef(iv.params ?? null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [datasets, setDatasets] = useState<Datasets | null>(null);
  const [placesVersion, setPlacesVersion] = useState(0);
  const [small, setSmall] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [selected, setSelected] = useState<MunicipioInfo | null>(null);
  const [hint, setHint] = useState('');
  const [full, setFull] = useState(false);
  const hintTimer = useRef(0);

  // el motor (y three.js) se carga aparte para no pesar en la página que lo incrusta
  useEffect(() => {
    let cancelled = false, engine: ReliefEngine | null = null;
    const root = rootRef.current!;
    if (root.clientWidth < 640 || root.clientHeight < 760 || firstAnalysis) setPanelOpen(false);
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
            exaggeration: exag, hour, layers, baseMap, clouds,
            liveCloudsUrl: props.liveCloudsUrl,
            onLiveClouds: s => setLive(s),
            onHourChange: h => setHour(h),
            // un enlace con vista abre quieto en ella
            autoRotate: (props.autoRotate ?? true) && !iv.view,
            cooperativeGestures: props.cooperativeGestures ?? false,
            debug: props.debug,
            onProgress: s => setStage(s),
            onReady: i => {
              setStage('ready'); setInfo(i);
              if (propsRef.current.municipioColors) engine?.setMunicipioColors(propsRef.current.municipioColors);
              if (iv.view) engine?.setView(iv.view, 0);
              if (iv.municipio && !firstAnalysis) engine?.select(Number(iv.municipio.slice(2)), !iv.view);
              // los datos de los análisis se cargan aparte y solo cuando se abre uno
              import('./analyses/datasets').then(({ createDatasets }) => {
                if (cancelled || !engine) return;
                const e = engine;
                data = createDatasets((name, bundled) => e.dataUrl(name, bundled), e.meta, () => e.terrain);
                setDatasets(data);
                // el buscador suma, con el navegador libre, las 4 690 localidades del ITER y las colonias del DENUE
                const d = data;
                whenIdle(() => {
                  Promise.all([d.localidades(), d.lugares().catch(err => { console.warn('Buscador: sin colonias ni localidades del catálogo.', err); return null; })])
                    .then(([loc, lug]) => { if (!cancelled) { e.addPlaces(loc, lug); setPlacesVersion(v => v + 1); } })
                    .catch(err => console.warn('Buscador: no se pudieron cargar las localidades.', err));
                });
              });
              propsRef.current.onReady?.(i);
            },
            onError: msg => { setStage('error'); setError(msg); },
            onSelect: m => { setSelected(m); propsRef.current.onSelectMunicipio?.(m); },
            onGestureHint: () => flash('Usa Ctrl + rueda para acercar el mapa', 1400),
            onViewChange: () => emitView(),
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
    getViewState: () => viewState(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  const eng = () => engineRef.current;
  const ready = stage === 'ready';

  // enlaces a vistas: el estado se arma al momento con lo último de cada cosa
  const linkRef = useRef({ baseMap, hour, exag, layers, clouds, selected, analysis, params, ready });
  linkRef.current = { baseMap, hour, exag, layers, clouds, selected, analysis, params, ready };
  const viewState = (): ViewState | null => {
    const e = engineRef.current, L = linkRef.current;
    if (!e || !L.ready) return null;
    return {
      view: e.getView(), baseMap: L.baseMap, hour: L.hour, exaggeration: L.exag, clouds: L.layers.clouds ? L.clouds.kind : 'no',
      cloudDay: L.layers.clouds && L.clouds.kind === 'hoy' ? L.clouds.day : undefined,
      // con un análisis abierto, el municipio lo guarda el análisis (en sus parámetros)
      municipio: L.analysis ? undefined : L.selected?.code, analysis: L.analysis ?? undefined, params: L.analysis ? L.params : undefined,
    };
  };
  const emitTimer = useRef(0);
  function emitView() {
    clearTimeout(emitTimer.current);
    emitTimer.current = window.setTimeout(() => { const s = viewState(); if (s) propsRef.current.onViewChange?.(s); }, 250);
  }
  useEffect(() => { if (ready) emitView(); }, [ready, baseMap, hour, exag, layers.clouds, clouds.kind, clouds.day, selected, analysis, params]);
  useEffect(() => () => clearTimeout(emitTimer.current), []);
  function flash(text: string, ms: number) {
    setHint(text);
    clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(''), ms);
  }
  const share = async () => {
    const s = viewState();
    if (!s) return;
    const url = propsRef.current.shareUrl?.(s) ?? viewStateUrl(location.href, s);
    // en celular, el menú de compartir del sistema
    if (typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title, url }); return; } catch (e) { if (e instanceof Error && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); flash('Enlace copiado: abre esta misma vista', 1800); } catch { window.prompt('Copia el enlace a esta vista:', url); }
  };
  const toggleLayer = (k: LayerKey) => { const on = !layers[k]; setLayers({ ...layers, [k]: on }); eng()?.setLayer(k, on); };
  const updateClouds = (s: Partial<CloudSettings>) => { setClouds(c => ({ ...c, ...s })); eng()?.setClouds(s); };
  // nubes de hoy: el último tipo simulado elegido (para volver a él) y el estado de la imagen
  const [live, setLive] = useState<LiveCloudsStatus | null>(null);
  const lastSim = useRef<Exclude<CloudKind, 'hoy'>>(clouds.kind === 'hoy' ? 'auto' : clouds.kind);
  if (clouds.kind !== 'hoy') lastSim.current = clouds.kind;
  const liveAllowed = props.liveCloudsUrl !== null;
  const isLive = clouds.kind === 'hoy' && liveAllowed;
  const setSource = (today: boolean) => {
    if (today === isLive) return;
    if (today) setLive(null);
    updateClouds({ kind: today ? 'hoy' : lastSim.current, play: false });
  };
  const retryLive = () => { setLive(null); eng()?.setClouds({ kind: lastSim.current }); eng()?.setClouds({ kind: 'hoy' }); };
  // otro día del archivo de GIBS (los últimos 90, contando hoy); sin día, las de hoy
  const [dayMin, dayMax] = archiveRange(Date.now());
  const pastDay = clouds.day && clouds.day < dayMax ? clouds.day : undefined;
  const chooseDay = (d?: string) => {
    const v = d && dayStartOf(d) !== null && d < dayMax ? (d < dayMin ? dayMin : d) : undefined;
    if (v === pastDay) return;
    setLive(null);
    updateClouds({ day: v });
  };
  const stepDay = (n: number) => chooseDay(dayIso((dayStartOf(pastDay ?? dayMax) ?? 0) + n * 864e5));
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  // amanecer y anochecer de hoy o, con las nubes del satélite de otro día, los de ese día (el Sol es el de ese día)
  const sun = pastDay && isLive && live?.sunrise !== undefined && live.sunset !== undefined ? { sunrise: live.sunrise, sunset: live.sunset } : info;
  const isNight = sun ? hour < sun.sunrise - 0.1 || hour > sun.sunset + 0.1 : false;
  const chooseBase = (id: BaseMapId) => {
    setBaseMap(id);
    const p = eng()?.setBaseMap(id);
    if (p && id !== 'altitud') { setBaseLoading(true); p.finally(() => setBaseLoading(false)); }
  };
  const openAnalysis = useCallback((id: string | null) => {
    linkParams.current = null;
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
      <div className={'rh-hint' + (hint ? ' on' : '')} role="status" aria-live="polite">{hint}</div>

      <div className="rh-hud">
        <div className="rh-tl">
          <div className="rh-mark">
            <div className="rh-title" role="heading" aria-level={2}>{title}</div>
            <div className="rh-mono">
              {info ? <>De <b>{fmtN(info.minElev)} m</b> a <b>{fmtN(info.maxElev)} m</b> sobre el nivel del mar</> : 'Elevación real · 84 municipios'}
            </div>
          </div>
          {showSearch && <SearchBox disabled={!ready} version={placesVersion} search={q => eng()?.search(q) ?? []} onChoose={(r: SearchItem) => eng()?.flyToItem(r)} />}
          {showAnalyses && (
            <button type="button" className="rh-menu-btn" aria-expanded={menuOpen} aria-haspopup="dialog" disabled={!ready} onClick={() => setMenuOpen(!menuOpen)}>
              <IconGrid />Análisis{activeDef && <span>{activeDef.titulo}</span>}
            </button>
          )}
          {activeDef && engine && datasets && <AnalysisPanel id={activeDef.id} engine={engine} datasets={datasets} small={small} onClose={() => openAnalysis(null)} initialParams={linkParams.current} onParams={setParams} />}
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
                <div><dt>Población 2020</dt><dd>{fmtN(selected.poblacion)}</dd></div>
                <div><dt>Superficie</dt><dd>{selected.areaKm2.toLocaleString('es-MX', { maximumFractionDigits: 1 }).replace(/,/g, ' ')} km²</dd></div>
                <div><dt>Altitud</dt><dd>{fmtN(selected.minElev)}–{fmtN(selected.maxElev)} m</dd></div>
                <div><dt>Media</dt><dd>{fmtN(selected.meanElev)} m</dd></div>
                <div><dt>Localidades</dt><dd>{fmtN(selected.localidades)}</dd></div>
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
            {showShare && <button type="button" title="Copiar enlace a esta vista" aria-label="Copiar enlace a esta vista" disabled={!ready} onClick={share}><IconLink /></button>}
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
                  {layers.clouds && (
                    <div className="rh-sky" role="group" aria-label="Nubes">
                      {liveAllowed && (
                        <div className="rh-seg rh-seg2" role="radiogroup" aria-label="Origen de las nubes">
                          <button type="button" role="radio" aria-checked={!isLive} title="Nubes ilustrativas: eliges el tipo de cielo, la cantidad y el viento" onClick={() => setSource(false)}>Simuladas</button>
                          <button type="button" role="radio" aria-checked={isLive} title="Las nubes que vio el satélite GOES-Este de la NOAA (imágenes de NASA): hoy, con ~40 min de retraso, o un día de los últimos 90" onClick={() => setSource(true)}>Del satélite</button>
                        </div>
                      )}
                      {isLive ? (
                        <>
                          <div className="rh-live-day" role="group" aria-label="Día de las imágenes del satélite">
                            <button type="button" className="rh-day-step rh-day-prev" aria-label="Día anterior" title="Día anterior" disabled={(pastDay ?? dayMax) <= dayMin} onClick={() => stepDay(-1)}><IconChevron /></button>
                            <input type="date" required aria-label="Día" title={`Cualquier día del ${fmtDate(dayMin, false)} a hoy`} min={dayMin} max={dayMax} value={pastDay ?? dayMax} onChange={e => chooseDay(e.target.value)} />
                            <button type="button" className="rh-day-step rh-day-next" aria-label="Día siguiente" title="Día siguiente" disabled={!pastDay} onClick={() => stepDay(1)}><IconChevron /></button>
                            <button type="button" className="rh-day-today" hidden={!pastDay} title="Volver a las nubes de hoy" onClick={() => chooseDay()}>Hoy</button>
                          </div>
                          <div className="rh-live" aria-live="polite">
                            <span className={'rh-live-dot rh-live-' + (live?.state ?? 'loading')} aria-hidden="true" />
                            <div className="rh-live-text">
                              {!live || (live.state === 'loading' && !live.loaded) ? <b>Descargando la imagen del satélite…</b>
                                : live.state === 'error' ? <><b>No se pudo descargar la imagen</b><span className="rh-mono">{live.message ?? 'Revisa tu conexión'} · <button type="button" className="rh-link" onClick={retryLive}>Reintentar</button></span></>
                                : <>
                                  <b>{live.shown !== undefined ? `Imagen de las ${fmtHour(mxHour(live.shown))}` : 'Imagen del satélite'}</b>
                                  <span className="rh-mono">
                                    {pastDay ? fmtDate(pastDay)
                                      : live.latest !== undefined && (Date.now() - live.latest < 864e5 ? `Última: ${fmtHour(mxHour(live.latest))}, hace ${fmtAgo(live.latest)}` : `${fmtDay(live.latest)}, última de las ${fmtHour(mxHour(live.latest))}`)}
                                    {live.total > 1 && live.loaded < live.total && ` · ${live.loaded}/${live.total} imágenes`}
                                    {live.windKmh !== undefined && live.windDeg !== undefined && live.windKmh >= 3 && <> · <span className="rh-wind-arrow" style={{ transform: `rotate(${live.windDeg + 180}deg)` }}><IconArrow /></span>{windName(live.windDeg)}, {Math.round(live.windKmh)} km/h</>}
                                  </span>
                                </>}
                            </div>
                            <button type="button" className="rh-sky-play" aria-pressed={clouds.play} disabled={reduceMotion || live?.state !== 'ready'}
                              aria-label={clouds.play ? 'Detener' : 'Repetir el día'}
                              title={reduceMotion ? 'Sin animación: el sistema pide reducir el movimiento' : clouds.play ? 'Detener' : 'Repetir el día: las imágenes del satélite desde las 5:00, con el Sol de cada hora'}
                              onClick={() => updateClouds({ play: !clouds.play })}>
                              {clouds.play ? <IconPause /> : <IconPlay />}
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="rh-seg rh-seg5" role="radiogroup" aria-label="Tipo de cielo">
                            {CLOUD_KINDS.map(k => (
                              <button key={k.id} type="button" role="radio" aria-checked={clouds.kind === k.id} title={k.hint} onClick={() => updateClouds({ kind: k.id })}>{k.label}</button>
                            ))}
                          </div>
                          <div className="rh-sky-row">
                            <div className="rh-ctl">
                              <div className="rh-head"><label htmlFor="rh-cloud-amt">Cantidad</label><output htmlFor="rh-cloud-amt">{Math.round(clouds.amount * 100)} %</output></div>
                              <input id="rh-cloud-amt" type="range" min={0} max={1} step={0.01} value={clouds.amount} onChange={e => updateClouds({ amount: +e.target.value })} />
                            </div>
                            <div className="rh-ctl">
                              <div className="rh-head">
                                <label htmlFor="rh-wind">Viento</label>
                                <output htmlFor="rh-wind"><span className="rh-wind-arrow" style={{ transform: `rotate(${clouds.wind + 180}deg)` }}><IconArrow /></span>{windName(clouds.wind)}</output>
                              </div>
                              <input id="rh-wind" type="range" min={0} max={360} step={5} value={clouds.wind} aria-valuetext={'Viento ' + windName(clouds.wind)} onChange={e => updateClouds({ wind: +e.target.value })} />
                            </div>
                            <button type="button" className="rh-sky-play" aria-pressed={clouds.play} disabled={reduceMotion}
                              aria-label={clouds.play ? 'Detener las nubes' : 'Animar las nubes'}
                              title={reduceMotion ? 'Sin animación: el sistema pide reducir el movimiento' : clouds.play ? 'Detener las nubes' : 'Lapso de tiempo: las nubes avanzan con el viento, crecen y se deshacen'}
                              onClick={() => updateClouds({ play: !clouds.play })}>
                              {clouds.play ? <IconPause /> : <IconPlay />}
                            </button>
                          </div>
                        </>
                      )}
                      <div className="rh-mono rh-sky-note">{activeDef ? 'Ocultas mientras hay un análisis abierto' : isLive ? 'La hora del sol elige la imagen' : skyFor(clouds.kind, hour).text}</div>
                    </div>
                  )}
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
                      style={sun ? ({ '--rh-rise': `${((sun.sunrise - 5) / 15.5) * 100}%`, '--rh-set': `${((sun.sunset - 5) / 15.5) * 100}%` } as CSSProperties) : undefined}
                      className="rh-hour"
                      onChange={e => { const v = +e.target.value; setHour(v); eng()?.setHour(v); }} />
                    {isLive && layers.clouds && live?.firstHour !== undefined && live.lastHour !== undefined && (
                      <div className="rh-live-track" title="Horas del día con imagen del satélite" aria-hidden="true">
                        <i style={{ left: `${((Math.max(5, live.firstHour) - 5) / 15.5) * 100}%`, width: `${((Math.min(20.5, live.lastHour) - Math.max(5, live.firstHour)) / 15.5) * 100}%` }} />
                      </div>
                    )}
                    {sun && <div className="rh-mono rh-sunline">{pastDay && sun !== info
                      ? `El ${fmtDate(pastDay, false)} amaneció a las ${fmtHour(sun.sunrise)} y anocheció a las ${fmtHour(sun.sunset)}`
                      : `Hoy amanece a las ${fmtHour(sun.sunrise)} y anochece a las ${fmtHour(sun.sunset)}`}</div>}
                  </div>
                  <div className="rh-mono rh-keys">Arrastrar: girar · Clic derecho o Shift: mover · Rueda: acercar donde apuntas · Clic: municipio · Doble clic: ir ahí</div>
                  <div className="rh-mono rh-credits">Elevación: INEGI (Continental relief 2016) y USGS (SRTM, GMTED2010), vía Terrain Tiles (AWS) · Ríos y presas: © OpenStreetMap y red de drenaje calculada del relieve · Límites: INEGI 2022 · Localidades y colonias: INEGI (Censo 2020, catálogo de localidades y DENUE){layers.clouds && (isLive ? ` · Nubes ${pastDay ? 'del ' + fmtDate(pastDay, false) : 'de hoy'}: satélite GOES-Este (NOAA), vía NASA GIBS (ESDIS); alturas estimadas por la temperatura de la cima` : ' · Nubes: simuladas, según la lluvia media anual de INEGI')}{baseCredit && ` · ${baseCredit}`}</div>
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
