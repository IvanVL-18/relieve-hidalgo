import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import metaJson from '../data/meta.json';
import { BASE_KM, makeGeo, type Geo } from '../shared/geo';
import type { BuildRequest, BuildResult, Meta, MuniStats, WorkerMessage } from '../shared/types';
import { Heightfield, type Hit } from './heightfield';
import { Labels } from './labels';
import {
  createNightPointsMaterial, createTerrainMaterial, createWallMaterial,
  makeSharedUniforms, makeTerrainUniforms, type SharedUniforms, type TerrainUniforms,
} from './materials';
import { BASE_MAPS, loadBaseMap, type BaseMapId, type LoadedBaseMap } from './basemaps';
import type { GridImage, MapApi, MapHit } from './mapApi';
import { Minimap } from './minimap';
import { Overlays, type LinesHandle, type PointsHandle } from './overlays';
import { buildIndex, prettyRiver, search, type SearchItem } from './search';
import { mexicoDate, sunPosition, sunTimes, todayInMexico } from './sun';

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
  areaKm2: number;
  /** localidades del catálogo del visor dentro del municipio */
  places: number;
}

export interface ReadyInfo {
  minElev: number;
  maxElev: number;
  sunrise: number;
  sunset: number;
  timings: Record<string, number>;
}

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
  /** carpeta con elev.bin, muni.bin y vec.bin si se sirven desde otro lugar (CDN, Laravel /public…) */
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
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeIO = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const fmt = (n: number) => Math.round(n).toLocaleString('es-MX').replace(/,/g, ' ');

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
  private reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.005, 60);
  private model = new THREE.Group();
  private controls: OrbitControls;
  private shared: SharedUniforms = makeSharedUniforms();
  private tu: TerrainUniforms | null = null;
  private hemi = new THREE.HemisphereLight(0xc4d6f2, 0x3b3026, 1.7);
  private sun = new THREE.DirectionalLight(0xfff0d8, 7);
  private moon = new THREE.DirectionalLight(0x9db4ff, 0);
  private ground: THREE.Mesh;
  private probe: THREE.Line;
  private disposables: { dispose(): void }[] = [];

  private hf: Heightfield | null = null;
  private stats: MuniStats | null = null;
  private labels: Labels | null = null;
  private mini: Minimap | null = null;
  private placeItems: { t: string; lon: number; lat: number; kind: number }[] = [];
  private placesPerMuni = new Uint16Array(85);
  private overlays: Overlays | null = null;
  private baseMaps = new Map<BaseMapId, Promise<LoadedBaseMap>>();
  private base: { id: BaseMapId; map: LoadedBaseMap | null } = { id: 'altitud', map: null };
  private baseAnim: { from: number; to: number; t0: number; then?: () => void } | null = null;
  private baseReq = 0;
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
  private sph = new THREE.Spherical();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(private el: EngineElements, private opts: EngineOptions) {
    const q = opts.quality ?? 'auto';
    this.small = q === 'low' || (q === 'auto' && Math.min(screen.width, screen.height) < 640);
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
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;   // el relieve no se mueve: la sombra se recalcula solo si cambia el Sol o la exageración
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
    c.minDistance = 0.12; c.maxDistance = 6.5;
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

    this.bindInput(canvas);
    this.resize();
    this.placeSun();
    this.load().catch(e => this.fail(e));
  }

  /* ================= carga ================= */
  private dataUrls() {
    const base = this.opts.dataBaseUrl;
    if (base) {
      const b = new URL(base.replace(/\/?$/, '/'), location.href);
      return { elev: new URL('elev.bin', b).href, muni: new URL('muni.bin', b).href, vec: new URL('vec.bin', b).href };
    }
    return {
      elev: new URL('../data/elev.bin', import.meta.url).href,
      muni: new URL('../data/muni.bin', import.meta.url).href,
      vec: new URL('../data/vec.bin', import.meta.url).href,
    };
  }

  private async load() {
    if (typeof DecompressionStream === 'undefined' || typeof OffscreenCanvas === 'undefined') {
      throw new Error('Este navegador no puede abrir los datos del relieve. Actualízalo para verlo.');
    }
    const worker = (this.worker = new Worker(new URL('../worker/build.worker.ts', import.meta.url), { type: 'module' }));
    const req: BuildRequest = {
      urls: this.dataUrls(),
      grid: { W: meta.W, H: meta.H, step: meta.step, lon0: meta.lon0, lat0: meta.lat0 },
      places: meta.places,
      quality: { decimate: this.small ? 2 : 1, tex: this.small ? 2048 : 4096, dotStep: this.small ? 4 : 3, mini: { w: 380, h: 364 } },
    };
    const res = await new Promise<BuildResult>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
        const m = ev.data;
        if (m.type === 'progress') this.opts.onProgress?.(m.stage);
        else if (m.type === 'error') reject(new Error(m.message));
        else resolve(m);
      };
      worker.onerror = ev => reject(new Error(ev.message || 'Falló el procesamiento del relieve'));
      worker.postMessage(req);
    });
    worker.terminate();
    this.worker = null;
    if (this.disposed) { res.mini.close(); return; }
    this.opts.onProgress?.('gpu');
    let t = performance.now();
    this.setup(res);
    res.timings.setup = Math.round(performance.now() - t);
    // ceder el hilo entre preparar la escena y compilar: dos tareas cortas en vez de una larga
    await new Promise(r => setTimeout(r, 0));
    if (this.disposed) return;
    t = performance.now();
    // compilar los shaders antes del primer cuadro evita un tirón al aparecer
    await this.renderer.compileAsync(this.scene, this.camera).catch(() => undefined);
    if (this.disposed) return;
    res.timings.compile = Math.round(performance.now() - t);
    this.timings = res.timings;
    this.ready = true;
    const { sunrise, sunset } = sunTimes(this.ymd, this.geo.latC, this.geo.lonC);
    this.t0 = this.last = performance.now();
    this.wake();
    this.opts.onReady?.({ minElev: res.minE, maxElev: res.maxE, sunrise, sunset, timings: res.timings });
  }

  private fail(e: unknown) {
    if (this.disposed) return;
    this.opts.onError?.(e instanceof Error ? e.message : String(e));
  }

  private setup(res: BuildResult) {
    const g = this.geo;
    const hf = (this.hf = new Heightfield(g, res.elev, res.muni, meta.W, meta.H));
    this.stats = res.muniStats;

    // texturas
    const water = new THREE.DataTexture(res.water.data, res.water.size, res.water.size, THREE.RGFormat, THREE.UnsignedByteType);
    water.minFilter = THREE.LinearMipmapLinearFilter;
    water.magFilter = THREE.LinearFilter;
    water.generateMipmaps = true;
    water.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    water.needsUpdate = true;
    // ya en la GPU no hace falta la copia de 16–32 MB
    water.onUpdate = () => { (water.image as { data: Uint8Array | null }).data = null; };
    // municipio por celda (el mismo arreglo que usa la selección con el puntero); se lee con texelFetch
    const muniTex = new THREE.DataTexture(res.muni, meta.W, meta.H, THREE.RedFormat, THREE.UnsignedByteType);
    muniTex.minFilter = muniTex.magFilter = THREE.NearestFilter;
    muniTex.unpackAlignment = 1;
    muniTex.needsUpdate = true;
    const choro = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat);
    choro.colorSpace = THREE.SRGBColorSpace;
    choro.needsUpdate = true;
    const bounds = new THREE.Vector4(g.xMin, g.zMin, g.xMax - g.xMin, g.zMax - g.zMin);
    const tu = (this.tu = makeTerrainUniforms(this.shared, water, muniTex, choro, bounds));

    // relieve
    const t = res.terrain, tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(t.position, 3));
    tg.setAttribute('normal', new THREE.BufferAttribute(t.normal, 3, true));
    tg.setAttribute('aAlt', new THREE.BufferAttribute(t.alt, 4, true));
    tg.setAttribute('aGlow', new THREE.BufferAttribute(t.glow, 1, true));
    tg.setIndex(new THREE.BufferAttribute(t.index, 1));
    tg.computeBoundingSphere();
    const terrainMat = createTerrainMaterial(tu);
    const terrain = new THREE.Mesh(tg, terrainMat);
    terrain.castShadow = terrain.receiveShadow = true;
    this.model.add(terrain);

    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(res.walls.position, 3));
    wg.setAttribute('normal', new THREE.BufferAttribute(res.walls.normal, 3));
    wg.setAttribute('aTop', new THREE.BufferAttribute(res.walls.top, 1));
    wg.computeBoundingSphere();
    const wallMat = createWallMaterial(this.shared);
    const walls = new THREE.Mesh(wg, wallMat);
    walls.castShadow = walls.receiveShadow = true;
    this.model.add(walls);

    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(res.dots.position, 3));
    dg.setAttribute('color', new THREE.BufferAttribute(res.dots.color, 3));
    const dotMat = new THREE.PointsMaterial({ size: this.small ? 1.4 : 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.2, depthWrite: false });
    this.model.add(new THREE.Points(dg, dotMat));

    // luces de las localidades
    const np: number[] = [], ns: number[] = [];
    for (const [, kind, lon, lat, , pop] of meta.places) {
      np.push(g.toX(lon), hf.elevLL(lat, lon) / 1000 + 0.004, g.toZ(lat));
      ns.push(kind === 0 ? 22 + Math.sqrt((pop || 45000) / 300000) * 26 : kind === 1 ? 12 + Math.sqrt((pop || 4000) / 40000) * 6 : 7);
    }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.Float32BufferAttribute(np, 3));
    ng.setAttribute('aSize', new THREE.Float32BufferAttribute(ns, 1));
    const nightMat = createNightPointsMaterial(this.shared, this.fullDpr);
    const night = new THREE.Points(ng, nightMat);
    night.frustumCulled = false;
    night.renderOrder = 2;
    this.model.add(night);

    this.disposables.push(water, muniTex, choro, tg, terrainMat, wg, wallMat, dg, dotMat, ng, nightMat);
    this.applyLayers();

    // etiquetas
    const labels = (this.labels = new Labels(this.el.labels, hf));
    const pr = Math.floor(res.maxI / meta.W), pc = res.maxI % meta.W;
    labels.add({ t: 'Punto más alto', s: `${fmt(res.maxE)} m`, lat: g.latOfRow(pr), lon: g.lonOfCol(pc), k: 'peak', pri: 1 });
    for (const [t, lat, lon] of [['Huasteca', 21.08, -98.45], ['Sierra Gorda', 21.02, -99.35], ['Valle del Mezquital', 20.38, -99.18],
      ['Sierra Alta', 20.75, -98.6], ['Altiplano', 19.82, -98.5], ['Sierra Otomí-Tepehua', 20.42, -98.2], ['Comarca Minera', 20.2, -98.68]] as const) {
      labels.add({ t, lat, lon, k: 'region', pri: 2, lift: 0.35 });
    }
    for (const [n, kind, lon, lat, m, pop] of meta.places) {
      const isCap = n === 'Pachuca';
      labels.add({ t: n, s: isCap ? 'capital' : undefined, lat, lon, k: kind === 0 ? 'city' : kind === 1 ? 'town' : 'village', pri: kind === 0 ? 0 : kind === 1 ? 3 : 6, pop });
      this.placeItems.push({ t: n, lon, lat, kind });
      this.placesPerMuni[m]++;
    }
    for (const r of meta.riverLabels) labels.add({ t: prettyRiver(r.n), lat: r.lat, lon: r.lon, k: 'river', pri: 4, lift: 0.03 });
    for (const l of meta.lakeLabels) labels.add({ t: l.n, lat: l.lat, lon: l.lon, k: 'lake', pri: 4, lift: 0.03 });
    labels.sort();

    if (this.el.minimap) {
      this.mini = new Minimap(this.el.minimap, hf, res.mini,
        this.placeItems.filter(p => p.kind === 0), ACCENT, () => { this.miniDirty = true; this.wake(); });
    } else res.mini.close();

    this.overlays = new Overlays(this.model, hf, this.fullDpr, () => this.invalidate());
    this.overlays.resolution.set(this.el.stage.clientWidth || 1, this.el.stage.clientHeight || 1);
    this.model.scale.set(UNIT, UNIT * this.ex, UNIT);
    this.model.updateMatrixWorld();
    this.setBaseMap(this.opts.baseMap);
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

  /** Cambia el mapa base con un fundido; las texturas se cargan la primera vez que se piden. */
  setBaseMap(id: BaseMapId): Promise<void> {
    const tu = this.tu;
    if (!tu) return Promise.resolve();
    const req = ++this.baseReq;
    const fadeTo = (to: number, then?: () => void) => {
      this.baseAnim = { from: tu.uBaseTex.value, to, t0: performance.now(), then };
      this.wake();
    };
    if (id === 'altitud') { fadeTo(0, () => { this.base = { id, map: null }; }); return Promise.resolve(); }
    let p = this.baseMaps.get(id);
    if (!p) {
      const small = this.small;
      p = loadBaseMap(id, {
        usvBin: this.dataUrl('capas/usv.bin', new URL('../data/capas/usv.bin', import.meta.url).href),
        usvJson: this.dataUrl('capas/usv.json', new URL('../data/capas/usv.json', import.meta.url).href),
        sat: small
          ? this.dataUrl('capas/satelite-2048.webp', new URL('../data/capas/satelite-2048.webp', import.meta.url).href)
          : this.dataUrl('capas/satelite-4096.webp', new URL('../data/capas/satelite-4096.webp', import.meta.url).href),
      }, this.renderer.capabilities.getMaxAnisotropy());
      this.baseMaps.set(id, p);
      p.then(b => this.disposables.push(b.texture), () => this.baseMaps.delete(id));
    }
    return p.then(map => {
      if (req !== this.baseReq || this.disposed) return;
      const swap = () => { tu.tBase.value = map.texture; this.base = { id, map }; fadeTo(1); };
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

  /** Vuela a un resultado del buscador, lo marca y selecciona su municipio. */
  flyToItem(r: SearchItem) {
    if (!this.hf) return;
    const dist = r.kind === 'Municipio' ? clamp(Math.sqrt(r.area ?? 1000) * 0.012, 0.35, 1.6) : r.rank >= 3 ? 0.32 : 0.55;
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
    const s = this.stats!;
    return {
      id: m, code: meta.codes[m - 1], name: meta.names[m - 1],
      minElev: s.min[m], maxElev: s.max[m], meanElev: s.mean[m],
      areaKm2: s.cells[m] * this.geo.cellKm2, places: this.placesPerMuni[m],
    };
  }

  /**
   * Colorea municipios con datos propios (p. ej. un indicador del laboratorio).
   * colors: clave INEGI («13048») o id (1–84) → color CSS. null quita la capa.
   */
  setMunicipioColors(colors: Record<string | number, string> | null, strength = 0.85) {
    if (!this.tu) return;
    const tex = this.tu.tChoro.value as THREE.DataTexture, data = tex.image.data as Uint8Array;
    data.fill(0);
    if (colors) {
      const c = new THREE.Color();
      for (const [k, css] of Object.entries(colors)) {
        const m = /^\d{5}$/.test(k) ? meta.codes.indexOf(k) + 1 : Number(k);
        if (!(m >= 1 && m <= 84)) continue;
        c.setStyle(css, THREE.SRGBColorSpace);
        const srgb = c.clone().convertLinearToSRGB();
        data.set([srgb.r * 255, srgb.g * 255, srgb.b * 255, 255], m * 4);
      }
    }
    tex.needsUpdate = true;
    this.tu.uChoroAmt.value = colors ? strength : 0;
    this.invalidate();
  }

  /** Capa de colores sobre el terreno, alineada a la rejilla. null la quita. */
  setOverlay(img: GridImage | null, opacity = 0.85) {
    const tu = this.tu;
    if (!tu) return;
    const old = tu.tOverlay.value;
    if (img) {
      const tex = new THREE.DataTexture(img.rgba, img.width, img.height, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      tu.tOverlay.value = tex;
      tu.uOverlaySize.value.set(img.width, img.height);
    }
    tu.uOverlay.value = img ? opacity : 0;
    if (img && old !== tu.tOverlay.value) old.dispose();
    this.invalidate();
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
    const handles = new Set<PointsHandle | LinesHandle>(), offs: (() => void)[] = [];
    let fill = false, overlay = false, pin = false, alive = true;
    const track = <T extends PointsHandle | LinesHandle>(h: T): T => {
      handles.add(h);
      const d = h.dispose.bind(h);
      h.dispose = () => { handles.delete(h); d(); };
      return h;
    };
    const hook = <T>(list: T[], fn: T) => { list.push(fn); const off = () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; offs.push(off); return off; };
    const ov = () => { if (!this.overlays) throw new Error('El relieve aún no está listo'); return this.overlays; };
    return {
      meta,
      elevationAt: (lon, lat) => this.hf?.elevLL(lat, lon) ?? 0,
      municipioAt: (lon, lat) => this.hf?.muniLL(lat, lon) ?? 0,
      setMunicipioFill: (c, strength) => { fill = !!c; this.setMunicipioColors(c, strength); },
      setOverlay: (img, opacity) => { overlay = !!img; this.setOverlay(img, opacity); },
      addPoints: spec => track(ov().addPoints(spec)),
      addLines: spec => track(ov().addLines(spec)),
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
    ctx.fillText(`Elevación: SRTM (AWS Terrain Tiles) · Agua: © OpenStreetMap · Límites: INEGI 2022 · Exageración vertical ${this.exTarget.toFixed(1)}×`, 20 * k, h - 18 * k);
    return new Promise((resolve, reject) => out.toBlob(b => (b ? resolve(b) : reject(new Error('No se pudo generar la imagen'))), 'image/png'));
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.worker?.terminate();
    for (const f of this.cleanup) f();
    this.controls.dispose();
    this.overlays?.dispose();
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
    return new THREE.Vector3(this.geo.toX(lon), this.hf!.elevLL(lat, lon) / 1000 + liftKm, this.geo.toZ(lat)).applyMatrix4(this.model.matrixWorld);
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
    this.invalidate();
  }

  /* ================= hover ================= */
  private nearestPlace(lat: number, lon: number, maxKm: number) {
    const g = this.geo;
    let best: (typeof this.placeItems)[number] | null = null, bd = maxKm * maxKm;
    for (const p of this.placeItems) {
      const dx = (p.lon - lon) * g.KX, dz = (p.lat - lat) * g.KZ, d = dx * dx + dz * dz;
      if (d < bd && (p.kind < 2 || d < (maxKm * 0.6) ** 2)) { bd = d; best = p; }
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
      return { lon, lat, elev: this.hf.elevLL(lat, lon), municipio: this.hf.muniLL(lat, lon), point: pt };
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
    if (this.el.whereAlt) this.el.whereAlt.textContent = m ? `${fmt(hf.elevLL(lat, lon))} m` : '';
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
    if (this.fly) { this.stepFly(now); active = true; }

    // el objetivo no sale del estado y va montado sobre el relieve
    const before = this.v2.copy(c.target);
    c.target.x = clamp(c.target.x, g.xMin * UNIT, g.xMax * UNIT);
    c.target.z = clamp(c.target.z, g.zMin * UNIT, g.zMax * UNIT);
    const tlat = g.latOfZ(c.target.z / UNIT), tlon = g.lonOfX(c.target.x / UNIT);
    const surf = ((hf.muniLL(tlat, tlon) ? hf.elevLL(tlat, tlon) : 1500) / 1000) * UNIT * this.ex;
    const dy = (surf - c.target.y) * (this.fly ? 1 : 1 - Math.exp(-dt * 4));
    if (Math.abs(dy) > 1e-6) { c.target.y += dy; active = true; }
    cam.position.add(this.v1.copy(c.target).sub(before));
    if (c.update(dt)) active = true;
    if (c.autoRotate) active = true;

    // la cámara no se mete bajo el relieve al acercarse
    const cl = this.v1.copy(cam.position).applyMatrix4(this.inv.copy(model.matrixWorld).invert());
    const gr = g.rowOf(g.latOfZ(cl.z)), gc = g.colOf(g.lonOfX(cl.x));
    if (gr > 0 && gc > 0 && gr < meta.H - 1 && gc < meta.W - 1) {
      const floor = hf.elevAt(gr, gc) / 1000 + 0.35;
      if (cl.y < floor) { cl.y = floor; cam.position.copy(cl.applyMatrix4(model.matrixWorld)); }
    }

    cam.updateMatrixWorld();
    const moved = !this.lastCam.equals(cam.matrixWorld);
    if (moved) { this.lastCam.copy(cam.matrixWorld); this.labelsDirty = this.miniDirty = true; this.lastMove = now; }

    const P = this.pointer;
    if (P.dirty || (moved && P.in && this.frameN % 3 === 0)) { this.updateHover(); P.dirty = false; }

    // nubes y agua se animan mientras hay actividad reciente; luego se quedan quietas y no gastan GPU
    const ambient = this.shared.uClouds.value > 0 && !this.reduceMotion && (now < this.ambientUntil || c.autoRotate);
    if (ambient) this.shared.uTime.value += dt;
    const dist = this.curDist();
    this.shared.uHazeRef.value = dist;

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

    const keep = moving || ambient || this.renderDirty || this.labelsDirty || this.miniDirty || P.dirty || this.dpr < this.fullDpr;
    if (keep) this.raf = requestAnimationFrame(this.frame);
    else this.running = false;
  };
}
