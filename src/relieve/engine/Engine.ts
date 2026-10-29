import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import metaJson from '../data/meta.json';
import { BASE_KM, makeGeo, type Geo } from '../shared/geo';
import type { TerrainApi } from '../shared/terrain';
import type { BuildRequest, BuildResult, DetailResult, LinesResult, Meta, TilePackInfo, WorkerMessage } from '../shared/types';
import { ALT_STOPS_HEX } from '../worker/palette';
import { Heightfield, type Hit, type Tiles30 } from './heightfield';
import { heightDefines, makeHeightUniforms, type HeightUniforms } from './heights';
import { Labels } from './labels';
import {
  PALETTE_ROW, blankTexture, createCasterDepthMaterial, createNightPointsMaterial, createTerrainMaterial, createWallDepthMaterial, createWallMaterial,
  makeSharedUniforms, makeTerrainUniforms, type SharedUniforms, type TerrainUniforms,
} from './materials';
import { BASE_MAPS, loadBaseMap, type BaseMapId, type LoadedBaseMap } from './basemaps';
import type { CompareHandle, CompareSpec, GridImage, MapApi, MapHit } from './mapApi';
import { Minimap } from './minimap';
import { Overlays } from './overlays';
import { Curtain, Rasters, makePalette, type RasterHandle } from './rasters';
import { buildIndex, extraIndex, prettyRiver, search, type ExtraPlaces, type PlaceColumns, type SearchItem } from './search';
import { mexicoDate, sunPosition, sunTimes, todayInMexico } from './sun';
import { TerrainLod } from './terrain';
import { TerrainService } from './terrainService';
import { TileSet } from './tiles';

export const meta = metaJson as unknown as Meta;

export type LayerKey = 'water' | 'places' | 'borders' | 'contours' | 'clouds';
export type Layers = Record<LayerKey, boolean>;
export type { BaseMapId } from './basemaps';
export { BASE_MAPS } from './basemaps';
export type LoadStage = 'download' | 'build' | 'gpu';

export interface MunicipioInfo {
  /** 1–84, en el orden de la clave INEGI */
  id: number;
  /** clave geoestadística INEGI, p. ej. «13048» */
  code: string;
  name: string;
  minElev: number;
  maxElev: number;
  meanElev: number;
  /** superficie del polígono INEGI */
  areaKm2: number;
  /** localidades con nombre en el mapa (etiquetas) */
  places: number;
  /** localidades del Censo 2020 (ITER) */
  localidades: number;
  /** habitantes, Censo 2020 */
  poblacion: number;
}

export interface ReadyInfo {
  /** extremos del estado medidos a 30 m */
  minElev: number;
  maxElev: number;
  sunrise: number;
  sunset: number;
  timings: Record<string, number>;
}

/** Vista de la cámara: punto que mira, distancia (unidades de escena = 100 km) y ángulos en grados. */
export interface View { lon: number; lat: number; dist: number; polar: number; az: number }

export interface EngineElements {
  root: HTMLElement;
  stage: HTMLElement;
  labels: HTMLElement;
  tag: HTMLElement;
  tagName: HTMLElement;
  tagAlt: HTMLElement;
  tagNear: HTMLElement;
  /** renglones extra de la ficha (uso de suelo, datos del análisis activo) */
  tagInfo?: HTMLElement | null;
  minimap?: HTMLCanvasElement | null;
  where?: HTMLElement | null;
  whereAlt?: HTMLElement | null;
  needle?: HTMLElement | null;
  zoomRead?: HTMLElement | null;
}

export interface EngineOptions {
  /** carpeta con los archivos de data/ si se sirven desde otro lugar (CDN, Laravel /public…) */
  dataBaseUrl?: string;
  quality?: 'auto' | 'high' | 'low';
  exaggeration: number;
  hour: number;
  layers: Layers;
  baseMap: BaseMapId;
  autoRotate: boolean;
  /** rueda solo con Ctrl/⌘ (para incrustar el mapa en una página que se desplaza) */
  cooperativeGestures: boolean;
  onProgress?(stage: LoadStage): void;
  onReady?(info: ReadyInfo): void;
  onError?(message: string): void;
  onSelect?(m: MunicipioInfo | null): void;
  onGestureHint?(): void;
  /** revisa errores de shaders (lento: espera a la GPU). Solo en desarrollo */
  debug?: boolean;
}

const UNIT = 0.01;   // 1 unidad de escena = 100 km
const ACCENT = '#ffcf7a';
/** relieve fino: 90 m entero hasta 60 km de la cámara y nada desde 100; 30 m entero hasta 14 km y nada desde 24 */
const LOD_BLEND = [60, 100, 14, 24] as const;
/** atlas de teselas: 14 × 14 ranuras de relieve de 30 m (145 nodos) y 8 × 8 de imagen (256 px) */
const DEM_SLOTS = 14, SAT_SLOTS = 8;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeIO = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fmt = (n: number) => Math.round(n).toLocaleString('es-MX').replace(/,/g, ' ');
/** Tras subir una textura de datos a la GPU se suelta la copia en CPU (función suelta: un cierre retendría su contexto). */
function freeImage(t: THREE.Texture) { (t.image as { data: unknown }).data = null; }
/** Textura de 1 × 1 RG8 (municipio 0, fuera del estado) hasta que llegan los datos. */
function blankRG() {
  const t = new THREE.DataTexture(new Uint8Array([0, 255]), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/** Color del cielo y de la bruma según la altura del Sol (grados). sRGB 0–1. */
const SKY: [number, [number, number, number], [number, number, number]][] = [
  [-12, [0.055, 0.086, 0.15], [0.047, 0.078, 0.14]],
  [-4, [0.23, 0.23, 0.35], [0.16, 0.14, 0.25]],
  [1.5, [0.83, 0.6, 0.45], [0.29, 0.18, 0.17]],
  [9, [0.79, 0.73, 0.65], [0.17, 0.16, 0.2]],
  [25, [0.68, 0.75, 0.81], [0.078, 0.106, 0.157]],
];
function skyAt(elDeg: number) {
  let k = 1;
  while (k < SKY.length - 1 && elDeg > SKY[k][0]) k++;
  const [e0, h0, g0] = SKY[k - 1], [e1, h1, g1] = SKY[k], t = clamp((elDeg - e0) / (e1 - e0), 0, 1);
  const lerp = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] - v) * t) as [number, number, number];
  return { haze: lerp(h0, h1), glow: lerp(g0, g1) };
}

interface Fly { t0: number; ms: number; fromT: THREE.Vector3; toT: THREE.Vector3; fromS: THREE.Spherical; toS: THREE.Spherical }

