import '@fontsource/familjen-grotesk/latin-400.css';
import '@fontsource/familjen-grotesk/latin-600.css';
import '@fontsource/familjen-grotesk/latin-ext-400.css';
import '@fontsource/familjen-grotesk/latin-ext-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './relieve.css';

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type Ref } from 'react';
import type { Datasets } from './analyses/datasets';
import { ANALYSES, SCHOOL_ANALYSES } from './analyses/registry';
import type { SceneApi, SceneChange, ViewerMode } from './analyses/types';
import type { LayerKey, Layers, LoadStage, MunicipioInfo, QualityInfo, ReadyInfo, ReliefEngine } from './engine/Engine';
import { CLOUD_DEFAULTS, CLOUD_KINDS, skyFor, windName, type CloudKind, type CloudSettings } from './shared/clouds';
import { archiveRange, dayIso, dayStartOf, mxHour, type LiveCloudsStatus } from './shared/goes';
import { viewStateUrl, type ViewState } from './shared/enlaces';
import { QUALITY_LEVELS, isQualitySetting, tierRank, type QualitySetting } from './shared/quality';
import type { SearchItem } from './engine/search';
import { BASE_MAPS, type BaseMapId } from './shared/basemaps';
import { USV_GROUPS } from './shared/usv';
import { AnalysisMenu, AnalysisPanel } from './ui/Analyses';
import {
  AnalysisIcon, IconArrow, IconCamera, IconChevron, IconClose, IconCompass, IconExpand, IconGrid, IconHand, IconHome, IconLayers, IconLink, IconMap, IconMinus, IconMoon,
  IconPause, IconPlay, IconPlus, IconShrink, IconSun, IconTarget,
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
  /**
   * calidad de imagen al abrir: auto (según la tarjeta gráfica), low (Básica), medium (Normal), high (Alta) o ultra
   * (Máxima). Sin ella, la última que eligió quien mira en «Capas y luz» (se guarda en su navegador) o auto
   */
  quality?: QualitySetting;
  /** quien mira cambió la calidad en «Capas y luz» */
  onQualityChange?: (q: QualitySetting) => void;
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
  /**
   * 'kiosco': módulo táctil para ferias (abre el recorrido guiado en bucle, sin buscador, menú ni paneles) ·
   * 'escuelas': interfaz simplificada con los temas para clase (regiones, relieve, ríos, climas y preguntas)
   */
  mode?: ViewerMode;
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

const DEFAULT_LAYERS: Layers = { water: true, places: true, borders: true, contours: false, clouds: true, buildings: true };
const LAYER_LABELS: [LayerKey, string][] = [
  ['water', 'Ríos y presas'], ['places', 'Localidades'], ['borders', 'Municipios'], ['contours', 'Curvas de nivel'], ['clouds', 'Nubes'], ['buildings', 'Edificios'],
];
const STAGE_TEXT: Record<LoadStage, string> = {
  download: 'Descargando el relieve…', build: 'Levantando el relieve…', gpu: 'Preparando la vista…',
};
/** «Cómo moverse en el mapa» con ratón y en pantallas táctiles */
const HOWTO_MOUSE: [string, string][] = [
  ['Arrastrar', 'girar el mapa'], ['Clic derecho o Shift + arrastrar', 'mover'], ['Rueda', 'acercar hacia donde apuntas'],
  ['Clic', 'elegir un municipio'], ['Doble clic', 'volar a ese punto'], ['Flechas, + y −', 'moverse y acercar con el teclado'], ['/', 'buscar un lugar'],
];
const HOWTO_TOUCH: [string, string][] = [
  ['Un dedo', 'girar el mapa'], ['Dos dedos', 'acercar, alejar y mover'], ['Tocar', 'elegir un municipio'], ['Doble toque', 'volar a ese punto'],
];
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
/** Calidad que eligió quien mira (guardada en su navegador; puede no haber almacenamiento). */
const QUALITY_KEY = 'rh-calidad';
const storedQuality = (): QualitySetting | null => { try { const v = localStorage.getItem(QUALITY_KEY); return isQualitySetting(v) ? v : null; } catch { return null; } };
const storeQuality = (q: QualitySetting) => { try { localStorage.setItem(QUALITY_KEY, q); } catch { /* sin almacenamiento */ } };
/** Corre fn cuando el navegador está libre (o a los 1.5 s donde no hay requestIdleCallback, como Safari). */
const whenIdle = (fn: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500));
const altRampCss = 'linear-gradient(90deg,' + ALT_STOPS_HEX.filter(s => s[0] <= 3300).map(([e, c]) => `${c} ${((e / 3300) * 100).toFixed(1)}%`).join(',') + ')';

