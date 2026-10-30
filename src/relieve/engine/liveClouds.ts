import { dayYmd, elevForBox, liveBox, liveDayStart, mxHour, type LiveBox, type LiveCloudsStatus } from '../shared/goes';
import type { GoesRequest, GoesResult } from '../worker/goes.worker';

const MIN = 60e3, HOUR = 3600e3;

export interface LiveFrame {
  time: number;
  /** RGBA8 (cobertura, cima / 16 km, densidad, convección) de box.w × box.h, de norte a sur */
  data: Uint8Array;
  /** núcleos de tormenta: [columna, renglón, cima km] */
  cores: number[];
  maxTop: number;
  slope: number;
  /** cobertura media (0–1) */
  cover: number;
}

/** Rejilla del visor (para el recuadro de las imágenes y la altitud del terreno bajo cada píxel). */
export interface LiveGeo { lon0: number; lat0: number; step: number; W: number; H: number; elev: Float32Array; KX: number; KZ: number }

/** Par de imágenes alrededor de un instante, con la mezcla y el movimiento entre ellas (px) y desde la primera (px). */
export interface LivePair { a: LiveFrame; b: LiveFrame; mix: number; shift: [number, number]; drift: [number, number] }

/**
 * Nubes de hoy: pide al worker las imágenes de GOES del día (5:00 a 20:40 cada 20 min y la última), las guarda y
 * responde qué par corresponde a cada hora. Las del día se bajan solo cuando hacen falta (want): al entrar, solo la última.
 * Con otro día del archivo (archive), primero la de la hora que se ve y sin buscar nuevas.
 */
export class LiveClouds {
  readonly box: LiveBox;
  readonly dayStart: number;
  /** otro día (no hoy) */
  readonly archive: boolean;
  /** horas del día con imagen (o por bajar) */
  times: number[] = [];
  readonly frames = new Map<number, LiveFrame>();
  status: LiveCloudsStatus = { state: 'loading', loaded: 0, total: 0 };
  private shifts = new Map<string, [number, number]>();
  /** velocidad de las nubes (px del visible por minuto), mediana de las medidas */
  private vel: [number, number] = [0, 0];
  private worker: Worker | null = null;
  private timer = 0;
  /** se pidieron las del día; instante alrededor del cual bajarlas */
  private asked = false;
  private focus = 0;

  /** km por píxel del visible (este, sur) */
  readonly kmPx: [number, number];

  /** day = medianoche de otro día (dayStartOf) y hour = la hora que se ve, para bajar primero esa imagen */
  constructor(base: string, geo: LiveGeo, private onChange: (frame: boolean) => void, day?: { start: number; hour: number }) {
    const east = geo.lon0 + (geo.W - 1) * geo.step, south = geo.lat0 - (geo.H - 1) * geo.step;
    // el rectángulo del mapa y un margen pequeño (fuera de la rejilla no se conoce la altitud del terreno)
    this.box = liveBox(geo.lon0 - 0.02, south - 0.02, east + 0.02, geo.lat0 + 0.02);
    const today = liveDayStart(Date.now());
    this.archive = !!day && day.start < today;
    this.dayStart = this.archive ? day!.start : today;
    this.kmPx = [((this.box.east - this.box.west) / this.box.w) * geo.KX, ((this.box.north - this.box.south) / this.box.h) * geo.KZ];
    try {
      const w = (this.worker = new Worker(new URL('../worker/goes.worker.ts', import.meta.url), { type: 'module' }));
      w.onmessage = (ev: MessageEvent<GoesResult>) => this.receive(ev.data);
      w.onerror = () => this.fail('no arrancó el proceso que lee las imágenes');
      const elev = elevForBox(geo.elev, geo.W, geo.H, geo.lon0, geo.lat0, geo.step, this.box);
      this.send({ type: 'init', base, box: this.box, elev }, [elev.buffer]);
      if (this.archive) {
        // otro día: hasta las 20:45 (la última del deslizador), primero la imagen de la hora que se ve
        this.send({ type: 'start', dayStart: this.dayStart, now: this.dayStart + 20.75 * HOUR, focus: this.dayStart + day!.hour * HOUR });
        return;
      }
      this.send({ type: 'start', dayStart: this.dayStart, now: Date.now() });
      // imágenes nuevas cada 5 min mientras la página se ve
      this.timer = window.setInterval(() => { if (document.visibilityState === 'visible') this.send({ type: 'refresh', now: Date.now() }); }, 5 * 60e3);
    } catch {
      this.fail('este navegador no puede leer las imágenes del satélite');
    }
  }

  /** fecha del día que se muestra (para la posición del Sol) */
  get ymd() { return dayYmd(this.dayStart); }

  private send(m: GoesRequest, t?: Transferable[]) { this.worker?.postMessage(m, t ?? []); }
  private fail(message: string) {
    this.status = { ...this.status, state: 'error', message };
    this.onChange(false);
  }

