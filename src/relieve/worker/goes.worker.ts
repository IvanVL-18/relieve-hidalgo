import { sunPosition } from '../engine/sun';
import { GEO_LAYER, IR_LAYER, VIS_LAYER, domainsUrl, parseDomains, pickFrames, wmsUrl, type LiveBox } from '../shared/goes';
import { buildFields, decodePng, irCelsius, nightLowClouds, shiftBetween, sunGrid, visReflectance, type LiveMemory } from '../shared/goesImage';

export type GoesRequest =
  /** base = servidor compatible con GIBS; elev = altitud media del terreno por píxel del visible (km) */
  | { type: 'init'; base: string; box: LiveBox; elev: Float32Array }
  /** horas del día (dayStart = medianoche de México en ms) y la última imagen; con focus (otro día), la de esa hora */
  | { type: 'start'; dayStart: number; now: number; focus?: number }
  /** bajar estas horas, primero las más cercanas a focus */
  | { type: 'load'; times: number[]; focus: number }
  /** buscar imágenes nuevas */
  | { type: 'refresh'; now: number };

export type GoesResult =
  | { type: 'list'; times: number[] }
  | { type: 'frame'; time: number; data: Uint8Array; cores: number[]; maxTop: number; slope: number; vis: boolean }
  | { type: 'missing'; time: number }
  /** movimiento de las nubes de a a b, en píxeles del visible */
  | { type: 'shift'; a: number; b: number; dx: number; dy: number }
  | { type: 'error'; message: string };

const ctx = self as unknown as {
  postMessage(msg: GoesResult, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<GoesRequest>) => void) | null;
};

const MIN = 60e3;
let base = '', box: LiveBox | null = null, elev: Float32Array | null = null, mem: LiveMemory | null = null;
let dayStart = 0, available: number[] = [], list: number[] = [];
const done = new Set<number>(), failed = new Set<number>(), cold = new Map<number, Float32Array>(), shifts = new Set<string>();
let queue: number[] = [], focus = 0, busy = 0;

const post = (m: GoesResult, t?: Transferable[]) => ctx.postMessage(m, t);
const sortList = () => { list = [...new Set(list)].sort((a, b) => a - b); post({ type: 'list', times: list }); };

async function get(url: string) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`el servidor respondió ${r.status}`);
    return r;
  } finally { clearTimeout(timer); }
}

/** Imagen decodificada; null si GIBS aún no la tiene (responde una imagen vacía). */
async function image(layer: string, ir: boolean, t: number) {
  const r = await get(wmsUrl(base, layer, box!, ir, t));
  if (!(r.headers.get('content-type') ?? '').includes('png')) return null;
  const img = await decodePng(await r.arrayBuffer());
  if (img.w !== box!.w / (ir ? 2 : 1) || img.h !== box!.h / (ir ? 2 : 1)) return null;
  let opaque = 0;
  for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] > 127) opaque++;
  return opaque > (img.w * img.h) / 2 ? img : null;
}

/** Baja y procesa una hora. false si no hay imagen. */
async function frame(t: number): Promise<boolean> {
  const b = box!;
  const ir = await image(IR_LAYER, true, t);
  if (!ir) return false;
  const sin = sunGrid(b, (lat, lon) => Math.sin(sunPosition(new Date(t), lat, lon).elevation));
  let refl: Float32Array | null = null, low: Float32Array | null = null;
  const sc = sin[(b.h >> 1) * b.w + (b.w >> 1)];
  if (sc > 0.05) {
    const vis = await image(VIS_LAYER, false, t).catch(() => null);
    if (vis) refl = visReflectance(vis.rgba, sin);
  }
  // de noche y al amanecer, las nubes bajas de GeoColor (sale ~20 min después: la última imagen puede no tenerlo)
  if (sc < 0.17) {
    const geo = await image(GEO_LAYER, false, t).catch(() => null);
    if (geo) low = nightLowClouds(geo.rgba);
  }
  const f = buildFields(irCelsius(ir.rgba, ir.w, ir.h), refl, sin, elev!, b.w, b.h, mem!, low);
  cold.set(t, f.cold);
  post({ type: 'frame', time: t, data: f.data, cores: f.cores, maxTop: f.maxTop, slope: f.slope, vis: !!refl }, [f.data.buffer]);
  measure();
  return true;
}