export function RelieveHidalgo(props: RelieveHidalgoProps) {
  const mode = props.mode ?? 'normal', kiosk = mode === 'kiosco';
  const {
    className, style, title = 'Relieve de Hidalgo', showLegend = true, showPanel = true, showMinimap = true, showAnalyses = true, showShare = true,
  } = props;
  // en el kiosco solo queda el recorrido (y el botón de pantalla completa)
  const showSearch = (props.showSearch ?? true) && !kiosk;
  const iv = props.initialView ?? {};
  const firstAnalysis = iv.analysis ?? props.initialAnalysis ?? (kiosk ? 'recorridos' : mode === 'escuelas' ? 'escuelas' : null);
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
  // minimapa contraído hasta que se pida; leyenda abierta salvo en pantallas bajas
  const [miniOpen, setMiniOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);
  // con un análisis abierto la leyenda del mapa base empieza contraída: los colores que importan son los del análisis
  const [legendAOpen, setLegendAOpen] = useState(false);
  // panel del análisis contraído (solo su encabezado) y vista desde arriba (2D) o inclinada (3D)
  const [aMin, setAMin] = useState(false);
  const [is2D, setIs2D] = useState(false);
  // cómo moverse: se muestra al llegar hasta que la persona toca el mapa
  const [tips, setTips] = useState(true);
  // calidad de imagen: la elegida (prop, la guardada o auto) y lo que dice el motor (nivel en uso, tarjeta gráfica)
  const [quality, setQuality] = useState<QualitySetting>(() => props.quality ?? storedQuality() ?? 'auto');
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const [qInfo, setQInfo] = useState<QualityInfo | null>(null);
  // el visor se vuelve a crear (de o hacia Básica) con la vista y el análisis de ese momento
  const [engineGen, setEngineGen] = useState(0);
  const restoreRef = useRef<ViewState | null>(null);

  // el motor (y three.js) se carga aparte para no pesar en la página que lo incrusta
  useEffect(() => {
    let cancelled = false, engine: ReliefEngine | null = null;
    const root = rootRef.current!;
    // al volver a crearlo: la vista y el municipio de ese momento en vez de los del enlace inicial
    const rs = restoreRef.current;
    restoreRef.current = null;
    const start = rs ?? iv, openAnalysis = rs ? !!rs.analysis : !!firstAnalysis;
    if (rs) { setStage('download'); setInfo(null); setDatasets(null); }
    else {
      if (root.clientWidth < 640 || root.clientHeight < 760 || firstAnalysis) setPanelOpen(false);
      if (root.clientWidth < 640 || root.clientHeight < 600) setLegendOpen(false);
      setSmall(root.clientWidth < 640);
    }
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
            quality: qualityRef.current,
            exaggeration: exag, hour, layers, baseMap, clouds,
            liveCloudsUrl: props.liveCloudsUrl,
            onLiveClouds: s => setLive(s),
            onHourChange: h => setHour(h),
            // un enlace con vista abre quieto en ella
            autoRotate: (props.autoRotate ?? true) && !start.view && !kiosk,
            cooperativeGestures: props.cooperativeGestures ?? false,
            debug: props.debug,
            onProgress: s => setStage(s),
            onReady: i => {
              setStage('ready'); setInfo(i);
              if (engine) setQInfo(engine.quality);
              if (propsRef.current.municipioColors) engine?.setMunicipioColors(propsRef.current.municipioColors);
              if (start.view) engine?.setView(start.view, 0);
              if (start.municipio && !openAnalysis) engine?.select(Number(start.municipio.slice(2)), !start.view);
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
    // el motor se crea una vez (y otra si la calidad pasa de o hacia Básica); los demás cambios pasan por los efectos de abajo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineGen]);

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
  // la escena para los análisis (ctx.scene): lee lo último y cambia por applyScene (definida más abajo)
  const applyScene = useRef<(ch: SceneChange) => void>(() => undefined);
  const sceneApi = useRef<SceneApi>({
    get: () => { const L = linkRef.current; return { baseMap: L.baseMap, hour: L.hour, exaggeration: L.exag, layers: { ...L.layers }, clouds: { ...L.clouds } }; },
    set: ch => applyScene.current(ch),
  }).current;
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
    emitTimer.current = window.setTimeout(() => {
      const s = viewState();
      if (!s) return;
      // con la cámara casi vertical, el botón «2D» queda marcado
      if (s.view) setIs2D(s.view.polar < 12);
      propsRef.current.onViewChange?.(s);
    }, 250);
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
  // calidad de imagen: casi todo cambia al momento; de o hacia Básica el visor se vuelve a crear en la misma vista
  const chooseQuality = (q: QualitySetting) => {
    if (q === quality) return;
    setQuality(q);
    qualityRef.current = q;
    storeQuality(q);
    propsRef.current.onQualityChange?.(q);
    const e = eng();
    if (!e) return;
    if (e.setQuality(q)) { setQInfo(e.quality); return; }
    restoreRef.current = viewState();
    linkParams.current = analysis ? params : null;
    setEngineGen(g => g + 1);
  };
  const openAnalysis = useCallback((id: string | null) => {
    linkParams.current = null;
    setAnalysis(id);
    setMenuOpen(false);
    setAMin(false);
    if (id) setPanelOpen(false);
    propsRef.current.onAnalysisChange?.(id);
  }, []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  // ajustes de la escena que piden los análisis (recorridos, video…): pasan por los mismos estados que el panel
  applyScene.current = ch => {
    const L = linkRef.current, e = eng();
    if (ch.baseMap !== undefined && ch.baseMap !== L.baseMap) { chooseBase(ch.baseMap); L.baseMap = ch.baseMap; }
    if (ch.hour !== undefined) { const h = Math.min(20.5, Math.max(5, ch.hour)); setHour(h); e?.setHour(h); L.hour = h; }
    if (ch.exaggeration !== undefined) { const x = Math.min(6, Math.max(1, ch.exaggeration)); setExag(x); e?.setExaggeration(x); L.exag = x; }
    if (ch.layers) {
      const next = { ...L.layers, ...ch.layers };
      for (const k of Object.keys(ch.layers) as LayerKey[]) if (next[k] !== L.layers[k]) e?.setLayer(k, next[k]);
      setLayers(next);
      L.layers = next;
    }
    if (ch.clouds) { updateClouds(ch.clouds); L.clouds = { ...L.clouds, ...ch.clouds }; }
  };
  const engine = eng();
  const baseCredit = BASE_MAPS.find(b => b.id === baseMap)?.credit;
  const activeDef = analysis ? ANALYSES.find(a => a.id === analysis && a.load) : undefined;
  const school = mode === 'escuelas';
  const menuLabel = school ? 'Temas' : 'Análisis';
  const view2D = () => { setIs2D(true); eng()?.topView(); };
  // 3D: la misma vista, inclinada como la inicial (≈ 55°)
  const view3D = () => {
    const e = eng(), v = e?.getView();
    if (!e || !v) return;
    setIs2D(false);
    e.setView({ ...v, polar: 55 }, 900);
  };
  // en el celular las hojas de abajo se turnan: capas y luz o el análisis
  const tabAnalysis = () => {
    if (!activeDef) { setMenuOpen(true); return; }
    if (panelOpen) { setPanelOpen(false); setAMin(false); } else setAMin(!aMin);
  };
  const touchUi = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  useEffect(() => {
    if (!ready || !tips) return;
    const t = setTimeout(() => setTips(false), 16000);
    return () => clearTimeout(t);
  }, [ready, tips]);
  const hideTips = () => { if (tips) setTips(false); };
  // «/» lleva al buscador (como en muchos sitios), si no se está escribiendo en otro campo
  const onRootKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
    const input = rootRef.current?.querySelector<HTMLInputElement>('.rh-search input');
    if (input && !input.disabled) { e.preventDefault(); input.focus(); }
  };
  const baseInfo = BASE_LEGEND[baseMap];
  const legendBody = activeDef ? legendAOpen : legendOpen;
  const toggleLegend = () => (activeDef ? setLegendAOpen(!legendAOpen) : setLegendOpen(!legendOpen));
  const canFull = typeof document !== 'undefined' && document.fullscreenEnabled;

  return (
    <div ref={rootRef} className={'rh-root' + (mode !== 'normal' ? ' rh-' + mode : '') + (className ? ' ' + className : '')} style={style} role="region" aria-label={title} onKeyDown={onRootKey}>
      <div className="rh-stage" ref={stageRef} onPointerDown={hideTips} onWheel={hideTips} />
      <div className="rh-labels" ref={labelsRef} aria-hidden="true" />

      {stage !== 'ready' && (
        <div className={'rh-loading' + (stage === 'error' ? ' rh-error' : '')} role="status">
          {stage === 'error' ? error : <><span className="rh-spinner" aria-hidden="true" />{STAGE_TEXT[stage]}</>}
        </div>
      )}
      <div className={'rh-hint' + (hint ? ' on' : '')} role="status" aria-live="polite">{hint}</div>

      <div className={'rh-hud' + (activeDef ? ' rh-has-analysis' : '') + (activeDef && aMin ? ' rh-a-min' : '') + (panelOpen ? ' rh-layers-open' : '') + (selected && !activeDef ? ' rh-has-card' : '')}>
        <header className="rh-top">
          <div className="rh-mark">
            <div className="rh-title" role="heading" aria-level={2}>{title}</div>
            <div className="rh-sub">
              {info ? <>De <b>{fmtN(info.minElev)} m</b> a <b>{fmtN(info.maxElev)} m</b> sobre el nivel del mar</> : 'Elevación real · 84 municipios'}
            </div>
          </div>
          {showSearch && <SearchBox disabled={!ready} version={placesVersion} search={q => eng()?.search(q) ?? []} onChoose={(r: SearchItem) => eng()?.flyToItem(r)} />}
          <div className="rh-tools" role="group" aria-label="Guardar y compartir">
            {!kiosk && (
              <button type="button" className="rh-tool" title="Descargar una imagen PNG de esta vista" aria-label="Descargar imagen de la vista" disabled={!ready} onClick={download}>
                <IconCamera /><span>Imagen</span>
              </button>
            )}
            {!kiosk && showShare && (
              <button type="button" className="rh-tool" title="Copiar un enlace que abre esta misma vista" aria-label="Copiar enlace a esta vista" disabled={!ready} onClick={share}>
                <IconLink /><span>Compartir</span>
              </button>
            )}
            {canFull && (
              <button type="button" className="rh-tool rh-tool-icon" title={full ? 'Salir de pantalla completa' : 'Pantalla completa'} aria-label={full ? 'Salir de pantalla completa' : 'Pantalla completa'} onClick={toggleFull}>
                {full ? <IconShrink /> : <IconExpand />}
              </button>
            )}
          </div>
        </header>

        <div className="rh-side">
          {showAnalyses && !kiosk && !activeDef && (
            <button type="button" className="rh-launch" aria-haspopup="dialog" aria-expanded={menuOpen} disabled={!ready} onClick={() => setMenuOpen(true)}>
              <span className="rh-launch-icon"><IconGrid /></span>
              <span className="rh-launch-text">
                <b>{school ? 'Temas para clase' : 'Análisis'}</b>
                <em>{school ? 'Regiones, relieve, clima, agua y preguntas' : 'Población, servicios, agua y riesgo, planeación y difusión'}</em>
              </span>
              <IconChevron />
            </button>
          )}
          {activeDef && engine && datasets && (
            <AnalysisPanel id={activeDef.id} engine={engine} datasets={datasets} small={small} onClose={kiosk ? undefined : () => openAnalysis(null)}
              initialParams={linkParams.current} onParams={setParams} scene={sceneApi} mode={mode}
              minimized={aMin} onMinimize={kiosk ? undefined : v => { setAMin(v); if (!v && small) setPanelOpen(false); }}
              onBrowse={kiosk || !showAnalyses ? undefined : () => setMenuOpen(true)} browseLabel={menuLabel} />
          )}
          {!activeDef && selected && (
            <section className="rh-card" aria-label={`Municipio ${selected.name}`}>
              <header>
                <div>
                  <div className="rh-eyebrow">Municipio · clave INEGI {selected.code}</div>
                  <div className="rh-card-title">{selected.name}</div>
                </div>
                <button type="button" className="rh-icon-btn" title="Quitar selección" aria-label="Quitar selección" onClick={() => eng()?.select(0)}><IconClose /></button>
              </header>
              <dl>
                <div><dt>Población 2020</dt><dd>{fmtN(selected.poblacion)}</dd></div>
                <div><dt>Superficie</dt><dd>{selected.areaKm2.toLocaleString('es-MX', { maximumFractionDigits: 1 }).replace(/,/g, ' ')} km²</dd></div>
                <div><dt>Altitud</dt><dd>{fmtN(selected.minElev)} – {fmtN(selected.maxElev)} m</dd></div>
                <div><dt>Altitud media</dt><dd>{fmtN(selected.meanElev)} m</dd></div>
                <div><dt>Localidades</dt><dd>{fmtN(selected.localidades)}</dd></div>
              </dl>
              <button type="button" className="rh-text-btn" onClick={() => eng()?.select(selected.id, true)}><IconTarget />Acercar al municipio</button>
            </section>
          )}
          {showPanel && !kiosk && (
            <section className={'rh-panel' + (panelOpen ? ' rh-open' : '')} aria-label="Capas y luz">
              <div className="rh-panel-head">
                <button type="button" aria-expanded={panelOpen} aria-controls="rh-panel-body" onClick={() => setPanelOpen(!panelOpen)}>
                  <IconLayers />
                  <span className="rh-panel-name">Capas y luz</span>
                  <span className="rh-panel-sum">{BASE_MAPS.find(b => b.id === baseMap)?.label} · {isNight ? <IconMoon /> : <IconSun />}{fmtHour(hour)}</span>
                  <IconChevron />
                </button>
              </div>
              {panelOpen && (
                <div className="rh-panel-body" id="rh-panel-body">
                  <div className="rh-psec">
                    <div className="rh-psec-title">Mapa base</div>
                    <div className="rh-basemaps" role="radiogroup" aria-label="Mapa base" aria-busy={baseLoading}>
                      {BASE_MAPS.map(b => (
                        <button key={b.id} type="button" role="radio" aria-checked={baseMap === b.id} title={BASE_LEGEND[b.id].hint} onClick={() => chooseBase(b.id)}>
                          <i className={'rh-bm-' + b.id} aria-hidden="true" />{b.label}
                        </button>
                      ))}
                    </div>
                    <p className="rh-cap">{BASE_LEGEND[baseMap].hint}</p>
                    {/* en el celular la leyenda va aquí (no hay espacio para la flotante) */}
                    {showLegend && <div className="rh-legend-inline"><BaseLegend baseMap={baseMap} /></div>}
                  </div>

                  <div className="rh-psec">
                    <div className="rh-psec-title">Capas</div>
                    <div className="rh-toggles rh-checks" role="group" aria-label="Capas">
                      {/* (en Básica no hay edificios) */}
                      {LAYER_LABELS.filter(([k]) => k !== 'buildings' || (qInfo && qInfo.tier !== 'low')).map(([k, t]) => (
                        <button key={k} type="button" aria-pressed={layers[k]} onClick={() => toggleLayer(k)}>{t}</button>
                      ))}
                    </div>
                  </div>

                  {layers.clouds && (
                    <div className="rh-psec rh-sky" role="group" aria-label="Nubes">
                      <div className="rh-psec-title">Nubes</div>
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
                                : live.state === 'error' ? <><b>No se pudo descargar la imagen</b><span className="rh-cap">{live.message ?? 'Revisa tu conexión'} · <button type="button" className="rh-link" onClick={retryLive}>Reintentar</button></span></>
                                : <>
                                  <b>{live.shown !== undefined ? `Imagen de las ${fmtHour(mxHour(live.shown))}` : 'Imagen del satélite'}</b>
                                  <span className="rh-cap">
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
                      <p className="rh-cap">{activeDef ? 'Ocultas mientras hay un análisis abierto.' : isLive ? 'La hora del sol elige la imagen del satélite.' : skyFor(clouds.kind, hour).text || 'Cambian con la hora del día.'}</p>
                    </div>
                  )}

                  <div className="rh-psec">
                    <div className="rh-psec-title">Relieve y luz</div>
                    <div className="rh-ctl">
                      <div className="rh-head"><label htmlFor="rh-exag">Exageración vertical</label><output htmlFor="rh-exag">{exag.toFixed(1)}×</output></div>
                      <input id="rh-exag" type="range" min={1} max={6} step={0.1} value={exag}
                        onChange={e => { const v = +e.target.value; setExag(v); eng()?.setExaggeration(v); }} />
                      <p className="rh-cap">{exag < 1.05 ? 'Altura real: así de altos son los cerros respecto a su ancho.' : `Los cerros se ven ${exag.toFixed(1)} veces más altos que en la realidad, para que el relieve se note.`}</p>
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
                      <p className="rh-cap">
                        {sun ? (pastDay && sun !== info
                          ? `El ${fmtDate(pastDay, false)} amaneció a las ${fmtHour(sun.sunrise)} y anocheció a las ${fmtHour(sun.sunset)}.`
                          : `Sombras con el sol real de hoy: amanece a las ${fmtHour(sun.sunrise)} y anochece a las ${fmtHour(sun.sunset)}. De noche se encienden las localidades.`)
                          : 'Sombras con el sol real de hoy.'}
                      </p>
                    </div>
                  </div>

                  <div className="rh-psec">
                    <div className="rh-psec-title">Calidad de imagen</div>
                    <div className="rh-seg rh-seg5" role="radiogroup" aria-label="Calidad de imagen">
                      {QUALITY_LEVELS.map(l => (
                        <button key={l.id} type="button" role="radio" aria-checked={quality === l.id} title={l.hint} disabled={!ready} onClick={() => chooseQuality(l.id)}>{l.label}</button>
                      ))}
                    </div>
                    <p className="rh-cap">{qualityCaption(quality, qInfo)}</p>
                  </div>

                  <details className="rh-psec rh-more">
                    <summary>Cómo moverse en el mapa</summary>
                    <dl className="rh-howto">
                      {(touchUi ? HOWTO_TOUCH : HOWTO_MOUSE).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
                    </dl>
                  </details>
                  <details className="rh-psec rh-more">
                    <summary>Fuentes de los datos</summary>
                    <p className="rh-cap">
                      Elevación: INEGI (Continental relief 2016) y USGS (SRTM, GMTED2010), vía Terrain Tiles (AWS) · Ríos y presas: © OpenStreetMap y red de drenaje calculada del relieve · Límites: INEGI 2022 · Localidades y colonias: INEGI (Censo 2020, catálogo de localidades y DENUE)
                      {layers.clouds && (isLive ? ` · Nubes ${pastDay ? 'del ' + fmtDate(pastDay, false) : 'de hoy'}: satélite GOES-Este (NOAA), vía NASA GIBS (ESDIS); alturas estimadas por la temperatura de la cima` : ' · Nubes: simuladas, según la lluvia media anual de INEGI')}
                      {layers.buildings && qInfo && qInfo.tier !== 'low' && ' · Edificios: © Microsoft (Global ML Building Footprints, ODbL); alturas estimadas por el tamaño de la huella y la densidad de cada zona'}
                      {baseCredit && ` · ${baseCredit}`}
                    </p>
                  </details>
                </div>
              )}
            </section>
          )}
        </div>

        <div className="rh-right">
          {showLegend && !kiosk && (
            <section className={'rh-legend' + (legendBody ? '' : ' rh-closed') + (baseMap === 'usodesuelo' ? ' rh-legend-wide' : '')} aria-label={'Mapa base: ' + baseInfo.title}>
              <button type="button" className="rh-legend-head" aria-expanded={legendBody} onClick={toggleLegend} title={legendBody ? 'Ocultar la leyenda' : 'Mostrar la leyenda'}>
                <span><b>{baseInfo.title}</b><small>{activeDef ? 'Mapa base, debajo del análisis' : `Mapa base · ${baseInfo.source}`}</small></span>
                <IconChevron />
              </button>
              {legendBody && <div className="rh-legend-body"><BaseLegend baseMap={baseMap} /></div>}
            </section>
          )}
          <nav className="rh-nav" aria-label="Controles del mapa">
            {!kiosk && (
              <>
                <div className="rh-navg rh-navg-zoom">
                  <button type="button" data-tip="Acercar (+)" aria-label="Acercar" onClick={() => eng()?.zoomBy(0.6)}><IconPlus /></button>
                  <button type="button" data-tip="Alejar (−)" aria-label="Alejar" onClick={() => eng()?.zoomBy(1.6)}><IconMinus /></button>
                </div>
                <div className="rh-navg">
                  <button type="button" data-tip="Norte arriba (N)" aria-label="Orientar al norte" onClick={() => eng()?.northUp()}><span className="rh-needle" ref={needleRef}><IconCompass /></span></button>
                  <button type="button" className="rh-nav-txt" data-tip="Vista desde arriba (T)" aria-label="Vista desde arriba, en 2D" aria-pressed={is2D} onClick={view2D}>2D</button>
                  <button type="button" className="rh-nav-txt" data-tip="Vista inclinada, en 3D" aria-label="Vista inclinada, en 3D" aria-pressed={!is2D} onClick={view3D}>3D</button>
                  <button type="button" data-tip="Vista inicial (R)" aria-label="Volver a la vista inicial" onClick={() => eng()?.goHome()}><IconHome /></button>
                </div>
                {showMinimap && (
                  <div className="rh-navg rh-navg-mini">
                    <button type="button" data-tip={miniOpen ? 'Ocultar el minimapa' : 'Minimapa de ubicación'} aria-label="Minimapa de ubicación" aria-pressed={miniOpen} aria-controls="rh-mini" onClick={() => setMiniOpen(!miniOpen)}><IconMap /></button>
                  </div>
                )}
              </>
            )}
            {showMinimap && !kiosk && (
              <div className="rh-mini" id="rh-mini" hidden={!miniOpen}>
                <canvas ref={miniRef} width={380} height={364} aria-label="Mapa de ubicación: toca para ir a un punto" />
                <div className="rh-cap">El recuadro es lo que ves. Clic o arrastra para moverte.</div>
              </div>
            )}
          </nav>
        </div>

        {!kiosk && (
          <div className="rh-foot">
            {ready && tips && !activeDef && (
              <div className="rh-tips" role="note"><IconHand />{touchUi ? 'Un dedo: girar · Dos dedos: acercar y mover · Toca un municipio para ver sus datos' : 'Arrastra para girar · Rueda: acercar · Clic derecho: mover · Clic en un municipio: ver sus datos'}</div>
            )}
            <div className="rh-status" aria-hidden="true">
              <span title="Municipio y altitud en el centro de la vista"><IconTarget /><span className="rh-where" ref={whereRef}>—</span><span className="rh-where-alt" ref={whereAltRef} /></span>
              <span title="Ancho aproximado de lo que se ve"><span className="rh-status-k">Ancho de la vista</span><span ref={zoomRef}>—</span></span>
            </div>
          </div>
        )}

        {!kiosk && (showAnalyses || showPanel) && (
          <nav className="rh-tabbar" aria-label="Paneles">
            {showAnalyses && (
              <button type="button" aria-pressed={!!activeDef && !aMin && !panelOpen} disabled={!ready} onClick={tabAnalysis}>
                {activeDef ? <AnalysisIcon id={activeDef.id} group={activeDef.grupo} /> : <IconGrid />}
                <span>{activeDef ? activeDef.titulo : menuLabel}</span>
              </button>
            )}
            {showPanel && (
              <button type="button" aria-pressed={panelOpen} onClick={() => setPanelOpen(!panelOpen)}><IconLayers /><span>Capas y luz</span></button>
            )}
          </nav>
        )}
      </div>

      <div className="rh-tag" ref={tagRef} aria-hidden="true">
        <strong ref={tagNameRef}>—</strong>
        <span className="rh-alt" ref={tagAltRef}>—</span>
        <span className="rh-near" ref={tagNearRef} />
        <span className="rh-info" ref={tagInfoRef} hidden />
      </div>
      {menuOpen && <AnalysisMenu active={analysis} onPick={openAnalysis} onClose={closeMenu} ids={school ? SCHOOL_ANALYSES : undefined} title={school ? 'Temas para clase' : 'Análisis'} />}
    </div>
  );
}

/** Qué hace la calidad elegida; en Auto, cuál se eligió para esta tarjeta gráfica, y si una más alta puede ir lenta. */
function qualityCaption(q: QualitySetting, info: QualityInfo | null) {
  const level = (id: QualitySetting) => QUALITY_LEVELS.find(l => l.id === id)!;
  if (!info) return q === 'auto' ? level('auto').hint + '.' : level(q).hint;
  const tier = q === 'auto' ? info.auto : q;
  const kind = info.gpuKind === 'integrated' ? ' (integrada)' : info.gpuKind === 'discrete' ? ' (dedicada)' : '';
  const card = info.gpu ? info.gpu + kind : 'esta tarjeta gráfica';
  if (q === 'auto') return `${level(tier).label} para ${card}. ${level(tier).hint}`;
  const slow = tierRank(tier) > tierRank(info.auto) ? ` Con ${card} puede ir lento: al moverte la resolución baja sola y al detenerte vuelve.` : '';
  return level(tier).hint + slow;
}

/** Lo que dice la leyenda de cada mapa base. */
const BASE_LEGEND: Record<BaseMapId, { title: string; source: string; hint: string }> = {
  usodesuelo: { title: 'Uso de suelo y vegetación', source: 'INEGI, Serie VII', hint: 'Colores de lo que cubre el suelo: cultivos, bosques, matorral, ciudades y agua (INEGI).' },
  satelite: { title: 'Imagen de satélite', source: 'Sentinel-2 · 2016', hint: 'Fotografía del satélite Sentinel-2 sin nubes: el color real del terreno.' },
  altitud: { title: 'Altitud', source: 'metros sobre el nivel del mar', hint: 'Colores según la altura: verdes en lo bajo, ocres en el altiplano y tonos oscuros en las cumbres.' },
};

function BaseLegend({ baseMap }: { baseMap: BaseMapId }) {
  if (baseMap === 'altitud') {
    return (
      <>
        <div className="rh-bar" style={{ background: altRampCss }} />
        <div className="rh-ticks"><span>0</span><span>1 000</span><span>2 000</span><span>3 000 m</span></div>
      </>
    );
  }
  if (baseMap === 'usodesuelo') {
    return (
      <>
        <ul className="rh-key">{USV_GROUPS.map(g => <li key={g.id}><i style={{ background: g.color }} />{g.nombre}</li>)}</ul>
        <p className="rh-key-note">Tonos más claros: vegetación secundaria (en recuperación).</p>
      </>
    );
  }
  return <p className="rh-key-note">Mosaico sin nubes de 2016 (EOX, Copernicus). Al acercarte se ve con más detalle.</p>;
}