  private receive(m: GoesResult) {
    if (m.type === 'list') {
      this.times = m.times;
      if (this.asked) this.want(this.focus);
    } else if (m.type === 'frame') {
      let s = 0;
      for (let i = 0; i < m.data.length; i += 4) s += m.data[i];
      this.frames.set(m.time, { time: m.time, data: m.data, cores: m.cores, maxTop: m.maxTop, slope: m.slope, cover: s / 255 / (m.data.length / 4) });
      this.status.state = 'ready';
      this.status.message = undefined;
    } else if (m.type === 'missing') {
      this.times = this.times.filter(t => t !== m.time);
    } else if (m.type === 'shift') {
      this.shifts.set(`${m.a}-${m.b}`, [m.dx, m.dy]);
      this.updateWind();
    } else if (m.type === 'error') {
      if (!this.frames.size) return this.fail(m.message);
      console.warn('Relieve de Hidalgo: nubes de hoy,', m.message);
    }
    this.updateStatus();
    this.onChange(m.type === 'frame');
  }

  /** Mediana de las velocidades medidas entre horas vecinas: viento de las nubes. */
  private updateWind() {
    const vx: number[] = [], vy: number[] = [];
    for (const [k, [dx, dy]] of this.shifts) {
      const [a, b] = k.split('-').map(Number), dm = (b - a) / MIN;
      vx.push(dx / dm); vy.push(dy / dm);
    }
    const med = (v: number[]) => v.sort((p, q) => p - q)[v.length >> 1];
    this.vel = [med(vx), med(vy)];
    // km/h; las nubes avanzan hacia (x, z) y el viento viene del lado contrario
    const ex = this.vel[0] * this.kmPx[0] * 60, ez = this.vel[1] * this.kmPx[1] * 60;
    this.status.windKmh = Math.hypot(ex, ez);
    this.status.windDeg = ((Math.atan2(-ex, ez) * 180) / Math.PI + 360) % 360;
  }

  private updateStatus() {
    const s = this.status, loaded = [...this.frames.keys()].sort((a, b) => a - b);
    s.loaded = loaded.length;
    s.total = Math.max(this.times.length, loaded.length);
    s.latest = loaded[loaded.length - 1];
    s.firstHour = this.times.length ? mxHour(this.times[0]) : undefined;
    // hoy, hasta la última bajada (se baja primero); otro día, hasta la última del día aunque aún no llegue
    const end = this.archive ? this.times[this.times.length - 1] : s.latest;
    s.lastHour = end !== undefined ? (end - this.dayStart) / HOUR : undefined;
  }

  /** la última imagen bajada (ms) */
  get latest() { return this.status.latest ?? 0; }
  /** ya se bajó la imagen más reciente de hoy (la hora salta a ella; con otro día, no) */
  get hasNewest() { return !this.archive && this.times.length > 0 && this.frames.has(this.times[this.times.length - 1]); }

  /** Instante de una hora del deslizador: el día que se muestra; al final del deslizador (20:30), la última imagen. */
  timeFor(hour: number) {
    const t = this.dayStart + hour * HOUR, last = this.archive ? this.times[this.times.length - 1] ?? 0 : this.latest;
    return hour >= 20.49 && last > t ? last : t;
  }

  /** Pide las imágenes del día que faltan, primero las cercanas a t. */
  want(t: number) {
    this.asked = true;
    this.focus = t;
    const missing = this.times.filter(x => !this.frames.has(x));
    if (missing.length) this.send({ type: 'load', times: missing, focus: t });
  }

  /** Las dos imágenes bajadas alrededor de t (o la más cercana), la mezcla y el movimiento. */
  pair(t: number): LivePair | null {
    const ts = [...this.frames.keys()].sort((a, b) => a - b);
    if (!ts.length) return null;
    let i = 0;
    while (i < ts.length - 1 && ts[i + 1] <= t) i++;
    const a = this.frames.get(ts[i])!, b = this.frames.get(ts[Math.min(ts.length - 1, t > ts[i] ? i + 1 : i)])!;
    const span = b.time - a.time, mix = span > 0 ? Math.min(1, Math.max(0, (t - a.time) / span)) : 0;
    const dm = span / MIN, measured = this.shifts.get(`${a.time}-${b.time}`);
    const shift: [number, number] = measured ?? [this.vel[0] * dm, this.vel[1] * dm];
    // arrastre del detalle: lo que avanzaron las nubes desde el inicio del día
    const since = (Math.min(Math.max(t, ts[0]), ts[ts.length - 1]) - this.dayStart) / MIN;
    this.status.shown = mix < 0.5 ? a.time : b.time;
    return { a, b, mix, shift, drift: [this.vel[0] * since, this.vel[1] * since] };
  }

  dispose() {
    clearInterval(this.timer);
    this.worker?.terminate();
    this.worker = null;
  }
}
