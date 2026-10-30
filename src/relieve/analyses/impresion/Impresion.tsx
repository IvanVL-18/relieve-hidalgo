import { useEffect, useMemo, useRef, useState } from 'react';
import type { LinesHandle, MapApi } from '../../engine/mapApi';
import { fmtPoints, parsePoints } from '../../shared/enlaces';
import type { Meta } from '../../shared/types';
import { fmtInt } from '../scales';
import type { AnalysisProps } from '../types';
import { Chips, Facts, Loading, Note, Section, Seg, oneOf, parseMuni, saveBlob, useAsync, useLinked } from '../ui';
import type { PrintGrid, PrintInput, RiverMode, SourceGrid } from './model';
import type { StlReply, StlRequest, StlStats } from './stl.worker';

type Area = 'estado' | 'municipio' | 'rect';
type Detalle = 'borrador' | 'normal' | 'fino';
type Bounds = [number, number, number, number];

/** mm por celda de la rejilla de impresión (0.4 mm ≈ la boquilla de una impresora de filamento) */
const CELL: Record<Detalle, number> = { borrador: 0.8, normal: 0.4, fino: 0.2 };
/** STL más grande que se genera (≈ 300 MB) */
const MAX_TRI = 6e6;
const PREVIEW_PX = 360;
const ACCENT = '#ffcf7a';
const LOCS: [string, string][] = [['0', 'Ninguna'], ['15000', 'Ciudades'], ['2500', '≥ 2 500 hab.'], ['500', '≥ 500 hab.']];
const num = (lo: number, hi: number) => (s: string) => { const n = Number(s); return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined; };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const fmtMm = (v: number) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString('es-MX');
const fmtMb = (b: number) => `${(b / 1048576).toLocaleString('es-MX', { maximumFractionDigits: b < 1e7 ? 1 : 0 })} MB`;
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** km por grado a la latitud media del área */
const kmPerDeg = (b: Bounds) => [111.32 * Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180), 110.57] as const;

/** Rectángulo de las celdas de la rejilla de 270 m que cumplen keep, con una celda de margen. */
function boundsOf(meta: Meta, mg: Uint8Array, keep: (m: number) => boolean): Bounds | null {
  let c0 = Infinity, c1 = -1, r0 = Infinity, r1 = -1;
  for (let r = 0; r < meta.H; r++) for (let c = 0; c < meta.W; c++) {
    if (!keep(mg[r * meta.W + c])) continue;
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
  }
  const s = meta.step;
  return c1 < 0 ? null : [meta.lon0 + (c0 - 1) * s, meta.lat0 - (r1 + 1) * s, meta.lon0 + (c1 + 1) * s, meta.lat0 - (r0 - 1) * s];
}

interface Plan { grid: PrintGrid; mmPerKm: number; kmX: number; kmY: number }

/** Rejilla de impresión: el lado mayor mide size mm y cada celda ≈ cell mm. */
function planFor(b: Bounds, size: number, cell: number): Plan {
  const [kx, ky] = kmPerDeg(b), kmX = (b[2] - b[0]) * kx, kmY = (b[3] - b[1]) * ky, mmPerKm = size / Math.max(kmX, kmY);
  const nx = Math.max(2, Math.round((kmX * mmPerKm) / cell)), ny = Math.max(2, Math.round((kmY * mmPerKm) / cell));
  return { grid: { nx, ny, cx: (kmX * mmPerKm) / nx, cy: (kmY * mmPerKm) / ny, lon0: b[0], lat0: b[1], dLon: (b[2] - b[0]) / nx, dLat: (b[3] - b[1]) / ny }, mmPerKm, kmX, kmY };
}