/** Movimiento entre horas vecinas ya bajadas (en la rejilla de 2 km, enviado en píxeles del visible). */
function measure() {
  const have = list.filter(t => cold.has(t));
  for (let i = 1; i < have.length; i++) {
    const a = have[i - 1], b = have[i], key = `${a}-${b}`;
    if (shifts.has(key) || b - a > 70 * MIN) continue;
    shifts.add(key);
    const s = shiftBetween(cold.get(a)!, cold.get(b)!, box!.w / 2, box!.h / 2);
    if (s.ok) post({ type: 'shift', a, b, dx: s.dx * 2, dy: s.dy * 2 });
  }
}

/** Una hora de la lista; si GIBS no la tiene, otra disponible a ≤ 10 min que no esté en la lista. */
async function loadOne(t: number) {
  try {
    if (await frame(t)) { done.add(t); return; }
    failed.add(t);
    const alt = available.filter(a => Math.abs(a - t) <= 10 * MIN && a !== t && !list.includes(a) && !failed.has(a));
    for (const a of alt) {
      if (await frame(a)) { done.add(a); list = list.filter(x => x !== t).concat(a); sortList(); return; }
      failed.add(a);
    }
    list = list.filter(x => x !== t);
    post({ type: 'missing', time: t });
  } catch (e) {
    failed.add(t);
    post({ type: 'missing', time: t });
    if (!done.size) post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

function pump() {
  while (busy < 3 && queue.length) {
    // la más cercana a la hora que se ve
    let k = 0;
    for (let i = 1; i < queue.length; i++) if (Math.abs(queue[i] - focus) < Math.abs(queue[k] - focus)) k = i;
    const t = queue.splice(k, 1)[0];
    if (done.has(t) || failed.has(t)) continue;
    busy++;
    loadOne(t).finally(() => { busy--; pump(); });
  }
}

/** Horas disponibles entre t0 y t1; si DescribeDomains falla, se suponen cada 10 min hasta hace 30 min. */
async function domains(t0: number, t1: number) {
  try {
    const xml = await (await get(domainsUrl(base, IR_LAYER, t0, t1))).text();
    const times = parseDomains(xml).filter(t => t >= t0 && t <= t1);
    if (times.length) return times;
  } catch { /* se suponen */ }
  const out: number[] = [];
  for (let t = Math.floor(t0 / (10 * MIN)) * 10 * MIN; t <= t1 - 30 * MIN; t += 10 * MIN) out.push(t);
  return out;
}

/** La última imagen que el WMS ya tiene (DescribeDomains va unos minutos adelante del WMS). */
async function latest() {
  for (let k = available.length - 1, tries = 0; k >= 0 && tries < 6; k--, tries++) {
    const t = available[k];
    if (done.has(t)) return true;
    if (failed.has(t)) continue;
    try {
      if (await frame(t)) { done.add(t); if (!list.includes(t)) { list.push(t); sortList(); } return true; }
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      return false;
    }
    failed.add(t);
    list = list.filter(x => x !== t);
  }
  sortList();
  return false;
}

/** Otro día: primero la imagen más cercana a t (si no está, las siguientes más cercanas). */
async function nearest(t: number) {
  for (const x of list.slice().sort((a, b) => Math.abs(a - t) - Math.abs(b - t)).slice(0, 4)) {
    await loadOne(x);
    if (done.size) return true;
  }
  return false;
}

ctx.onmessage = async ev => {
  const m = ev.data;
  if (m.type === 'init') {
    ({ base, box, elev } = m);
    mem = { rMin: new Float32Array(m.box.w * m.box.h).fill(1) };
  } else if (m.type === 'start') {
    dayStart = m.dayStart;
    available = await domains(dayStart + 4.5 * 60 * MIN, m.now);
    list = pickFrames(available, dayStart);
    sortList();
    if (m.focus !== undefined) {
      focus = m.focus;
      if (!(await nearest(m.focus)) && !done.size) post({ type: 'error', message: 'GIBS ya no tiene imágenes de ese día (guarda unos 90)' });
    } else if (!(await latest()) && !done.size) post({ type: 'error', message: 'GIBS aún no publica imágenes de hoy' });
  } else if (m.type === 'load') {
    focus = m.focus;
    queue = [...new Set([...queue, ...m.times])].filter(t => !done.has(t) && !failed.has(t));
    pump();
  } else if (m.type === 'refresh') {
    const last = available[available.length - 1] ?? dayStart;
    const more = (await domains(last + MIN, m.now)).filter(t => t > last);
    if (!more.length) return;
    available = available.concat(more);
    const before = list.length;
    list = [...new Set([...list.filter(t => done.has(t) || !failed.has(t)), ...pickFrames(available, dayStart)])];
    if (list.length !== before) sortList();
    await latest();
  }
};