export class ReliefEngine {
  readonly meta = meta;
  readonly index: SearchItem[] = buildIndex(meta);
  private geo: Geo = makeGeo(meta);
  private worker: Worker | null = null;
  private disposed = false;
  private small: boolean;
  /** relieve fino (90 m) y teselas (30 m e imagen): solo en pantallas grandes y calidad no baja */
  private fineOn: boolean;
  private reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.005, 60);
  private model = new THREE.Group();
  private controls: OrbitControls;
  private shared: SharedUniforms = makeSharedUniforms();
  private hu: HeightUniforms = makeHeightUniforms();
  private tu: TerrainUniforms | null = null;
  private terrainMat: THREE.MeshStandardMaterial | null = null;
  private lod: TerrainLod | null = null;
  /** escena armada sin datos para compilar los sombreadores mientras el worker trabaja */
  private prep: {
    tu: TerrainUniforms; palette: THREE.DataTexture; walls: THREE.Mesh; dots: THREE.Points; night: THREE.Points; compile: Promise<unknown>;
  } | null = null;
  private hemi = new THREE.HemisphereLight(0xc4d6f2, 0x3b3026, 1.7);
  private sun = new THREE.DirectionalLight(0xfff0d8, 7);
  private moon = new THREE.DirectionalLight(0x9db4ff, 0);
  private ground: THREE.Mesh;
  private probe: THREE.Line;
  private disposables: { dispose(): void }[] = [];

  private hf: Heightfield | null = null;
  private labels: Labels | null = null;
  private mini: Minimap | null = null;
  private placeItems: { t: string; lon: number; lat: number; kind: number }[] = [];
  private placesPerMuni = new Uint16Array(85);
  private overlays: Overlays | null = null;
  private rasters: Rasters | null = null;
  private overlayLayer: RasterHandle | null = null;
  private baseMaps = new Map<BaseMapId, Promise<LoadedBaseMap>>();
  private base: { id: BaseMapId; map: LoadedBaseMap | null } = { id: 'altitud', map: null };
  private baseAnim: { from: number; to: number; t0: number; then?: () => void } | null = null;
  private baseReq = 0;
  private cmp: { curtain: Curtain; base: BaseMapId | null; req: number } | null = null;
  /** aparición del relieve fino (inicio del fundido) */
  private detailAnim: number | null = null;
  private pendingDetail: DetailResult | null = null;
  private pendingLines: LinesResult | null = null;
  private service: TerrainService | null = null;
  private demTiles: TileSet<Uint16Array> | null = null;
  private satTiles: TileSet<ImageBitmap> | null = null;
  private tiles30: Tiles30 | null = null;
  private tileDirty = true;
  private lastTiles = 0;
  private clickHandlers: ((hit: MapHit) => boolean | void)[] = [];
  private hoverProviders: ((hit: MapHit) => string[] | null)[] = [];

  // estado
  private ex = 0.02;
  private exTarget: number;
  private layers: Layers;
  private hour: number;
  private ymd = todayInMexico();
  private fly: Fly | null = null;
  private home = { target: new THREE.Vector3(0, -0.03, 0.05), pos: new THREE.Vector3(0.15, 1.75, 2.55) };

  // bucle
  private raf = 0;
  private running = false;
  /** escena armada y shaders compilados: antes de esto no se dibuja nada */
  private ready = false;
  private visible = true;
  private t0 = 0;
  private last = 0;
  private frameN = 0;
  private lastCam = new THREE.Matrix4();
  private lodEx = -1;
  private renderDirty = true;
  private shadowDirty = true;
  private labelsDirty = true;
  private miniDirty = true;
  private lastMove = 0;
  private ambientUntil = 0;
  private fullDpr: number;
  private dpr: number;
  private frameEma = 16;
  private moveFrames = 0;
  /** tiempos de carga en ms (descarga, worker, GPU, primer cuadro) */
  timings: Record<string, number> = {};

  // entrada
  private pointer = { x: 0, y: 0, in: false, dirty: false, type: 'mouse', down: false };
  private press = { x: 0, y: 0, t: 0 };
  private lastTap = 0;
  private cleanup: (() => void)[] = [];

  // temporales
  private raycaster = new THREE.Raycaster();
  private inv = new THREE.Matrix4();
  private ndc = new THREE.Vector2();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private camE = new THREE.Vector3();
  private sph = new THREE.Spherical();
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private tileBox = new THREE.Box3();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(private el: EngineElements, private opts: EngineOptions) {
    const q = opts.quality ?? 'auto';
    this.small = q === 'low' || (q === 'auto' && Math.min(screen.width, screen.height) < 640);
    this.fineOn = !this.small && q !== 'low';
    this.exTarget = opts.exaggeration;
    this.layers = { ...opts.layers };
    this.hour = opts.hour;
    this.fullDpr = this.dpr = Math.min(devicePixelRatio || 1, this.small ? 1.6 : 2);

    const renderer = (this.renderer = new THREE.WebGLRenderer({
      antialias: this.fullDpr < 1.75, alpha: true, powerPreference: 'high-performance',
    }));
    renderer.setPixelRatio(this.dpr);
    // revisar errores obliga al hilo principal a esperar la compilación en la GPU (~0.5 s al arrancar)
    renderer.debug.checkShaderErrors = !!opts.debug;
    renderer.setClearColor(0x000000, 0);
    // neutro (Khronos PBR Neutral): conserva el tono y la saturación de los colores de las leyendas
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;   // la sombra es estática: se recalcula solo si cambia el Sol o la exageración
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'Modelo 3D del relieve de Hidalgo. Flechas para moverte, + y − para acercar, Esc para quitar la selección.');
    el.stage.appendChild(canvas);

    this.scene.add(this.model);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.moon);
    const sun = this.sun;
    sun.castShadow = true;
    const sm = this.small ? 2048 : 4096;
    sun.shadow.mapSize.set(sm, sm);
    Object.assign(sun.shadow.camera, { left: -1.5, right: 1.5, top: 1.5, bottom: -1.5, near: 0.1, far: 12 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.01;
    sun.shadow.radius = 2.5;
    this.moon.position.set(-1.8, 3.2, 1.6);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.ShadowMaterial({ opacity: 0.38 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    const probeGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]);
    this.probe = new THREE.Line(probeGeo, new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9, depthTest: false }));
    this.probe.renderOrder = 5;
    this.probe.visible = false;
    this.scene.add(this.probe);
    this.disposables.push(this.ground.geometry, this.ground.material as THREE.Material, probeGeo, this.probe.material as THREE.Material);

    const c = (this.controls = new OrbitControls(this.camera, canvas));
    c.enableDamping = true; c.dampingFactor = 0.08;
    c.screenSpacePanning = false; c.panSpeed = 0.9;
    // con el relieve de 30 m se puede bajar hasta ~6 km; sin él, 12 km
    c.minDistance = this.fineOn ? 0.06 : 0.12; c.maxDistance = 6.5;
    c.maxPolarAngle = Math.PI * 0.47;
    c.rotateSpeed = 0.55; c.zoomSpeed = 0.9;
    c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    c.autoRotate = opts.autoRotate && !this.reduceMotion;
    c.autoRotateSpeed = 0.3;
    c.target.copy(this.home.target);
    this.camera.position.copy(this.home.pos);
    c.addEventListener('start', () => { c.autoRotate = false; this.fly = null; this.touch(); });
    c.addEventListener('change', () => this.wake());

    const g = this.geo;
    this.hu.uGridMap.value.set(g.xMin, g.zMin, meta.step * g.KX, meta.step * g.KZ);
    this.hu.uLod.value.set(...LOD_BLEND);

    this.bindInput(canvas);
    this.resize();
    this.placeSun();
    this.load().catch(e => this.fail(e));
  }

  /* ================= carga ================= */
  private dataUrls() {
    return {
      elev: this.dataUrl('elev.bin', new URL('../data/elev.bin', import.meta.url).href),
      muni: this.dataUrl('muni.bin', new URL('../data/muni.bin', import.meta.url).href),
      muniFine: this.dataUrl('muni-50m.bin', new URL('../data/muni-50m.bin', import.meta.url).href),
      vec: this.dataUrl('vec.bin', new URL('../data/vec.bin', import.meta.url).href),
    };
  }
  private terrainUrls() {
    return {
      detail: this.dataUrl('relieve-90m.bin', new URL('../data/relieve-90m.bin', import.meta.url).href),
      dem: this.dataUrl('relieve-30m.bin', new URL('../data/relieve-30m.bin', import.meta.url).href),
      flow: this.dataUrl('capas/flujo-90m.bin', new URL('../data/capas/flujo-90m.bin', import.meta.url).href),
      sat: this.dataUrl('capas/satelite-16m.bin', new URL('../data/capas/satelite-16m.bin', import.meta.url).href),
    };
  }

  /** Worker de relieve: en pantallas grandes arranca con el visor (relieve fino y teselas); si no, al primer análisis que lo pida. */
  private terrainService() {
    if (this.service || this.disposed) return this.service!;
    const grid = { W: meta.W, H: meta.H, step: meta.step, lon0: meta.lon0, lat0: meta.lat0 };
    this.service = new TerrainService(this.terrainUrls(), grid, {
      detail: this.fineOn, tiles: this.fineOn,
      onDetail: m => { if (this.hf) this.applyDetail(m); else this.pendingDetail = m; },
      onWarning: msg => console.warn('Relieve de Hidalgo:', msg),
    });
    return this.service;
  }

  /** Consultas de relieve para los análisis (elevación, perfiles, pendiente, cuencas…). */
  get terrain(): TerrainApi { return this.terrainService(); }

  private async load() {
    if (typeof DecompressionStream === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      throw new Error('Este navegador no puede abrir los datos del relieve. Actualízalo para verlo.');
    }
    // el relieve fino viene por su lado mientras se arma la escena
    if (this.fineOn) this.terrainService();
    const worker = (this.worker = new Worker(new URL('../worker/build.worker.ts', import.meta.url), { type: 'module' }));
    const req: BuildRequest = {
      urls: this.dataUrls(),
      grid: { W: meta.W, H: meta.H, step: meta.step, lon0: meta.lon0, lat0: meta.lat0 },
      quality: { tex: this.small ? 2048 : 4096, dotStep: this.small ? 4 : 3, mini: { w: 380, h: 364 } },
    };
    // después del primer cuadro llegan las líneas y se cierra el worker
    const finish = () => { worker.terminate(); if (this.worker === worker) this.worker = null; };
    // mientras el worker arma los datos, se compilan los sombreadores (antes iban después y sumaban ~0.5 s)
    this.prepare();
    const res = await new Promise<BuildResult>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
        const m = ev.data;
        if (m.type === 'progress') this.opts.onProgress?.(m.stage);
        else if (m.type === 'error') reject(new Error(m.message));
        else if (m.type === 'done') resolve(m);
        else if (m.type === 'warning') { console.warn('Relieve de Hidalgo:', m.message); finish(); }
        else { this.applyLines(m); finish(); }
      };
      worker.onerror = ev => reject(new Error(ev.message || 'Falló el procesamiento del relieve'));
      worker.postMessage(req);
    });
    if (this.disposed) { res.mini.close(); return; }
    this.opts.onProgress?.('gpu');
    let t = performance.now();
    this.setup(res);
    res.timings.setup = Math.round(performance.now() - t);
    // ceder el hilo entre preparar la escena y compilar: dos tareas cortas en vez de una larga
    await new Promise(r => setTimeout(r, 0));
    if (this.disposed) return;
    t = performance.now();
    // compilar los shaders antes del primer cuadro evita un tirón al aparecer (casi todo ya se compiló en prepare)
    await this.prep?.compile;
    await this.renderer.compileAsync(this.scene, this.camera).catch(() => undefined);
    if (this.disposed) return;
    res.timings.compile = Math.round(performance.now() - t);
    // las líneas y el relieve fino pueden haber llegado ya y anotado sus tiempos
    this.timings = Object.assign(res.timings, this.timings);
    this.ready = true;
    const { sunrise, sunset } = sunTimes(this.ymd, this.geo.latC, this.geo.lonC);
    this.t0 = this.last = performance.now();
    this.wake();
    this.opts.onReady?.({ minElev: meta.relief.min, maxElev: meta.relief.max, sunrise, sunset, timings: this.timings });
    if (this.pendingDetail) { this.applyDetail(this.pendingDetail); this.pendingDetail = null; }
    if (this.pendingLines) { this.applyLines(this.pendingLines); this.pendingLines = null; }
    if (this.service && this.fineOn) this.service.packs.then(p => this.setupTiles(p.dem, p.sat));
  }

  private fail(e: unknown) {
    if (this.disposed) return;
    this.opts.onError?.(e instanceof Error ? e.message : String(e));
  }

  /** Materiales y mallas sin datos, y su compilación (en paralelo con el worker). */
  private prepare() {
    const W = meta.W, H = meta.H;
    // paleta compartida con la rampa de altitud (las demás filas las llenan los mapas base y las capas)
    const palette = makePalette(ALT_STOPS_HEX, 3400);
    const tu = (this.tu = makeTerrainUniforms(this.shared, this.hu, { muni: blankRG(), fields: blankTexture([128, 0, 128, 128]), palette }, W, H));
    const defines = heightDefines(this.fineOn, this.fineOn);
    const terrainMat = (this.terrainMat = createTerrainMaterial(tu, defines));
    const casterMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const casterDepth = createCasterDepthMaterial(this.hu, tu);
    const lod = (this.lod = new TerrainLod(terrainMat, casterMat, casterDepth, { depth: this.fineOn ? 8 : 5, range: 30, n: 32 }));
    this.model.add(lod.view, lod.caster);
    const empty = (n: number) => new THREE.BufferAttribute(new Float32Array(0), n);

    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', empty(3));
    wg.setAttribute('normal', empty(3));
    const wallMat = createWallMaterial(this.shared, this.hu, defines);
    const walls = new THREE.Mesh(wg, wallMat);
    const wallDepth = createWallDepthMaterial(this.hu);
    walls.customDepthMaterial = wallDepth;
    // las paredes proyectan la sombra del bloque sobre el suelo
    walls.castShadow = walls.receiveShadow = true;
    walls.frustumCulled = false;
    this.model.add(walls);

    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', empty(3));
    dg.setAttribute('color', empty(3));
    const dotMat = new THREE.PointsMaterial({ size: this.small ? 1.4 : 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.2, depthWrite: false });
    const dots = new THREE.Points(dg, dotMat);
    this.model.add(dots);

    // luces de las localidades del censo, de tamaño según su población
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', empty(3));
    ng.setAttribute('aSize', empty(1));
    const nightMat = createNightPointsMaterial(this.shared, this.hu, defines, this.fullDpr);
    const night = new THREE.Points(ng, nightMat);
    night.frustumCulled = false;
    night.renderOrder = 2;
    this.model.add(night);

    this.disposables.push(palette, terrainMat, casterMat, casterDepth, lod, wg, wallMat, wallDepth, dg, dotMat, ng, nightMat);
    this.prep = { tu, palette, walls, dots, night, compile: this.renderer.compileAsync(this.scene, this.camera).catch(() => undefined) };
  }

  private setup(res: BuildResult) {
    const W = meta.W, H = meta.H, prep = this.prep!, tu = prep.tu;
    const hf = (this.hf = new Heightfield(this.geo, res.elev, res.muni, W, H));
    hf.setMuniFine(res.muniFine);

    // texturas: relieve de 270 m (para los vértices), campos por nodo, municipios + contorno
    const h0 = new THREE.DataTexture(res.elev, W, H, THREE.RedFormat, THREE.FloatType);
    h0.minFilter = h0.magFilter = THREE.NearestFilter;
    h0.needsUpdate = true;
    this.hu.tH0.value = h0;
    const fields = new THREE.DataTexture(res.fields, W, H, THREE.RGBAFormat);
    fields.minFilter = THREE.LinearMipmapLinearFilter;
    fields.magFilter = THREE.LinearFilter;
    fields.generateMipmaps = true;
    fields.needsUpdate = true;
    fields.onUpdate = freeImage;
    const mf = res.muniFine;
    const muniTex = new THREE.DataTexture(res.muniTex, mf.w, mf.h, THREE.RGFormat, THREE.UnsignedByteType);
    muniTex.minFilter = muniTex.magFilter = THREE.NearestFilter;
    muniTex.unpackAlignment = 1;
    muniTex.needsUpdate = true;
    muniTex.onUpdate = freeImage;
    tu.tMuni.value.dispose();
    tu.tMuni.value = muniTex;
    tu.uGrid.value.set(mf.w - 1, mf.h - 1);
    tu.tFields.value.dispose();
    tu.tFields.value = fields;
    const palette = prep.palette;

    // celdas del estado (y dos de margen) para no dibujar parches vacíos: dilatación separable
    const state = new Uint8Array(W * H), tmp = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      let s = 0;
      for (let d = -2; d <= 2; d++) { const cc = c + d; if (cc >= 0 && cc < W && res.muni[r * W + cc]) { s = 1; break; } }
      tmp[r * W + c] = s;
    }
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      let s = 0;
      for (let d = -2; d <= 2; d++) { const rr = r + d; if (rr >= 0 && rr < H && tmp[rr * W + c]) { s = 1; break; } }
      state[r * W + c] = s;
    }
    const g = this.geo;
    this.lod!.setData({ x0: g.xMin, z0: g.zMin, sx: meta.step * g.KX, sz: meta.step * g.KZ }, res.elev, state, W, H);

    const wg = prep.walls.geometry;
    wg.setAttribute('position', new THREE.BufferAttribute(res.walls.position, 3));
    wg.setAttribute('normal', new THREE.BufferAttribute(res.walls.normal, 3));
    const dg = prep.dots.geometry;
    dg.setAttribute('position', new THREE.BufferAttribute(res.dots.position, 3));
    dg.setAttribute('color', new THREE.BufferAttribute(res.dots.color, 3));
    dg.computeBoundingSphere();
    const ng = prep.night.geometry;
    ng.setAttribute('position', new THREE.BufferAttribute(res.lights.position, 3));
    ng.setAttribute('aSize', new THREE.BufferAttribute(res.lights.size, 1));
    const defines = heightDefines(this.fineOn, this.fineOn);

    this.disposables.push(h0, fields, muniTex);
    this.applyLayers();

    // etiquetas
    const labels = (this.labels = new Labels(this.el.labels, hf));
    const [plon, plat, pelev] = meta.relief.peak;
    labels.add({ t: 'Punto más alto', s: `${fmt(pelev)} m`, lat: plat, lon: plon, k: 'peak', pri: 1 });
    for (const [t, lat, lon] of [['Huasteca', 21.08, -98.45], ['Sierra Gorda', 21.02, -99.35], ['Valle del Mezquital', 20.38, -99.18],
      ['Sierra Alta', 20.75, -98.6], ['Altiplano', 19.82, -98.5], ['Sierra Otomí-Tepehua', 20.42, -98.2], ['Comarca Minera', 20.2, -98.68]] as const) {
      labels.add({ t, lat, lon, k: 'region', pri: 2, lift: 0.35 });
    }
    for (const [n, kind, lon, lat, m, pop] of meta.places) {
      const isCap = n === 'Pachuca de Soto' && m === 48;
      labels.add({ t: n, s: isCap ? 'capital' : undefined, lat, lon, k: kind === 0 ? 'city' : kind === 1 ? 'town' : 'village', pri: kind === 0 ? 0 : kind === 1 ? 3 : 6, pop });
      this.placeItems.push({ t: n, lon, lat, kind });
      this.placesPerMuni[m]++;
    }
    for (const r of meta.riverLabels) labels.add({ t: prettyRiver(r.n), lat: r.lat, lon: r.lon, k: 'river', pri: 4, lift: 0.03 });
    for (const l of meta.lakeLabels) labels.add({ t: l.n, lat: l.lat, lon: l.lon, k: 'lake', pri: 4, lift: 0.03 });
    labels.sort();

    if (this.el.minimap) {
      this.mini = new Minimap(this.el.minimap, hf, res.mini,
        // en el minimapa solo las cinco ciudades más pobladas (meta.places viene ordenado por tamaño)
        this.placeItems.filter(p => p.kind === 0).slice(0, 5), ACCENT, () => { this.miniDirty = true; this.wake(); });
    } else res.mini.close();

    this.overlays = new Overlays(this.model, hf, this.fullDpr, { uniforms: this.hu, defines }, () => this.invalidate());
    this.overlays.resolution.set(this.el.stage.clientWidth || 1, this.el.stage.clientHeight || 1);
    this.rasters = new Rasters(tu, palette, meta, n => this.setDefine('RH_RASTERS', String(n)), () => this.invalidate());
    this.model.scale.set(UNIT, UNIT * this.ex, UNIT);
    this.model.updateMatrixWorld();
    this.updateLod();
    this.setBaseMap(this.opts.baseMap);
  }

  /** Cambia un define del sombreador del relieve (capas raster, cortina): recompila esa variante la primera vez. */
  private setDefine(key: string, value: string | null) {
    const m = this.terrainMat;
    if (!m) return;
    const d = m.defines as Record<string, string>;
    if (value === null ? !(key in d) : d[key] === value) return;
    if (value === null) delete d[key]; else d[key] = value;
    m.needsUpdate = true;
    this.invalidate();
  }

  /** Ríos, presas y límites como campos de distancia (llegan del worker después del primer cuadro). */
  private applyLines(m: LinesResult) {
    const tu = this.tu;
    if (this.disposed) return;
    if (!tu || !this.hf) { this.pendingLines = m; return; }
    const tex = new THREE.DataTexture(m.data, m.size, m.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    tex.onUpdate = freeImage;
    const g = this.geo;
    tu.tLines.value = tex;
    tu.uLines.value = 1;
    tu.uLinesSize.value = m.size;
    tu.uLinesRange.value = m.range;
    tu.uLinesTexelM.value = (((g.xMax - g.xMin) + (g.zMax - g.zMin)) / 2 / m.size) * 1000;
    this.disposables.push(tex);
    this.timings.lines = m.ms;
    this.invalidate();
  }

  /**
   * Relieve de 90 m: altura para los vértices y la ficha; normales y apertura del cielo (calculada aquí en la GPU, una
   * sola pasada) empacadas en una textura para el sombreado. Aparece con un fundido.
   */
  private applyDetail(m: DetailResult) {
    const tu = this.tu, hf = this.hf;
    if (!tu || !hf || this.disposed) return;
    const t = performance.now();
    const hTex = new THREE.DataTexture(m.elev, m.w, m.h, THREE.RedFormat, THREE.FloatType);
    hTex.minFilter = hTex.magFilter = THREE.NearestFilter;
    hTex.needsUpdate = true;
    hf.setDetail({ w: m.w, h: m.h, f: m.f, data: Int16Array.from(m.elev) });
    hTex.onUpdate = freeImage;
    const nTex = new THREE.DataTexture(m.normal, m.w, m.h, THREE.RGFormat, THREE.HalfFloatType);
    nTex.minFilter = nTex.magFilter = THREE.NearestFilter;
    nTex.needsUpdate = true;
    const cell = (meta.step / m.f) * 1000;
    // media precisión si se puede dibujar en ella (casi todos los equipos de escritorio); si no, 8 bits
    const half = this.renderer.extensions.has('EXT_color_buffer_float');
    const rt = this.detailPass(nTex, hTex, m.w, m.h, cell * this.geo.KX, cell * this.geo.KZ, half);
    nTex.dispose();
    this.hu.tH1.value = hTex;
    tu.tDetail.value = rt.texture;
    tu.uDetailSize.value.set(m.w, m.h);
    tu.uDetailEnc.value.set(half ? 1 : 2, half ? 0 : -1);
    this.disposables.push(hTex, rt);
    this.detailAnim = performance.now();
    this.timings.detail = m.ms + Math.round(performance.now() - t);
    this.lodEx = -1;
    this.wake();
  }

  /**
   * Una pasada en la GPU: normal de 90 m (x, z) y apertura del cielo (1 − promedio del seno del ángulo del horizonte en
   * 16 direcciones hasta ~3 km, en escala real; 1 = llano abierto) en una textura RGBA con mipmaps.
   */
  private detailPass(normals: THREE.Texture, heights: THREE.Texture, w: number, h: number, dxm: number, dzm: number, half: boolean) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGBAFormat, type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: false,
      generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    rt.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const mat = new THREE.ShaderMaterial({
      uniforms: { tH: { value: heights }, tN: { value: normals }, uCell: { value: new THREE.Vector2(dxm, dzm) }, uEnc: { value: half ? 0 : 1 } },
      vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform highp sampler2D tH; uniform sampler2D tN; uniform vec2 uCell; uniform float uEnc;
        void main() {
          ivec2 p = ivec2(gl_FragCoord.xy), size = textureSize(tH, 0);
          float z0 = texelFetch(tH, p, 0).r, sum = 0.0;
          if (z0 > 0.0) {
            for (int k = 0; k < 16; k++) {
              float a = 6.2831853 * (float(k) + 0.5) / 16.0, best = 0.0, d = 1.0;
              vec2 dir = vec2(cos(a), sin(a));
              for (int s = 0; s < 12; s++) {
                vec2 o = floor(dir * d + 0.5);
                ivec2 q = p + ivec2(o);
                if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) break;
                float zq = texelFetch(tH, q, 0).r;
                if (zq > 0.0) best = max(best, (zq - z0) / max(length(o * uCell), 1.0));
                d = max(d + 1.0, floor(d * 1.3 + 0.5));
              }
              sum += best * inversesqrt(1.0 + best * best);
            }
          }
          vec2 n = texelFetch(tN, p, 0).rg;
          gl_FragColor = vec4(uEnc > 0.5 ? n * 0.5 + 0.5 : n, 1.0 - sum / 16.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const scene = new THREE.Scene().add(quad), prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.render(scene, new THREE.OrthographicCamera());
    this.renderer.setRenderTarget(prev);
    quad.geometry.dispose();
    mat.dispose();
    return rt;
  }

  /** Teselas de detalle: relieve de 30 m (alturas + normales) e imagen satelital fina, en atlas de la GPU. */
  private setupTiles(dem: TilePackInfo | null, sat: TilePackInfo | null) {
    const tu = this.tu, hf = this.hf, svc = this.service;
    if (!tu || !hf || !svc || this.disposed || (!dem && !sat)) return;
    const info = dem ?? sat!, rows = (dem?.ny ?? 0) + (sat?.ny ?? 0);
    const pages = new THREE.DataTexture(new Uint8Array(info.nx * rows * 4), info.nx, rows, THREE.RGBAFormat);
    pages.minFilter = pages.magFilter = THREE.NearestFilter;
    pages.needsUpdate = true;
    this.hu.tPages.value = pages;
    this.disposables.push(pages);
    const r = this.renderer, at = new THREE.Vector2();
    if (dem) {
      const S = dem.px - 2, size = S * DEM_SLOTS;
      const atlas = new THREE.DataTexture(new Uint16Array(size * size * 2), size, size, THREE.RGIntegerFormat, THREE.UnsignedShortType);
      atlas.internalFormat = 'RG16UI';
      atlas.minFilter = atlas.magFilter = THREE.NearestFilter;
      atlas.unpackAlignment = 1;
      atlas.needsUpdate = true;
      r.initTexture(atlas);
      (atlas.image as { data: Uint16Array | null }).data = null;
      this.hu.tH2.value = atlas;
      this.hu.uPage2.value.set(dem.nx, dem.ny, S, dem.tileCells * dem.f);
      this.hu.uH2On.value = 1;
      this.tiles30 = { nx: dem.nx, ny: dem.ny, cells: dem.tileCells, f: dem.f, px: S, data: new Map() };
      hf.setTiles(this.tiles30);
      this.demTiles = new TileSet<Uint16Array>({
        info: dem, slotPx: S, slots: DEM_SLOTS, atlas, pages, pageRow: 0, concurrency: 6,
        load: i => svc.tile('dem', i),
        upload: (data, x, y) => {
          const src = new THREE.DataTexture(data, S, S, THREE.RGIntegerFormat, THREE.UnsignedShortType);
          src.unpackAlignment = 1;
          r.copyTextureToTexture(src, atlas, null, at.set(x, y));
        },
        onResident: (i, data) => this.tiles30?.data.set(i, data),
        onEvict: i => this.tiles30?.data.delete(i),
        onChange: () => { this.lodEx = -1; this.invalidate(); },
      });
      this.disposables.push(atlas);
    }
    if (sat) {
      const S = sat.px, size = S * SAT_SLOTS;
      const atlas = new THREE.DataTexture(new Uint8Array(size * size * 4), size, size, THREE.RGBAFormat);
      atlas.colorSpace = THREE.SRGBColorSpace;
      atlas.minFilter = atlas.magFilter = THREE.LinearFilter;
      atlas.generateMipmaps = false;
      atlas.needsUpdate = true;
      r.initTexture(atlas);
      (atlas.image as { data: Uint8Array | null }).data = null;
      tu.tSatAtlas.value = atlas;
      tu.uSatPage.value.set(sat.nx, sat.ny, dem?.ny ?? 0, sat.tileCells);
      tu.uSatSlot.value = S;
      tu.uSatAtlasSize.value.set(size, size);
      this.satTiles = new TileSet<ImageBitmap>({
        info: sat, slotPx: S, slots: SAT_SLOTS, atlas, pages, pageRow: dem?.ny ?? 0, concurrency: 6,
        load: i => svc.tile('sat', i),
        upload: (bmp, x, y) => {
          const src = new THREE.Texture(bmp);
          r.copyTextureToTexture(src, atlas, null, at.set(x, y));
          bmp.close();
        },
        // al llegar una tesela se piden las que siguen
        onChange: () => { this.tileDirty = true; this.invalidate(); },
      });
      this.disposables.push(atlas);
      this.applyBaseSlots();
    }
    this.tileDirty = true;
    this.wake();
  }

  /** Teselas que hacen falta según la cámara: las cercanas y a la vista, de la más cercana a la más lejana. */
  private updateTiles(now: number) {
    const lod = this.lod;
    if (!lod) return;
    const sets: [TileSet<Uint16Array> | TileSet<ImageBitmap>, number][] = [];
    if (this.demTiles) sets.push([this.demTiles, LOD_BLEND[3] + 4]);
    // la imagen fina solo si el satélite está a la vista (como mapa base o en la cortina)
    const satShown = this.base.id === 'satelite' || this.cmp?.base === 'satelite';
    if (this.satTiles) sets.push([this.satTiles, satShown ? 45 : 0]);
    const F = { x0: this.geo.xMin, z0: this.geo.zMin, sx: meta.step * this.geo.KX, sz: meta.step * this.geo.KZ };
    const ex = this.ex, camE = this.camE, box = this.tileBox;
    for (const [set, maxKm] of sets) {
      const { nx, ny, tileCells: T, has } = set.info, want = new Map<number, number>();
      if (maxKm > 0) {
        for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
          const i = ty * nx + tx;
          if (!has[i]) continue;
          const [lo, hi] = lod.bounds(T, tx, ty);
          const x0 = F.x0 + tx * T * F.sx, x1 = x0 + T * F.sx, z0 = F.z0 + ty * T * F.sz, z1 = z0 + T * F.sz;
          const y0 = ((lo - 400) / 1000) * ex, y1 = ((hi + 400) / 1000) * ex;
          const d = Math.hypot(Math.max(x0 - camE.x, 0, camE.x - x1), Math.max(y0 - camE.y, 0, camE.y - y1), Math.max(z0 - camE.z, 0, camE.z - z1));
          if (d > maxKm) continue;
          box.min.set(x0 * UNIT, y0 * UNIT, z0 * UNIT);
          box.max.set(x1 * UNIT, y1 * UNIT, z1 * UNIT);
          if (d > 6 && !this.frustum.intersectsBox(box)) continue;
          want.set(i, d);
        }
      }
      (set as TileSet<unknown>).update(want, now);
    }
  }

  /** Elige los parches del relieve para la cámara actual. */
  private updateLod() {
    const lod = this.lod, cam = this.camera;
    if (!lod) return;
    const l = this.v1.copy(cam.position).applyMatrix4(this.inv.copy(this.model.matrixWorld).invert());
    this.camE.set(l.x, l.y * this.ex, l.z);
    this.hu.uCamE.value.copy(this.camE);
    this.hu.uEx.value = this.ex;
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    lod.update(this.camE, this.frustum, UNIT, this.ex);
    this.lodEx = this.ex;
    this.tileDirty = true;
  }

  /* ================= API pública ================= */
  setLayer(key: LayerKey, on: boolean) { this.layers[key] = on; this.applyLayers(); this.labelsDirty = true; this.invalidate(); }
  setExaggeration(x: number) { this.exTarget = x; this.touch(); this.wake(); }
  setHour(h: number) { this.hour = h; this.placeSun(); this.invalidate(); }
  /** URL de un archivo de datos: carpeta pública si se configuró dataBaseUrl, si no la que resolvió el bundler. */
  dataUrl(name: string, bundled: string) {
    const base = this.opts.dataBaseUrl;
    return base ? new URL(name, new URL(base.replace(/\/?$/, '/'), location.href)).href : bundled;
  }

  private loadBase(id: Exclude<BaseMapId, 'altitud'>) {
    let p = this.baseMaps.get(id);
    if (!p) {
      p = loadBaseMap(id, {
        usvBin: this.dataUrl('capas/usv.bin', new URL('../data/capas/usv.bin', import.meta.url).href),
        usvJson: this.dataUrl('capas/usv.json', new URL('../data/capas/usv.json', import.meta.url).href),
        sat: this.small
          ? this.dataUrl('capas/satelite-2048.webp', new URL('../data/capas/satelite-2048.webp', import.meta.url).href)
          : this.dataUrl('capas/satelite-4096.webp', new URL('../data/capas/satelite-4096.webp', import.meta.url).href),
      }, this.renderer.capabilities.getMaxAnisotropy(), meta.W);
      this.baseMaps.set(id, p);
      p.then(b => this.disposables.push(b.texture), () => this.baseMaps.delete(id));
    }
    return p;
  }

  /** Pone los mapas base en las ranuras A (el del panel) y B (el de la cortina) del sombreador. */
  private applyBaseSlots() {
    const tu = this.tu;
    if (!tu) return;
    const slot = (map: LoadedBaseMap | null, kind: { value: number }, tex: { value: THREE.Texture }, size: { value: THREE.Vector2 }, tiles: { value: number }, row: number) => {
      kind.value = map ? map.kind : 0;
      tex.value = map ? map.texture : blankTexture();
      if (map) size.value.set(map.size[0], map.size[1]); else size.value.set(1, 1);
      tiles.value = map?.tiles && this.satTiles ? 1 : 0;
      if (map?.lut) { (tu.tPalette.value.image.data as Uint8Array).set(map.lut, row * 256 * 4); tu.tPalette.value.needsUpdate = true; }
    };
    slot(this.base.map, tu.uBaseKindA, tu.tBaseA, tu.uBaseSizeA, tu.uBaseTilesA, PALETTE_ROW.baseA);
    const b = this.cmp?.base ? this.baseMaps.get(this.cmp.base) : undefined;
    if (!b) slot(null, tu.uBaseKindB, tu.tBaseB, tu.uBaseSizeB, tu.uBaseTilesB, PALETTE_ROW.baseB);
    else b.then(map => { if (this.cmp && this.tu) { slot(map, tu.uBaseKindB, tu.tBaseB, tu.uBaseSizeB, tu.uBaseTilesB, PALETTE_ROW.baseB); this.invalidate(); } });
    this.tileDirty = true;
    this.invalidate();
  }

  /** Cambia el mapa base con un fundido; las texturas se cargan la primera vez que se piden. */
  setBaseMap(id: BaseMapId): Promise<void> {
    const tu = this.tu;
    if (!tu) return Promise.resolve();
    const req = ++this.baseReq;
    const fadeTo = (to: number, then?: () => void) => {
      this.baseAnim = { from: tu.uBaseTex.value, to, t0: performance.now(), then };
      this.wake();
    };
    if (id === 'altitud') { fadeTo(0, () => { this.base = { id, map: null }; this.applyBaseSlots(); }); return Promise.resolve(); }
    return this.loadBase(id).then(map => {
      if (req !== this.baseReq || this.disposed) return;
      const swap = () => { this.base = { id, map }; this.applyBaseSlots(); fadeTo(1); };
      if (tu.uBaseTex.value > 0.01 && this.base.map !== map) fadeTo(0, swap); else swap();
    });
  }
  get baseMapCredit() { return BASE_MAPS.find(b => b.id === this.base.id)?.credit ?? ''; }
  setAutoRotate(on: boolean) { this.controls.autoRotate = on && !this.reduceMotion; this.wake(); }
  zoomBy(f: number) {
    const s = this.curSph();
    this.flyTo(this.controls.target, { dist: clamp(s.radius * f, this.controls.minDistance, this.controls.maxDistance), ms: 450 });
  }
  northUp() { this.flyTo(this.controls.target, { azimuth: 0, ms: 700 }); }
  topView() { this.flyTo(this.controls.target, { polar: 0.001, azimuth: 0, ms: 900 }); }
  goHome() {
    const s = new THREE.Spherical().setFromVector3(this.home.pos.clone().sub(this.home.target));
    this.flyTo(this.home.target.clone(), { dist: s.radius, polar: s.phi, azimuth: s.theta, ms: 1100 });
    this.labels?.setPin(null);
    this.select(0);
  }
  search(q: string) { return search(this.index, q); }

  /**
   * Suma al buscador las localidades del ITER sin etiqueta y los lugares de lugares.bin (localidades del catálogo de
   * INEGI y colonias); las localidades pequeñas también se etiquetan al acercarse. Devuelve cuántos lugares agregó.
   */
  addPlaces(loc: PlaceColumns, lug: ExtraPlaces | null) {
    const items = extraIndex(this.index, meta, loc, lug);
    this.index.push(...items);
    for (const it of items) if (it.kind === 'Localidad' && it.pop) this.placeItems.push({ t: it.n, lon: it.lon, lat: it.lat, kind: 3 });
    if (this.labels) {
      for (const it of items) if (it.kind === 'Localidad' && it.pop) this.labels.add({ t: it.n, lat: it.lat, lon: it.lon, k: 'hamlet', pri: 8, pop: it.pop });
      this.labels.sort();
      this.labelsDirty = true;
      this.invalidate();
    }
    return items.length;
  }

  /** Vista actual: punto que mira y cámara (para enlaces a vistas y capturas reproducibles). */
  getView(): View {
    const t = this.v2.copy(this.controls.target).applyMatrix4(this.inv.copy(this.model.matrixWorld).invert()), s = this.curSph();
    return { lon: this.geo.lonOfX(t.x), lat: this.geo.latOfZ(t.z), dist: s.radius, polar: (s.phi * 180) / Math.PI, az: (s.theta * 180) / Math.PI };
  }
  /** Lleva la cámara a una vista (ms = 0: sin animación). */
  setView(v: View, ms = 1200) {
    if (!this.hf) return;
    this.flyTo(this.worldOf(v.lon, v.lat), {
      dist: clamp(v.dist, this.controls.minDistance, this.controls.maxDistance),
      polar: clamp((v.polar * Math.PI) / 180, 0.001, this.controls.maxPolarAngle), azimuth: (v.az * Math.PI) / 180, ms: Math.max(1, ms),
    });
  }

  /** Vuela a un resultado del buscador, lo marca y selecciona su municipio. */
  flyToItem(r: SearchItem) {
    if (!this.hf) return;
    const dist = r.kind === 'Municipio' ? clamp(Math.sqrt(r.area ?? 1000) * 0.012, 0.35, 1.6) : r.kind === 'Colonia' ? 0.12 : r.rank >= 3 ? 0.2 : 0.55;
    this.flyTo(this.worldOf(r.lon, r.lat), { dist, polar: Math.min(this.curSph().phi, 0.95), ms: 1500 });
    this.labels?.setPin(r.n, r.lat, r.lon);
    this.select(r.m || 0);
    this.labelsDirty = this.miniDirty = true;
  }

  /** Selecciona un municipio (1–84) o ninguno (0). */
  select(m: number, fly = false) {
    if (!this.tu) return;
    this.tu.uSel.value = m;
    this.opts.onSelect?.(m ? this.municipioInfo(m) : null);
    if (fly && m) {
      const [lon, lat, area] = meta.cent[m - 1];
      this.flyTo(this.worldOf(lon, lat), { dist: clamp(Math.sqrt(area) * 0.012, 0.35, 1.6), ms: 1200 });
    }
    this.invalidate();
  }

  municipioInfo(m: number): MunicipioInfo {
    const [minElev, maxElev, meanElev, areaKm2, localidades, poblacion] = meta.mun[m - 1];
    return {
      id: m, code: meta.codes[m - 1], name: meta.names[m - 1],
      minElev, maxElev, meanElev, areaKm2, places: this.placesPerMuni[m], localidades, poblacion,
    };
  }

  /**
   * Colorea municipios con datos propios (p. ej. un indicador del laboratorio).
   * colors: clave INEGI («13048») o id (1–84) → color CSS. null quita la capa.
   */
  setMunicipioColors(colors: Record<string | number, string> | null, strength = 0.85) {
    if (!this.tu) return;
    const tex = this.tu.tPalette.value, data = tex.image.data as Uint8Array, row = PALETTE_ROW.choro * 256 * 4;
    data.fill(0, row, row + 256 * 4);
    if (colors) {
      const c = new THREE.Color();
      for (const [k, css] of Object.entries(colors)) {
        const m = /^\d{5}$/.test(k) ? meta.codes.indexOf(k) + 1 : Number(k);
        if (!(m >= 1 && m <= 84)) continue;
        c.setStyle(css, THREE.SRGBColorSpace);
        const srgb = c.clone().convertLinearToSRGB();
        data.set([srgb.r * 255, srgb.g * 255, srgb.b * 255, 255], row + m * 4);
      }
    }
    tex.needsUpdate = true;
    this.tu.uChoroAmt.value = colors ? strength : 0;
    this.invalidate();
  }

  /** Capa de colores sobre el terreno, alineada a la rejilla (texel i centrado en el nodo i). null la quita. */
  setOverlay(img: GridImage | null, opacity = 0.85) {
    if (!this.rasters) return;
    this.overlayLayer?.dispose();
    this.overlayLayer = null;
    if (!img) return;
    const sx = (meta.W - 1) / Math.max(1, img.width - 1), sy = (meta.H - 1) / Math.max(1, img.height - 1);
    this.overlayLayer = this.rasters.add({
      kind: 'rgba', width: img.width, height: img.height, data: img.rgba, opacity,
      bounds: [meta.lon0 - (sx / 2) * meta.step, meta.lat0 - (meta.H - 1 + sy / 2) * meta.step, meta.lon0 + (meta.W - 1 + sx / 2) * meta.step, meta.lat0 + (sy / 2) * meta.step],
    });
  }

  /** Cortina para comparar un mapa base (derecha) con el del panel, o capas raster con side. */
  compare(spec: CompareSpec = {}): CompareHandle {
    this.cmp?.curtain.dispose();
    const req = (this.cmp?.req ?? 0) + 1;
    const curtain = new Curtain(this.el.root, spec.position ?? 0.5, spec.labels ?? ['', ''], () => this.invalidate());
    const base = spec.base && spec.base !== 'altitud' ? spec.base : null;
    this.cmp = { curtain, base, req };
    if (base) this.loadBase(base).then(() => this.applyBaseSlots(), e => console.warn('Relieve de Hidalgo:', e));
    else this.applyBaseSlots();
    this.setDefine('RH_COMPARE', '');
    const engine = this;
    return {
      get position() { return curtain.position; },
      setPosition: x => curtain.set(x),
      setLabels: (l, r) => curtain.setLabels(l, r),
      onChange: fn => curtain.onChange(fn),
      dispose() {
        if (engine.cmp?.req !== req) return;
        curtain.dispose();
        engine.cmp = null;
        if (engine.tu) engine.tu.uCurtain.value = -1;
        engine.setDefine('RH_COMPARE', null);
        engine.applyBaseSlots();
      },
    };
  }

  /** Vuela a lon/lat mostrando unos viewKm de ancho. */
  flyToLonLat(lon: number, lat: number, viewKm?: number) {
    if (!this.hf) return;
    const dist = viewKm ? (viewKm * UNIT) / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * Math.min(1, this.camera.aspect)) : undefined;
    this.flyTo(this.worldOf(lon, lat), { dist: dist && clamp(dist, this.controls.minDistance, this.controls.maxDistance), ms: 1200 });
  }

  /**
   * API para un análisis. Todo lo que cree (capas, colores, marcador, oyentes) se borra con dispose(),
   * así un análisis nuevo no puede dejar basura ni romper a los demás.
   */
  createScope(): MapApi {
    const handles = new Set<{ dispose(): void }>(), offs: (() => void)[] = [];
    let fill = false, overlay = false, pin = false, alive = true;
    const track = <T extends { dispose(): void }>(h: T): T => {
      handles.add(h);
      const d = h.dispose.bind(h);
      h.dispose = () => { handles.delete(h); d(); };
      return h;
    };
    const hook = <T>(list: T[], fn: T) => { list.push(fn); const off = () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; offs.push(off); return off; };
    const ov = () => { if (!this.overlays) throw new Error('El relieve aún no está listo'); return this.overlays; };
    const rs = () => { if (!this.rasters) throw new Error('El relieve aún no está listo'); return this.rasters; };
    return {
      meta,
      elevationAt: (lon, lat) => this.hf?.surfaceLL(lat, lon) ?? 0,
      municipioAt: (lon, lat) => this.hf?.muniLL(lat, lon) ?? 0,
      setMunicipioFill: (c, strength) => { fill = !!c; this.setMunicipioColors(c, strength); },
      setOverlay: (img, opacity) => { overlay = !!img; this.setOverlay(img, opacity); },
      addPoints: spec => track(ov().addPoints(spec)),
      addLines: spec => track(ov().addLines(spec)),
      addRaster: spec => track(rs().add(spec)),
      compare: spec => track(this.compare(spec)),
      flyTo: (lon, lat, km) => this.flyToLonLat(lon, lat, km),
      select: (m, fly) => this.select(m, fly),
      highlight: m => { if (this.tu) { this.tu.uSel.value = m; this.invalidate(); } },
      municipioGrid: () => this.hf?.muni ?? new Uint8Array(meta.W * meta.H),
      setPin: (label, lon = 0, lat = 0) => { pin = label !== null; this.labels?.setPin(label, lat, lon); this.labelsDirty = this.miniDirty = true; this.invalidate(); },
      onClick: fn => hook(this.clickHandlers, fn),
      onHover: fn => hook(this.hoverProviders, fn),
      dispose: () => {
        if (!alive) return;
        alive = false;
        for (const h of [...handles]) h.dispose();
        for (const off of offs) off();
        if (fill) this.setMunicipioColors(null);
        if (overlay) this.setOverlay(null);
        if (pin) this.labels?.setPin(null);
        this.pointer.dirty = true;
        this.invalidate();
      },
    };
  }

  /** PNG de la vista actual, con nombres visibles y créditos. */
  async screenshot(): Promise<Blob> {
    const src = this.renderer.domElement, w = src.width, h = src.height, k = w / src.clientWidth;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d')!;
    const sky = skyAt(this.sunElevDeg);
    const bg = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, Math.max(w, h) * 0.6);
    bg.addColorStop(0, `rgb(${sky.glow.map(v => Math.round(v * 255)).join(',')})`);
    bg.addColorStop(1, '#06080d');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    // sin la guía ni el resaltado del cursor
    const probe = this.probe.visible, hover = this.tu?.uHover.value ?? 0;
    this.probe.visible = false;
    if (this.tu) this.tu.uHover.value = 0;
    this.renderer.render(this.scene, this.camera);
    ctx.drawImage(src, 0, 0);
    this.probe.visible = probe;
    if (this.tu) this.tu.uHover.value = hover;
    this.invalidate();
    ctx.textBaseline = 'middle';
    for (const o of this.labels?.items ?? []) {
      if (!o.on || o.x === undefined || o.y === undefined) continue;
      const x = o.x * k, y = (o.y + 9) * k;
      const big = o.k === 'city', reg = o.k === 'region';
      ctx.font = `${big ? 600 : 400} ${Math.round((big ? 13 : reg ? 10.5 : 12) * k)}px "Familjen Grotesk", system-ui, sans-serif`;
      ctx.fillStyle = o.k === 'river' || o.k === 'lake' ? '#8fd3f0' : reg ? '#8a92a3' : '#eef1f5';
      ctx.shadowColor = 'rgba(6,8,13,0.9)'; ctx.shadowBlur = 4 * k;
      ctx.fillText(reg ? o.t.toUpperCase() : o.t, x + (o.k === 'region' || o.k === 'river' || o.k === 'lake' ? 0 : 10 * k), y);
    }
    ctx.shadowBlur = 0;
    ctx.font = `600 ${Math.round(18 * k)}px "Familjen Grotesk", system-ui, sans-serif`;
    ctx.fillStyle = '#eef1f5';
    ctx.fillText('Relieve de Hidalgo', 20 * k, 26 * k);
    ctx.font = `${Math.round(10 * k)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(238,241,245,0.75)';
    ctx.fillText(`Elevación: INEGI y USGS (Terrain Tiles) · Agua: © OpenStreetMap · Límites y localidades: INEGI · Exageración vertical ${this.exTarget.toFixed(1)}×`, 20 * k, h - 18 * k);
    return new Promise((resolve, reject) => out.toBlob(b => (b ? resolve(b) : reject(new Error('No se pudo generar la imagen'))), 'image/png'));
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.worker?.terminate();
    this.service?.dispose();
    this.demTiles?.dispose();
    this.satTiles?.dispose();
    this.cmp?.curtain.dispose();
    for (const f of this.cleanup) f();
    this.controls.dispose();
    this.overlays?.dispose();
    this.rasters?.dispose();
    for (const d of this.disposables) d.dispose();
    this.labels?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /* ================= luz ================= */
  private sunElevDeg = 45;
  private placeSun() {
    const { azimuth: az, elevation: el } = sunPosition(mexicoDate(this.ymd, this.hour), this.geo.latC, this.geo.lonC);
    this.sunElevDeg = (el * 180) / Math.PI;
    const elL = Math.max(0.05, el), d = 4;
    this.sun.position.set(Math.cos(elL) * Math.sin(az) * d, Math.sin(elL) * d, -Math.cos(elL) * Math.cos(az) * d);
    const day = smooth(-0.03, 0.1, el), hi = clamp(el, 0, 1);
    const warm = 1 - Math.min(1, Math.max(0, el) / 0.6);
    this.sun.color.setRGB(1, 0.94 - warm * 0.24, 0.85 - warm * 0.45, THREE.SRGBColorSpace);
    this.sun.intensity = Math.PI * (1.5 + hi) * day;
    this.hemi.intensity = Math.PI * (0.35 + hi * 0.3) * (0.3 + 0.7 * day);
    this.hemi.color.set(day > 0.5 ? 0xc4d6f2 : 0x8197c4).lerp(new THREE.Color(0xc4d6f2), day);
    this.moon.intensity = Math.PI * 0.3 * (1 - day);
    this.shared.uNight.value = 1 - smooth(-0.1, 0.02, el);
    const sky = skyAt(this.sunElevDeg);
    this.shared.uHazeColor.value.set(...sky.haze);
    this.el.root.style.setProperty('--rh-glow', `rgb(${sky.glow.map(v => Math.round(v * 255)).join(' ')})`);
    this.shadowDirty = true;
  }

  private applyLayers() {
    if (!this.tu) return;
    const L = this.layers;
    this.tu.uWater.value = L.water ? 1 : 0;
    this.tu.uBorders.value = L.borders ? 1 : 0;
    this.tu.uContours.value = L.contours ? 1 : 0;
    this.shared.uClouds.value = L.clouds ? 1 : 0;
    if (L.clouds) this.touch();
  }

  /* ================= cámara ================= */
  private worldOf(lon: number, lat: number, liftKm = 0) {
    return new THREE.Vector3(this.geo.toX(lon), this.hf!.surfaceLL(lat, lon) / 1000 + liftKm, this.geo.toZ(lat)).applyMatrix4(this.model.matrixWorld);
  }
  private curDist() { return this.camera.position.distanceTo(this.controls.target); }
  private curSph() { return new THREE.Spherical().setFromVector3(this.v1.copy(this.camera.position).sub(this.controls.target)); }

  private flyTo(target: THREE.Vector3, { dist, polar, azimuth, ms = 1300 }: { dist?: number; polar?: number; azimuth?: number; ms?: number } = {}) {
    this.controls.autoRotate = false;
    const from = this.curSph();
    const toS = new THREE.Spherical(dist ?? from.radius, polar ?? from.phi, azimuth ?? from.theta);
    let dth = toS.theta - from.theta;
    while (dth > Math.PI) dth -= 2 * Math.PI;
    while (dth < -Math.PI) dth += 2 * Math.PI;
    toS.theta = from.theta + dth;
    this.fly = { t0: performance.now(), ms: this.reduceMotion ? 1 : ms, fromT: this.controls.target.clone(), toT: target.clone(), fromS: from, toS };
    this.touch();
    this.wake();
  }

  private stepFly(now: number) {
    const f = this.fly!;
    const p = Math.min(1, (now - f.t0) / f.ms), e = easeIO(p);
    this.controls.target.lerpVectors(f.fromT, f.toT, e);
    // se aleja un poco en los viajes largos
    const travel = f.fromT.distanceTo(f.toT);
    const r = f.fromS.radius + (f.toS.radius - f.fromS.radius) * e + Math.sin(Math.PI * e) * Math.min(1.2, travel * 0.8);
    this.sph.set(r, f.fromS.phi + (f.toS.phi - f.fromS.phi) * e, f.fromS.theta + (f.toS.theta - f.fromS.theta) * e);
    this.camera.position.copy(this.controls.target).add(this.v1.setFromSpherical(this.sph));
    if (p >= 1) this.fly = null;
  }

  private moveBy(v: THREE.Vector3) { this.fly = null; this.controls.target.add(v); this.camera.position.add(v); this.wake(); }

  /* ================= entrada ================= */
  private toNdc(cx: number, cy: number) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return this.ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  }

  private pickScreen(cx: number, cy: number, allowOutside = false): Hit | null {
    if (!this.hf) return null;
    this.raycaster.setFromCamera(this.toNdc(cx, cy), this.camera);
    this.inv.copy(this.model.matrixWorld).invert();
    const o = this.v1.copy(this.raycaster.ray.origin).applyMatrix4(this.inv);
    const d = this.v2.copy(this.raycaster.ray.direction).transformDirection(this.inv);
    return this.hf.pick(o.x, o.y, o.z, d.x, d.y, d.z, allowOutside);
  }

  /** Cualquier interacción reactiva la animación ambiental un rato (nubes, agua). */
  private touch() { this.ambientUntil = performance.now() + 10000; }

  private bindInput(canvas: HTMLCanvasElement) {
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, o);
      this.cleanup.push(() => t.removeEventListener(type, fn as EventListener, o));
    };
    const P = this.pointer;
    on(canvas, 'pointermove', e => { P.x = e.clientX; P.y = e.clientY; P.in = true; P.dirty = true; P.type = e.pointerType; this.wake(); });
    on(canvas, 'pointerdown', e => {
      Object.assign(P, { x: e.clientX, y: e.clientY, in: true, dirty: true, type: e.pointerType, down: true });
      this.press = { x: e.clientX, y: e.clientY, t: performance.now() };
      canvas.focus({ preventScroll: true });
      this.touch(); this.wake();
    });
    on(canvas, 'pointerup', e => {
      P.down = false;
      const quick = performance.now() - this.press.t < 350 && Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) < 6;
      if (!quick || e.button !== 0) return;
      const mh = this.mapHit(e.clientX, e.clientY);
      let consumed = false;
      if (mh) for (const fn of [...this.clickHandlers]) if (fn(mh)) { consumed = true; break; }
      if (!consumed && !mh?.point) this.select(mh?.municipio ?? 0);
      if (e.pointerType !== 'mouse') {   // doble toque: volar ahí
        const now = performance.now();
        if (now - this.lastTap < 300) { this.flyToHit(e.clientX, e.clientY); this.lastTap = 0; } else this.lastTap = now;
      }
    });
    on(canvas, 'pointerleave', () => { P.in = false; P.dirty = true; this.wake(); });
    on(canvas, 'dblclick', e => this.flyToHit(e.clientX, e.clientY));

    // rueda: acerca hacia donde apunta el cursor; en modo cooperativo, solo con Ctrl/⌘
    on(canvas, 'wheel', e => {
      const allowed = !this.opts.cooperativeGestures || e.ctrlKey || e.metaKey;
      this.controls.enableZoom = allowed;
      if (!allowed) { this.opts.onGestureHint?.(); return; }
      this.touch();
      if (e.deltaY >= 0) return;
      const hit = this.pickScreen(e.clientX, e.clientY, true);
      if (!hit) return;
      this.fly = null;
      const p = this.worldOf(hit.lon, hit.lat);
      const shift = p.sub(this.controls.target).multiplyScalar(Math.min(0.22, (-e.deltaY / 100) * 0.12));
      this.controls.target.add(shift);
      this.camera.position.add(shift);
    }, { passive: true, capture: true });

    on(canvas, 'keydown', e => {
      const s = this.curSph(), step = s.radius * 0.12;
      const fwd = new THREE.Vector3(-Math.sin(s.theta), 0, -Math.cos(s.theta)), right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      switch (e.key) {
        case 'ArrowUp': this.moveBy(fwd.multiplyScalar(step)); break;
        case 'ArrowDown': this.moveBy(fwd.multiplyScalar(-step)); break;
        case 'ArrowLeft': this.moveBy(right.multiplyScalar(-step)); break;
        case 'ArrowRight': this.moveBy(right.multiplyScalar(step)); break;
        case '+': case '=': this.zoomBy(0.7); break;
        case '-': case '_': this.zoomBy(1.4); break;
        case 'n': case 'N': this.northUp(); break;
        case 't': case 'T': this.topView(); break;
        case 'r': case 'R': this.goHome(); break;
        case 'Escape': this.labels?.setPin(null); this.select(0); break;
        default: return;
      }
      this.controls.autoRotate = false;
      e.preventDefault();
    });

    const mini = this.el.minimap;
    if (mini) {
      let drag = false;
      const go = (e: PointerEvent, smoothly: boolean) => {
        if (!this.mini || !this.hf) return;
        const [lon, lat] = this.mini.toLonLat(e.clientX, e.clientY);
        const p = this.worldOf(lon, lat);
        if (smoothly) this.flyTo(p, { ms: 700 });
        else this.moveBy(p.sub(this.controls.target));
        this.controls.autoRotate = false;
      };
      on(mini, 'pointerdown', e => { drag = true; mini.setPointerCapture(e.pointerId); go(e, true); });
      on(mini, 'pointermove', e => { if (drag && !this.fly) go(e, false); });
      on(mini, 'pointerup', () => { drag = false; });
      on(mini, 'pointercancel', () => { drag = false; });
    }

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.el.stage);
    const io = new IntersectionObserver(([en]) => { this.visible = en.isIntersecting; if (this.visible) this.invalidate(); }, { threshold: 0 });
    io.observe(this.el.root);
    this.cleanup.push(() => ro.disconnect(), () => io.disconnect());
    const lost = (e: Event) => { e.preventDefault(); this.opts.onError?.('Se perdió el contexto gráfico. Recarga la página para volver a ver el relieve.'); };
    canvas.addEventListener('webglcontextlost', lost);
    this.cleanup.push(() => canvas.removeEventListener('webglcontextlost', lost));
  }

  private flyToHit(cx: number, cy: number) {
    const hit = this.pickScreen(cx, cy, true);
    if (hit) this.flyTo(this.worldOf(hit.lon, hit.lat), { dist: Math.max(this.controls.minDistance * 1.6, this.curDist() * 0.45), ms: 900 });
  }

  private resize() {
    const w = this.el.stage.clientWidth, h = this.el.stage.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.overlays?.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = this.camera.aspect < 0.8 ? 46 : 32;
    this.camera.updateProjectionMatrix();
    if (this.camera.aspect < 0.8 && this.frameN === 0) { this.home.pos.set(0.12, 3.3, 4.6); this.camera.position.copy(this.home.pos); }
    this.labelsDirty = true;
    this.lodEx = -1;
    this.invalidate();
  }

  /* ================= hover ================= */
  private nearestPlace(lat: number, lon: number, maxKm: number) {
    const g = this.geo;
    let best: (typeof this.placeItems)[number] | null = null, bd = maxKm * maxKm;
    for (const p of this.placeItems) {
      const dx = (p.lon - lon) * g.KX, dz = (p.lat - lat) * g.KZ, d = dx * dx + dz * dz;
      // ciudades y pueblos cuentan en todo el radio; las localidades de ≥ 500 hab. en el 60 % y las menores en el 40 %
      if (d < bd && (p.kind < 2 || d < (maxKm * (p.kind === 2 ? 0.6 : 0.4)) ** 2)) { bd = d; best = p; }
    }
    return best ? { p: best, km: Math.sqrt(bd) } : null;
  }

  /** Punto del mapa bajo (cx, cy): primero los puntos de los análisis, luego el relieve. */
  private mapHit(cx: number, cy: number): MapHit | null {
    if (!this.hf) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const pt = this.overlays?.pick(this.camera, this.model.matrixWorld, cx - r.left, cy - r.top, r.width, r.height);
    if (pt) {
      const s = pt.layer.spec, lon = s.lon[pt.index], lat = s.lat[pt.index];
      return { lon, lat, elev: this.hf.surfaceLL(lat, lon), municipio: this.hf.muniLL(lat, lon), point: pt };
    }
    const hit = this.pickScreen(cx, cy);
    return hit ? { lon: hit.lon, lat: hit.lat, elev: hit.e, municipio: hit.m } : null;
  }

  private updateHover() {
    const P = this.pointer, tu = this.tu!;
    const mh = P.in && !(P.down && P.type !== 'mouse') ? this.mapHit(P.x, P.y) : null;
    const { tag, tagName, tagAlt, tagNear, tagInfo, root } = this.el;
    const canvas = this.renderer.domElement;
    if (!mh || (!mh.municipio && !mh.point)) {
      if (tu.uHover.value) this.renderDirty = true;
      tu.uHover.value = 0; tag.style.opacity = '0'; this.probe.visible = false; canvas.style.cursor = '';
      return;
    }
    const extra: string[] = [];
    const tip = mh.point && mh.point.layer.spec.tooltip?.(mh.point.index);
    canvas.style.cursor = mh.point ? 'pointer' : '';
    if (tip) {
      tu.uHover.value = 0;
      tagName.textContent = tip.title;
      tagAlt.textContent = tip.lines?.[0] ?? '';
      tagNear.textContent = tip.lines?.slice(1).join(' · ') ?? '';
    } else {
      tu.uHover.value = mh.municipio;
      tagName.textContent = meta.names[mh.municipio - 1];
      tagAlt.textContent = `${fmt(mh.elev)} m s. n. m.`;
      const nr = this.nearestPlace(mh.lat, mh.lon, 4);
      tagNear.textContent = nr ? (nr.km < 0.6 ? nr.p.t : `a ${nr.km.toFixed(1)} km de ${nr.p.t}`) : `${mh.lat.toFixed(3)}° N  ${Math.abs(mh.lon).toFixed(3)}° O`;
      const land = this.base.map?.describe?.(this.geo.colOf(mh.lon), this.geo.rowOf(mh.lat));
      if (land) extra.push(land);
    }
    for (const fn of this.hoverProviders) { const lines = fn(mh); if (lines) extra.push(...lines); }
    if (tagInfo) { tagInfo.textContent = extra.join('\n'); tagInfo.hidden = !extra.length; }
    const hit = { lon: mh.lon, lat: mh.lat };
    const rr = root.getBoundingClientRect(), tw = tag.offsetWidth, th = tag.offsetHeight;
    let x = P.x - rr.left + 18, y = P.y - rr.top + 18;
    if (x + tw > rr.width - 12) x = P.x - rr.left - tw - 18;
    if (y + th > rr.height - 12) y = P.y - rr.top - th - 18;
    tag.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    tag.style.opacity = '1';
    const p = this.worldOf(hit.lon, hit.lat);
    const pos = this.probe.geometry.attributes.position as THREE.BufferAttribute;
    pos.setXYZ(0, p.x, p.y, p.z);
    pos.setXYZ(1, p.x, p.y + 0.06 + this.curDist() * 0.05, p.z);
    pos.needsUpdate = true;
    this.probe.geometry.computeBoundingSphere();
    this.probe.visible = true;
    this.renderDirty = true;
  }

  /* ================= minimapa ================= */
  private footprint(nx: number, ny: number): [number, number] {
    this.raycaster.setFromCamera(this.ndc.set(nx, ny), this.camera);
    this.groundPlane.constant = -this.controls.target.y;
    let hit: THREE.Vector3 | null = this.raycaster.ray.intersectPlane(this.groundPlane, this.v2);
    if (!hit || hit.distanceTo(this.camera.position) > 8) {
      const dir = this.raycaster.ray.direction.clone();
      dir.y = Math.min(dir.y, -0.02);
      hit = this.camera.position.clone().add(dir.normalize().multiplyScalar(8 / Math.max(0.2, Math.abs(dir.y) * 4)));
    }
    const l = hit.clone().applyMatrix4(this.inv.copy(this.model.matrixWorld).invert());
    return [this.geo.lonOfX(l.x), this.geo.latOfZ(l.z)];
  }

  private drawMini() {
    const g = this.geo, hf = this.hf!;
    const tl = this.controls.target.clone().applyMatrix4(this.inv.copy(this.model.matrixWorld).invert());
    const lat = g.latOfZ(tl.z), lon = g.lonOfX(tl.x);
    const pin = this.labels?.pinPoint;
    this.mini?.draw({
      footprint: ([[-1, -1], [-1, 1], [1, 1], [1, -1]] as const).map(([x, y]) => this.footprint(x, y)),
      target: [lon, lat],
      pin: pin ? [g.lonOfX(pin.x), g.latOfZ(pin.z)] : null,
    }, ACCENT);
    const m = hf.muniLL(lat, lon);
    if (this.el.where) this.el.where.textContent = m ? meta.names[m - 1] : 'Fuera de Hidalgo';
    if (this.el.whereAlt) this.el.whereAlt.textContent = m ? `${fmt(hf.surfaceLL(lat, lon))} m` : '';
  }

  /* ================= bucle ================= */

  /** Pide un cuadro nuevo (cambió algo que no mueve la cámara). */
  invalidate() { this.renderDirty = true; this.wake(); }

  private wake() {
    if (this.running || this.disposed || !this.ready || !this.visible) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.disposed || !this.visible) { this.running = false; return; }
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.frameN++;
    const c = this.controls, cam = this.camera, model = this.model, hf = this.hf!, g = this.geo;
    let active = false;

    // aparición y exageración vertical
    const intro = this.reduceMotion ? 1 : Math.min(1, (now - this.t0) / 2600);
    const prevEx = this.ex;
    if (intro < 1) this.ex = 0.02 + (this.exTarget - 0.02) * (1 - Math.pow(1 - intro, 3));
    else if (Math.abs(this.exTarget - this.ex) > 1e-3) this.ex += (this.exTarget - this.ex) * (1 - Math.exp(-dt * 5));
    else this.ex = this.exTarget;
    if (this.ex !== prevEx) {
      model.scale.set(UNIT, UNIT * this.ex, UNIT);
      this.ground.position.y = BASE_KM * UNIT * this.ex - 0.002;
      model.updateMatrixWorld();
      this.shadowDirty = this.labelsDirty = true;
      active = true;
    }
    if (this.baseAnim && this.tu) {
      const a = this.baseAnim, p = Math.min(1, (now - a.t0) / 450);
      this.tu.uBaseTex.value = a.from + (a.to - a.from) * easeIO(p);
      if (p >= 1) { this.baseAnim = null; a.then?.(); }
      active = true;
    }
    if (this.detailAnim !== null && this.tu) {
      const p = Math.min(1, (now - this.detailAnim) / 700);
      this.tu.uDetail.value = this.hu.uH1On.value = easeIO(p);
      if (p >= 1) this.detailAnim = null;
      active = true;
    }
    if (this.fly) { this.stepFly(now); active = true; }

    // el objetivo no sale del estado y va montado sobre el relieve
    const before = this.v2.copy(c.target);
    c.target.x = clamp(c.target.x, g.xMin * UNIT, g.xMax * UNIT);
    c.target.z = clamp(c.target.z, g.zMin * UNIT, g.zMax * UNIT);
    const tlat = g.latOfZ(c.target.z / UNIT), tlon = g.lonOfX(c.target.x / UNIT);
    const surf = ((hf.muniLL(tlat, tlon) ? hf.surfaceLL(tlat, tlon) : 1500) / 1000) * UNIT * this.ex;
    const dy = (surf - c.target.y) * (this.fly ? 1 : 1 - Math.exp(-dt * 4));
    if (Math.abs(dy) > 1e-6) { c.target.y += dy; active = true; }
    cam.position.add(this.v1.copy(c.target).sub(before));
    if (c.update(dt)) active = true;
    if (c.autoRotate) active = true;

    // la cámara no se mete bajo el relieve al acercarse
    const cl = this.v1.copy(cam.position).applyMatrix4(this.inv.copy(model.matrixWorld).invert());
    const gr = g.rowOf(g.latOfZ(cl.z)), gc = g.colOf(g.lonOfX(cl.x));
    if (gr > 0 && gc > 0 && gr < meta.H - 1 && gc < meta.W - 1) {
      const floor = hf.surfaceAt(gr, gc) / 1000 + 0.35;
      if (cl.y < floor) { cl.y = floor; cam.position.copy(cl.applyMatrix4(model.matrixWorld)); }
    }

    cam.updateMatrixWorld();
    const moved = !this.lastCam.equals(cam.matrixWorld);
    if (moved) { this.lastCam.copy(cam.matrixWorld); this.labelsDirty = this.miniDirty = true; this.lastMove = now; }
    // parches del relieve para esta cámara
    if (moved || this.lodEx !== this.ex) this.updateLod();
    // teselas de detalle: cada ~150 ms mientras se mueve y una vez al detenerse
    if (this.tileDirty && (now - this.lastTiles > 150 || !(active || moved))) {
      this.updateTiles(now);
      this.tileDirty = false;
      this.lastTiles = now;
    }
    if (this.demTiles?.animate(now)) { this.renderDirty = true; this.lodEx = -1; }
    if (this.satTiles?.animate(now)) this.renderDirty = true;
    if (this.tu) this.tu.uCurtain.value = this.cmp ? this.cmp.curtain.position * this.renderer.domElement.width : -1;

    const P = this.pointer;
    if (P.dirty || (moved && P.in && this.frameN % 3 === 0)) { this.updateHover(); P.dirty = false; }

    // nubes y agua se animan mientras hay actividad reciente; luego se quedan quietas y no gastan GPU
    const ambient = this.shared.uClouds.value > 0 && !this.reduceMotion && (now < this.ambientUntil || c.autoRotate);
    if (ambient) this.shared.uTime.value += dt;
    const dist = this.curDist();
    this.shared.uHazeRef.value = dist;
    // la sombra del bloque sobre el suelo se desvanece de cerca (cada texel de la sombra mide ~70 m)
    (this.ground.material as THREE.ShadowMaterial).opacity = 0.38 * smooth(0.12, 0.35, dist);

    if (this.labelsDirty && this.labels && (this.frameN % 2 === 0 || !active) && intro > 0.85) {
      this.labels.layout(cam, model.matrixWorld, dist, this.layers, this.el.stage.clientWidth, this.el.stage.clientHeight);
      this.labelsDirty = false;
    }
    if (this.miniDirty && (this.frameN % 3 === 0 || !(active || moved))) {
      this.drawMini();
      this.miniDirty = false;
      if (this.el.needle) this.el.needle.style.transform = `rotate(${((this.curSph().theta * 180) / Math.PI).toFixed(1)}deg)`;
      if (this.el.zoomRead) this.el.zoomRead.textContent = `Vista ≈ ${fmt((dist / UNIT) * 2 * Math.tan((cam.fov * Math.PI) / 360) * Math.min(1, cam.aspect))} km`;
    }

    // resolución adaptable: si al moverse no alcanza ~40 cps, baja la densidad de píxeles; en reposo la recupera
    const moving = active || moved;
    if (moving) {
      this.frameEma = this.frameEma * 0.9 + dt * 1000 * 0.1;
      if (++this.moveFrames > 20 && this.frameEma > 26 && this.dpr > 0.75) {
        this.dpr = Math.max(0.75, this.dpr * 0.8);
        this.renderer.setPixelRatio(this.dpr);
        this.frameEma = 16; this.moveFrames = 0;
      }
    } else if (this.dpr < this.fullDpr && now - this.lastMove > 250) {
      this.dpr = this.fullDpr;
      this.renderer.setPixelRatio(this.dpr);
      this.renderDirty = true;
      this.moveFrames = 0;
    }

    if (moving || this.renderDirty || (ambient && this.frameN % 2 === 0)) {
      if (this.shadowDirty) { this.renderer.shadowMap.needsUpdate = true; this.shadowDirty = false; }
      const tr = this.timings.firstFrame === undefined ? performance.now() : 0;
      this.renderer.render(this.scene, cam);
      if (tr) this.timings.firstFrame = Math.round(performance.now() - tr);
      this.renderDirty = false;
    }

    const keep = moving || ambient || this.renderDirty || this.labelsDirty || this.miniDirty || P.dirty || this.dpr < this.fullDpr || this.tileDirty;
    if (keep) this.raf = requestAnimationFrame(this.frame);
    else this.running = false;
  };
}