/** Municipio de cada nodo y celdas a imprimir (el municipio se lee de la rejilla de ~50 m del visor). */
function masks(map: MapApi, g: PrintGrid, area: Area, mun: number) {
  const W = g.nx + 1, H = g.ny + 1, muni = new Uint8Array(W * H), inside = new Uint8Array(g.nx * g.ny);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) muni[j * W + i] = map.municipioAt(g.lon0 + i * g.dLon, g.lat0 + j * g.dLat);
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const m = area === 'rect' ? 1 : map.municipioAt(g.lon0 + (i + 0.5) * g.dLon, g.lat0 + (j + 0.5) * g.dLat);
    inside[j * g.nx + i] = area === 'rect' || (area === 'estado' ? m > 0 : m === mun) ? 1 : 0;
  }
  return { muni, inside };
}

/** Rejilla más chica para la vista previa: promedio (elevación) o máximo (área drenada: conserva los ríos) por bloque. */
function shrink(src: SourceGrid, maxSide: number, mode: 'mean' | 'max'): SourceGrid {
  const k = Math.ceil(Math.max(src.width, src.height) / maxSide);
  if (k <= 1) return src;
  const w = Math.ceil(src.width / k), h = Math.ceil(src.height / k), data = new Float32Array(w * h), [W0, , E0, N0] = src.bounds;
  const dl = (E0 - W0) / src.width, dt = (N0 - src.bounds[1]) / src.height;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    let s = 0, n = 0, m = -Infinity;
    for (let rr = r * k; rr < Math.min(src.height, r * k + k); rr++) for (let cc = c * k; cc < Math.min(src.width, c * k + k); cc++) {
      const v = src.data[rr * src.width + cc];
      if (v === v) { s += v; n++; if (v > m) m = v; }
    }
    data[r * w + c] = n ? (mode === 'mean' ? s / n : m) : NaN;
  }
  return { width: w, height: h, bounds: [W0, N0 - h * k * dt, W0 + w * k * dl, N0], data };
}

/** Cliente del worker que arma el modelo. */
function useStlWorker() {
  const ref = useRef<{ worker: Worker; next: number; wait: Map<number, (r: StlReply) => void> } | null>(null);
  useEffect(() => {
    const worker = new Worker(new URL('./stl.worker.ts', import.meta.url), { type: 'module' });
    const st = { worker, next: 1, wait: new Map<number, (r: StlReply) => void>() };
    worker.onmessage = ({ data }: MessageEvent<StlReply>) => { st.wait.get(data.id)?.(data); st.wait.delete(data.id); };
    worker.onerror = () => { for (const f of st.wait.values()) f({ id: 0, error: 'El generador del modelo se detuvo' }); st.wait.clear(); };
    ref.current = st;
    return () => { worker.terminate(); ref.current = null; };
  }, []);
  return useRef((req: Omit<StlRequest, 'id'>) => new Promise<StlReply>(resolve => {
    const st = ref.current;
    if (!st) return resolve({ id: 0, error: 'El generador del modelo no está listo' });
    const id = st.next++;
    st.wait.set(id, resolve);
    st.worker.postMessage({ ...req, id });
  })).current;
}

export default function Impresion({ ctx }: AnalysisProps) {
  const { map, meta, link } = ctx;
  const [area, setArea] = useLinked<Area>(link, 'area', 'estado', oneOf('estado', 'municipio', 'rect'));
  const [mun, setMun] = useLinked(link, 'mun', 0, parseMuni);
  const [rect, setRect] = useLinked<[number, number][]>(link, 'rect', [], s => parsePoints(s, 2), fmtPoints);
  const [size, setSize] = useLinked(link, 'tam', 200, num(60, 400));
  const [exag, setExag] = useLinked(link, 'exag', 0, num(0, 10));
  const [base, setBase] = useLinked(link, 'base', 3, num(1, 10));
  const [det, setDet] = useLinked<Detalle>(link, 'det', 'normal', oneOf('borrador', 'normal', 'fino'));
  const [rios, setRios] = useLinked<RiverMode>(link, 'rios', 'no', oneOf('no', 'hundidos', 'relieve'));
  const [lim, setLim] = useLinked(link, 'lim', false, s => (s === '1' ? true : s === '0' ? false : undefined), v => (v ? '1' : '0'));
  const [locMin, setLocMin] = useLinked(link, 'loc', '0', oneOf(...LOCS.map(l => l[0])));
  const [alto, setAlto] = useLinked(link, 'alto', 1, num(0.4, 2));
  const run = useStlWorker();
  const mg = useMemo(() => map.municipioGrid(), [map]);
  const [loc] = useAsync(() => ctx.data.localidades(), [ctx.data]);

  // área elegida
  const bounds = useMemo<Bounds | null>(() => {
    if (area === 'estado') return boundsOf(meta, mg, m => m > 0);
    if (area === 'municipio') return mun ? boundsOf(meta, mg, m => m === mun) : null;
    if (rect.length < 2) return null;
    const [[a, b], [c, d]] = rect;
    return Math.abs(a - c) > 0.005 && Math.abs(b - d) > 0.005 ? [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)] : null;
  }, [area, mun, rect, meta, mg]);
  const cell = CELL[det];
  const full = useMemo(() => (bounds ? planFor(bounds, size, cell) : null), [bounds, size, cell]);

  // relieve: 30 m si cada celda impresa mide menos de 60 m en el terreno (y la zona cabe), si no 90 m
  const res: 30 | 90 = full && 1000 / full.mmPerKm * cell < 60 ? 30 : 90;
  const boundsKey = bounds?.map(v => v.toFixed(4)).join(',') ?? '';
  const [src, srcError] = useAsync(async () => {
    if (!bounds) return null;
    const t = ctx.data.terrain(), pad = 0.004, b: Bounds = [bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad];
    const [elev, acc] = await Promise.all([t.grid('elevacion', b, res), rios !== 'no' ? t.grid('acumulacion', b, 90) : Promise.resolve(null)]);
    return { elev: elev as SourceGrid, acc: acc as SourceGrid | null, res: elev.res };
  }, [boundsKey, res, rios !== 'no']);

  // desnivel para la exageración automática: el relieve sobresale ≈ 6 % del lado mayor
  const range = useMemo(() => {
    if (area === 'estado') return meta.relief.max - meta.relief.min;
    if (area === 'municipio' && mun) return meta.mun[mun - 1][1] - meta.mun[mun - 1][0];
    let lo = Infinity, hi = -Infinity;
    if (src) for (const v of src.elev.data) if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return hi > lo ? hi - lo : 1000;
  }, [area, mun, meta, src]);
  const autoEx = full ? clamp(Math.round(((0.06 * size) / ((range / 1000) * full.mmPerKm)) * 2) / 2, 1, 8) : 1;
  const ex = exag || autoEx;
  const areaKm2 = full ? full.kmX * full.kmY : 0;
  const riverKm2 = Math.round(clamp(areaKm2 / 80, 8, 400));

  /** Todo lo que necesita el worker para una rejilla. */
  const inputFor = (plan: Plan, elev: SourceGrid, acc: SourceGrid | null): PrintInput => {
    const { muni, inside } = masks(map, plan.grid, area, mun), min = Number(locMin), places: PrintInput['params']['places'] = [];
    if (loc && min > 0 && bounds) for (let i = 0; i < loc.n && loc.pob[i] >= min; i++) {
      const lon = loc.lon[i], lat = loc.lat[i];
      if (lon < bounds[0] || lon > bounds[2] || lat < bounds[1] || lat > bounds[3] || (area === 'municipio' && loc.muni[i] !== mun)) continue;
      places.push({ lon, lat, r: clamp(0.9 + 0.55 * Math.log10(loc.pob[i] / 1000), 0.9, 2.6) });
    }
    return {
      grid: plan.grid, elev, acc, muni, inside,
      params: { mmPerM: (plan.mmPerKm / 1000) * ex, base, rivers: rios, riverKm2, borders: lim, feature: alto, line: 1.2, places },
    };
  };

  // vista previa (rejilla gruesa, con las mismas medidas en mm)
  const [prev, setPrev] = useState<{ key: string; stats: StlStats; img: ImageData; plan: Plan } | null>(null);
  const [prevError, setPrevError] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const prevKey = [boundsKey, size, ex, base, rios, lim, locMin, alto, area, mun, !!loc].join('|');
  useEffect(() => {
    if (!bounds || !src || !full) return;
    let alive = true;
    const t = setTimeout(() => {
      const plan = planFor(bounds, size, Math.max(cell, size / PREVIEW_PX));
      const input = inputFor(plan, shrink(src.elev, 2 * PREVIEW_PX, 'mean'), src.acc && shrink(src.acc, 2 * PREVIEW_PX, 'max'));
      run({ kind: 'preview', input, maxPx: PREVIEW_PX }).then(r => {
        if (!alive) return;
        if (r.error || !r.preview || !r.stats) { setPrevError(r.error ?? 'Sin vista previa'); return; }
        setPrevError(null);
        setPrev({ key: prevKey, stats: r.stats, img: new ImageData(new Uint8ClampedArray(r.preview.rgba), r.preview.width, r.preview.height), plan });
      });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
    // inputFor usa los mismos valores que prevKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prevKey, src, full, cell]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !prev) return;
    c.width = prev.img.width; c.height = prev.img.height;
    c.getContext('2d')?.putImageData(prev.img, 0, 0);
  }, [prev]);

  // triángulos del modelo completo, estimados con la vista previa (celdas ∝ área, contorno ∝ lado)
  const estimate = useMemo(() => {
    if (!prev || !full) return null;
    const k = prev.plan.grid.cx / full.grid.cx, wall = prev.stats.triangles - 4 * prev.stats.cells;
    const triangles = Math.round(4 * prev.stats.cells * k * k + wall * k);
    return { triangles, bytes: 84 + 50 * triangles };
  }, [prev, full]);
  const tooBig = !!estimate && estimate.triangles > MAX_TRI;

  // en el mapa: el municipio resaltado o el rectángulo, y clics para elegir
  useEffect(() => {
    map.setMunicipioFill(area === 'municipio' && mun ? { [mun]: ACCENT } : null, 0.5);
  }, [map, area, mun]);
  const lines = useRef<LinesHandle | null>(null);
  useEffect(() => {
    lines.current?.dispose();
    lines.current = null;
    if (area !== 'rect' || !rect.length) { map.setPin(null); return; }
    if (rect.length === 1) { map.setPin('Esquina 1', rect[0][0], rect[0][1]); return; }
    map.setPin(null);
    const [[a, b], [c, d]] = rect;
    lines.current = map.addLines({
      lon: Float32Array.from([a, c, c, a, a]), lat: Float32Array.from([b, b, d, d, b]),
      start: Uint32Array.of(0), len: Uint32Array.of(5), color: Uint8Array.of(255, 207, 122, 255), onTop: true, width: 2.5,
    });
    return () => { lines.current?.dispose(); lines.current = null; };
  }, [map, area, rect]);
  const areaRef = useRef(area);
  areaRef.current = area;
  useEffect(() => map.onClick(hit => {
    if (areaRef.current === 'municipio') { if (hit.municipio) setMun(hit.municipio); return true; }
    if (areaRef.current === 'rect') { setRect(r => (r.length === 1 ? [r[0], [hit.lon, hit.lat]] : [[hit.lon, hit.lat]])); return true; }
  }), [map, setMun, setRect]);

  // STL completo
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ stats: StlStats; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDone(null); setError(null); }, [prevKey, det]);
  const download = async () => {
    if (!full || !src || !bounds || tooBig) return;
    setBusy(true); setError(null);
    // deja que la interfaz muestre «Generando…» antes de recorrer la rejilla completa
    await new Promise(r => setTimeout(r, 30));
    const r = await run({ kind: 'stl', input: inputFor(full, src.elev, src.acc) });
    setBusy(false);
    if (r.error || !r.stl || !r.stats) { setError(r.error ?? 'No se pudo generar el modelo'); return; }
    const what = area === 'estado' ? 'hidalgo' : area === 'municipio' ? slug(meta.names[mun - 1]) : 'hidalgo-rectangulo';
    const name = `relieve-${what}-${Math.round(size)}mm-x${ex.toString().replace('.', '_')}.stl`;
    saveBlob(new Blob([r.stl], { type: 'model/stl' }), name);
    setDone({ stats: r.stats, name });
  };

  const names = useMemo(() => meta.names.map((n, i) => [i + 1, n] as const).sort((a, b) => a[1].localeCompare(b[1], 'es')), [meta]);
  const stats = done?.stats ?? prev?.stats;
  const scale = full ? Math.round(1e6 / full.mmPerKm / 1000) * 1000 : 0;

  return (
    <>
      <p className="rh-a-lead">El modelo lleva base plana y la exageración vertical que elijas; puede llevar ríos, límites y localidades en relieve para un <b>mapa táctil</b>.</p>

      <Section title="Qué imprimir">
        <Seg label="Área" value={area} onChange={setArea} options={[['estado', 'Estado'], ['municipio', 'Municipio'], ['rect', 'Rectángulo']]} />
        {area === 'municipio' && (
          <>
            <select className="rh-a-input" aria-label="Municipio" value={mun || ''} onChange={e => setMun(Number(e.target.value))}>
              <option value="" disabled>Elige un municipio…</option>
              {names.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
            </select>
            <Note>O haz clic en el mapa sobre el municipio.</Note>
          </>
        )}
        {area === 'rect' && (
          <Note>
            {rect.length === 0 ? 'Haz clic en el mapa en una esquina del rectángulo y luego en la opuesta.' : rect.length === 1 ? 'Ahora haz clic en la esquina opuesta.' : 'Un clic más empieza otro rectángulo.'}
            {' '}Fuera de Hidalgo solo hay relieve a unos 3 km del límite.
            {rect.length > 0 && <> <button type="button" className="rh-a-link" onClick={() => setRect([])}>Borrar</button></>}
          </Note>
        )}
      </Section>

      <Section title="Tamaño y relieve">
        <div className="rh-ctl">
          <div className="rh-head"><label htmlFor="rh-p-size">Lado mayor</label><output htmlFor="rh-p-size">{size} mm</output></div>
          <input id="rh-p-size" type="range" min={60} max={400} step={10} value={size} onChange={e => setSize(+e.target.value)} />
        </div>
        <div className="rh-ctl">
          <div className="rh-head">
            <label htmlFor="rh-p-ex">Exageración vertical</label>
            <output htmlFor="rh-p-ex">{ex.toLocaleString('es-MX')}×{!exag && ' (auto)'}</output>
          </div>
          <input id="rh-p-ex" type="range" min={1} max={10} step={0.5} value={ex} onChange={e => setExag(+e.target.value)} />
          {exag > 0 && <button type="button" className="rh-a-link" onClick={() => setExag(0)}>Volver a la automática ({autoEx.toLocaleString('es-MX')}×)</button>}
        </div>
        <div className="rh-ctl">
          <div className="rh-head"><label htmlFor="rh-p-base">Base bajo el punto más bajo</label><output htmlFor="rh-p-base">{base} mm</output></div>
          <input id="rh-p-base" type="range" min={1} max={10} step={0.5} value={base} onChange={e => setBase(+e.target.value)} />
        </div>
        <Seg label="Detalle" value={det} onChange={setDet} options={[['borrador', 'Borrador 0.8 mm'], ['normal', 'Normal 0.4 mm'], ['fino', 'Fino 0.2 mm']]} />
      </Section>

      <Section title="Mapa táctil">
        <Seg label="Ríos" value={rios} onChange={setRios} options={[['no', 'Sin ríos'], ['hundidos', 'Ríos hundidos'], ['relieve', 'Ríos en relieve']]} />
        <Chips label="Límites" value={lim ? 'lim' : ''} options={[['lim', area === 'rect' ? 'Límites municipales y estatal' : 'Límites municipales']]} onToggle={() => setLim(!lim)} />
        <Seg label="Localidades en relieve" value={locMin} onChange={setLocMin} options={LOCS} />
        {(rios !== 'no' || lim || locMin !== '0') && (
          <div className="rh-ctl">
            <div className="rh-head"><label htmlFor="rh-p-alto">Alto de las marcas</label><output htmlFor="rh-p-alto">{alto.toLocaleString('es-MX')} mm</output></div>
            <input id="rh-p-alto" type="range" min={0.4} max={2} step={0.1} value={alto} onChange={e => setAlto(+e.target.value)} />
          </div>
        )}
        {rios !== 'no' && <Note>Ríos con más de {fmtInt(riverKm2)} km² de cuenca, en líneas de 1.2 mm.</Note>}
      </Section>

      <Section title="Vista previa">
        {!bounds ? <Note>{area === 'municipio' ? 'Elige un municipio.' : 'Marca el rectángulo en el mapa.'}</Note>
          : srcError ? <p className="rh-a-warn">{srcError}</p>
          : !src || !prev ? <Loading text="Leyendo el relieve…" />
          : (
            <>
              <div className="rh-a-preview" style={{ aspectRatio: `${prev.img.width} / ${prev.img.height}` }}><canvas ref={canvas} aria-label="Vista previa del modelo" /></div>
              {prevError && <p className="rh-a-warn">{prevError}</p>}
            </>
          )}
        {full && stats && (
          <Facts items={[
            ['Modelo', `${fmtMm(full.kmX * full.mmPerKm)} × ${fmtMm(full.kmY * full.mmPerKm)} × ${fmtMm(stats.height)} mm`],
            ['Escala', `1 : ${fmtInt(scale)} · 1 mm = ${(1 / full.mmPerKm).toLocaleString('es-MX', { maximumFractionDigits: 2 })} km`],
            ['Relieve', `${fmtInt(stats.elevMin)}–${fmtInt(stats.elevMax)} m, ×${ex.toLocaleString('es-MX')} en vertical`],
            ['Relieve de origen', src ? `${src.res < 60 ? 30 : 90} m` : '—'],
            ['Archivo', done ? `${fmtInt(done.stats.triangles)} triángulos · ${fmtMb(done.stats.bytes)}` : estimate ? `≈ ${(estimate.triangles / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 1 })} millones de triángulos · ≈ ${fmtMb(estimate.bytes)}` : '—'],
          ]} />
        )}
        {tooBig && <p className="rh-a-warn">Demasiado detalle para el navegador: baja el tamaño o usa un detalle más grueso.</p>}
        <button type="button" className="rh-a-btn" disabled={!src || !full || busy || tooBig} onClick={download}>
          {busy ? <><span className="rh-spinner" aria-hidden="true" />Generando…</> : 'Descargar STL'}
        </button>
        {error && <p className="rh-a-warn">{error}</p>}
        {done && <Note>Listo: <b>{done.name}</b>.</Note>}
      </Section>

      <Note>
        Se imprime sin soportes, con la base sobre la cama. En filamento, capas de 0.1–0.2 mm; el detalle «Fino» solo se
        aprecia en resina. Para mapas táctiles conviene que las marcas midan al menos 0.8 mm de alto y estén a 2 mm o más
        unas de otras. Relieve de INEGI (Continental relief 2016) vía Terrain Tiles.
      </Note>
    </>
  );
}
