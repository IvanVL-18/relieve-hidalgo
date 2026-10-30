import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointsHandle, RasterHandle } from '../../engine/mapApi';
import { fmtPoints, parsePoints } from '../../shared/enlaces';
import { makeGeo, type Geo } from '../../shared/geo';
import { EARTH_R, type Profile, type TerrainApi, type Viewshed } from '../../shared/terrain';
import type { Meta } from '../../shared/types';
import { locIndex, locKey, type Localidades } from '../datasets';
import { NOVIEW, VIEW_RAMP, fmtInt, fmtShort, hexToRgba } from '../scales';
import type { AnalysisProps } from '../types';
import { Bars, Chips, ClassLegend, Examples, Facts, Loading, Note, Section, Seg, Stats, oneOf, useAsync, useLinked } from '../ui';
import { LosChart, type LosData } from './LosChart';

type Rx = 'persona' | 'techo' | 'mastil';
type Vista = 'cobertura' | 'sombra';
/** altura del receptor sobre el suelo (m) */
const RX: Record<Rx, number> = { persona: 1.5, techo: 6, mastil: 12 };
const MAX = 6, LETTERS = 'ABCDEF', K = 4 / 3, KR = K * EARTH_R;
const TOWER = '#f2c94c', COVERED = '#d8dde6', SHADE = '#0e121acc';
/** subidas de la antena que se prueban con las localidades sin línea de vista */
const LIFTS = [10, 25, 50];
const POPC = Array.from({ length: 64 }, (_, i) => { let n = 0; for (let b = i; b; b >>= 1) n += b & 1; return n; });

/** Ejemplos (cimas del relieve de 30 m): [id, nombre, torres, altura de antena (m), radio (km)]. */
const EJEMPLOS: [string, string, [number, number][], number, number][] = [
  ['pachuca', 'Pachuca desde la sierra', [[-98.7065, 20.1632]], 30, 20],
  ['mezquital', 'Cerro junto a Ixmiquilpan', [[-99.209, 20.4346]], 30, 30],
  ['sierra', 'Sierra Alta: tres torres', [[-98.6726, 20.6215], [-98.7154, 20.7768], [-98.6176, 20.9207]], 40, 20],
  ['huasteca', 'Huasteca: Huejutla', [[-98.4401, 21.2049]], 40, 30],
];

interface Cobertura {
  /** clase por nodo para la capa: 0 fuera, 1 sin línea de vista, 2–4 visible desde 1, 2, 3 o más torres */
  cats: Uint8Array;
  /** km² de Hidalgo visibles y dentro de los radios */
  kmVis: number; kmRadio: number;
  porTorre: { km: number; pob: number; locs: number }[];
  pob: number; pobRadio: number; locs: number; locsRadio: number;
  /** localidades del radio sin línea de vista, de la más poblada a la menos */
  sin: number[];
  lifts: { m: number; locs: number; pob: number }[];
  munis: { id: number; pob: number; pobVis: number }[];
}

function evaluar(vs: Viewshed, loc: Localidades, mg: Uint8Array, meta: Meta): Cobertura {
  const g = vs.grid, w = g.width, h = g.height, bits = g.data as Uint8Array, [W0, S0, E0, N0] = g.bounds, nt = vs.sites.length;
  const dLon = (E0 - W0) / w, dLat = (N0 - S0) / h, geo = makeGeo(meta), cellKm2 = dLon * geo.KX * dLat * geo.KZ;
  // celda de la rejilla del visor (municipios a 270 m) de cada columna y fila
  const colV = Int32Array.from({ length: w }, (_, c) => Math.round((W0 + (c + 0.5) * dLon - meta.lon0) / meta.step));
  const rowV = Int32Array.from({ length: h }, (_, r) => Math.round((meta.lat0 - (N0 - (r + 0.5) * dLat)) / meta.step));
  const cats = new Uint8Array(w * h), kmT = new Array<number>(nt).fill(0);
  let vis = 0, rad = 0;
  for (let r = 0; r < h; r++) {
    const rv = rowV[r], inRow = rv >= 0 && rv < meta.H;
    for (let c = 0; c < w; c++) {
      const i = r * w + c, b = bits[i];
      if (!(b & 128)) continue;
      const t = b & 63;
      cats[i] = t ? Math.min(4, POPC[t] + 1) : 1;
      const cv = colV[c];
      if (!inRow || cv < 0 || cv >= meta.W || !mg[rv * meta.W + cv]) continue;
      rad++;
      if (t) { vis++; for (let k = 0; k < nt; k++) if (t & (1 << k)) kmT[k]++; }
    }
  }
  const porTorre = kmT.map(n => ({ km: n * cellKm2, pob: 0, locs: 0 })), sin: number[] = [], lifts = LIFTS.map(m => ({ m, locs: 0, pob: 0 }));
  const byMuni = new Map<number, { id: number; pob: number; pobVis: number }>();
  let pob = 0, pobRadio = 0, locs = 0, locsRadio = 0;
  const P = vs.points;
  if (P) for (let i = 0; i < loc.n; i++) {
    const l = P.lift[i];
    if (Number.isNaN(l)) continue;
    const b = P.bits[i], p = loc.pob[i], m = byMuni.get(loc.muni[i]) ?? { id: loc.muni[i], pob: 0, pobVis: 0 };
    locsRadio++; pobRadio += p; m.pob += p;
    byMuni.set(m.id, m);
    if (b) {
      locs++; pob += p; m.pobVis += p;
      for (let k = 0; k < nt; k++) if (b & (1 << k)) { porTorre[k].pob += p; porTorre[k].locs++; }
    } else {
      sin.push(i);
      for (const x of lifts) if (l <= x.m) { x.locs++; x.pob += p; }
    }
  }
  sin.sort((a, b) => loc.pob[b] - loc.pob[a]);
  const munis = [...byMuni.values()].filter(m => m.id > 0).sort((a, b) => b.pob - a.pob);
  return { cats, kmVis: vis * cellKm2, kmRadio: rad * cellKm2, porTorre, pob, pobRadio, locs, locsRadio, sin, lifts, munis };
}

/** El punto más alto a ≤ radiusM del clic (relieve de 30 m): las torres van en las cimas. */
async function peak(terrain: TerrainApi, geo: Geo, lon: number, lat: number, radiusM = 400): Promise<[number, number]> {
  const rk = radiusM / 1000, g = await terrain.grid('elevacion', [lon - rk / geo.KX, lat - rk / geo.KZ, lon + rk / geo.KX, lat + rk / geo.KZ], 30);
  const [W0, S0, E0, N0] = g.bounds, dx = (E0 - W0) / g.width, dy = (N0 - S0) / g.height, z = g.data;
  let best = -1;
  for (let r = 0; r < g.height; r++) for (let c = 0; c < g.width; c++) {
    const i = r * g.width + c, lo = W0 + (c + 0.5) * dx, la = N0 - (r + 0.5) * dy;
    if (((lo - lon) * geo.KX) ** 2 + ((la - lat) * geo.KZ) ** 2 <= rk * rk && z[i] > 0 && (best < 0 || z[i] > z[best])) best = i;
  }
  return best < 0 ? [lon, lat] : [W0 + ((best % g.width) + 0.5) * dx, N0 - (Math.floor(best / g.width) + 0.5) * dy];
}

/** Perfil de la línea de vista con el abultamiento de la Tierra y la altura que le falta a la antena (como losLift). */
function losData(p: Profile, tower: number, alto: number, hRx: number, name: string): LosData {
  const n = p.km.length, Dm = p.km[n - 1] * 1000, terrain = new Float32Array(n);
  for (let i = 0; i < n; i++) { const d = p.km[i] * 1000; terrain[i] = p.elev[i] + (d * (Dm - d)) / (2 * KR); }
  const zT = p.elev[0] + alto, zR = p.elev[n - 1] + hRx;
  let need = -Infinity, over = -Infinity, iBlock = -1;
  for (let i = 1; i < n - 1; i++) {
    if (!Number.isFinite(terrain[i])) continue;
    const t = (p.km[i] * 1000) / Dm, req = (terrain[i] - zR * t) / (1 - t), o = terrain[i] - (zT + (zR - zT) * t);
    if (req > need) need = req;
    if (o > over) { over = o; iBlock = i; }
  }
  return { tower, name, km: p.km, terrain, ground: p.elev, zT, zR, lift: need - zT, over, iBlock };
}

const paletteOf = (v: Vista): (string | null)[] => (v === 'sombra' ? [null, NOVIEW, null, null, null] : [null, SHADE, ...VIEW_RAMP]);
const fmtKm2 = (v: number) => (v >= 100 ? fmtInt(v) : v.toFixed(1));
const pct = (a: number, b: number) => (!(b > 0) ? '—' : a > 0 && a < b * 0.001 ? '< 0.1 %' : `${((100 * a) / b).toFixed(a === b || a === 0 ? 0 : 1)} %`);

export default function Antenas({ ctx }: AnalysisProps) {
  const { map, data, meta, link } = ctx;
  const geo = useMemo(() => makeGeo(meta), [meta]);
  const [loc, locErr] = useAsync(() => data.localidades(), [data]);
  const [torres, setTorres] = useLinked<[number, number][]>(link, 'torres', [], s => parsePoints(s, MAX), fmtPoints);
  const [alto, setAlto] = useLinked(link, 'alto', 30, s => { const v = Number(s); return v >= 5 && v <= 150 ? v : undefined; });
  const [rx, setRx] = useLinked<Rx>(link, 'rx', 'persona', oneOf('persona', 'techo', 'mastil'));
  const [radio, setRadio] = useLinked(link, 'radio', 20, s => { const v = Number(s); return v >= 5 && v <= 60 ? v : undefined; });
  const [vista, setVista] = useLinked<Vista>(link, 'vista', 'cobertura', oneOf('cobertura', 'sombra'));
  const [cima, setCima] = useState(true);
  const [vs, setVs] = useState<Viewshed | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(-1);
  const [los, setLos] = useState<LosData | null>(null);
  const linkLoc = useRef<string | undefined>(link.initial.loc);
  const towersH = useRef<PointsHandle | null>(null), locsH = useRef<PointsHandle | null>(null), raster = useRef<RasterHandle | null>(null);
  const lastClick = useRef({ t: 0, lon: 0, lat: 0 });
  const vsRef = useRef(vs);
  vsRef.current = vs;

  // localidad del enlace
  useEffect(() => {
    if (!loc || !linkLoc.current) return;
    const i = locIndex(loc, linkLoc.current);
    linkLoc.current = undefined;
    if (i >= 0) setSel(i);
  }, [loc]);
  useEffect(() => link.set('loc', sel >= 0 && loc ? locKey(loc, sel) : linkLoc.current ?? null), [link, sel, loc]);

  // zona visible: se recalcula 250 ms después del último cambio (los deslizadores avisan en cada paso)
  useEffect(() => {
    if (!torres.length || !loc) { setVs(null); setBusy(false); return; }
    let alive = true;
    setBusy(true); setErr('');
    const t = setTimeout(() => {
      data.terrain().viewshed(torres.map(([lon, lat]) => ({ lon, lat, height: alto })), { receiver: RX[rx], radiusKm: radio, k: K, points: { lon: loc.lon, lat: loc.lat } }).then(
        v => { if (alive) { setVs(v); setBusy(false); } },
        e => { if (alive) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); } },
      );
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [torres, alto, rx, radio, loc, data]);

  const cov = useMemo(() => (vs && loc ? evaluar(vs, loc, map.municipioGrid(), meta) : null), [vs, loc, map, meta]);

  // capa de la zona visible (o de la sombra)
  useEffect(() => {
    if (!vs || !cov) return;
    const g = vs.grid;
    const r = map.addRaster({ kind: 'categorical', bounds: g.bounds, width: g.width, height: g.height, data: cov.cats, palette: paletteOf('cobertura'), opacity: 0.8 });
    raster.current = r;
    return () => { r.dispose(); raster.current = null; };
  }, [map, vs, cov]);
  useEffect(() => { raster.current?.setPalette(paletteOf(vista)); }, [vista, cov]);

  // radio de cada torre, solo dentro de Hidalgo (fuera no hay terreno y la línea flotaría)
  useEffect(() => {
    if (!torres.length) return;
    const N = 240, lon: number[] = [], lat: number[] = [], start: number[] = [], len: number[] = [];
    for (const [x, y] of torres) {
      let run = 0;
      const close = () => { if (run > 1) { start.push(lon.length - run); len.push(run); } else if (run) { lon.pop(); lat.pop(); } run = 0; };
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * 2 * Math.PI, lo = x + (radio / geo.KX) * Math.cos(a), la = y + (radio / geo.KZ) * Math.sin(a);
        if (map.municipioAt(lo, la) > 0) { lon.push(lo); lat.push(la); run++; } else close();
      }
      close();
    }
    if (!len.length) return;
    const color = new Uint8Array(len.length * 4);
    for (let k = 0; k < len.length; k++) color.set([238, 241, 245, 170], k * 4);
    const h = map.addLines({ lon: Float32Array.from(lon), lat: Float32Array.from(lat), start: Uint32Array.from(start), len: Uint32Array.from(len), color, width: 1.5 });
    return () => h.dispose();
  }, [map, torres, radio, geo]);

  // torres (clic para quitarlas)
  useEffect(() => {
    if (!torres.length) return;
    const color = new Uint8Array(torres.length * 4);
    for (let k = 0; k < torres.length; k++) color.set(hexToRgba(TOWER), k * 4);
    const h = map.addPoints({
      shape: 'dot', lon: Float32Array.from(torres, p => p[0]), lat: Float32Array.from(torres, p => p[1]), color, size: 14, pickable: true,
      tooltip: i => {
        const s = vsRef.current?.sites[i];
        return { title: `Torre ${LETTERS[i]}`, lines: [`Antena de ${alto} m${s ? ` sobre un suelo a ${fmtInt(s[2])} m` : ''}`, 'Clic para quitarla'] };
      },
    });
    towersH.current = h;
    return () => { h.dispose(); towersH.current = null; };
  }, [map, torres, alto]);

  // localidades del radio: claras con línea de vista, naranjas sin ella
  useEffect(() => {
    if (!vs?.points || !loc) return;
    const P = vs.points, color = new Uint8Array(loc.n * 4), size = new Float32Array(loc.n);
    for (let i = 0; i < loc.n; i++) {
      size[i] = Math.min(10, 3 + 1.3 * Math.log10(loc.pob[i] + 1));
      if (Number.isNaN(P.lift[i])) continue;
      color.set(hexToRgba(P.bits[i] ? COVERED : NOVIEW), i * 4);
    }
    const h = map.addPoints({
      shape: 'dot', lon: loc.lon, lat: loc.lat, color, size, pickable: true,
      tooltip: i => {
        const b = P.bits[i], l = P.lift[i];
        const what = b ? `Línea de vista con ${POPC[b] === 1 ? 'la torre' : 'las torres'} ${vs.sites.map((_, k) => k).filter(k => b & (1 << k)).map(k => LETTERS[k]).join(', ')}`
          : `Sin línea de vista${l < 1000 ? `: le faltan ≈ ${fmtInt(Math.max(1, l))} m a la antena` : ''}`;
        return { title: loc.nombre[i], lines: [`${fmtInt(loc.pob[i])} hab. · ${meta.names[loc.muni[i] - 1] ?? ''}`, what, 'Clic: ver el perfil de la línea de vista'] };
      },
    });
    locsH.current = h;
    return () => { h.dispose(); locsH.current = null; };
  }, [map, vs, loc, meta]);

  // clic: torre nueva (en la cima más cercana); sobre una torre, quitarla; sobre una localidad, su línea de vista
  useEffect(() => map.onClick(hit => {
    if (hit.point && hit.point.layer === towersH.current) {
      const k = hit.point.index;
      setTorres(p => p.filter((_, i) => i !== k));
      return true;
    }
    if (hit.point && hit.point.layer === locsH.current) { setSel(hit.point.index); return true; }
    const now = performance.now(), L = lastClick.current;
    if (now - L.t < 400 && Math.hypot(hit.lon - L.lon, hit.lat - L.lat) < 0.01) return true;
    lastClick.current = { t: now, lon: hit.lon, lat: hit.lat };
    if (torres.length >= MAX) { setErr(`caben ${MAX} torres: quita una para poner otra`); return true; }
    (cima ? peak(data.terrain(), geo, hit.lon, hit.lat).catch(() => [hit.lon, hit.lat] as [number, number]) : Promise.resolve([hit.lon, hit.lat] as [number, number]))
      .then(p => setTorres(t => (t.length >= MAX ? t : [...t, p])));
    return true;
  }), [map, data, geo, cima, torres.length, setTorres]);

  // perfil de la línea de vista a la localidad elegida, desde la torre más favorable de las que la tienen en su radio
  useEffect(() => {
    if (sel < 0 || !vs || !loc) { setLos(null); return; }
    const lo = loc.lon[sel], la = loc.lat[sel];
    const cand = torres.map(([x, y], k) => ({ k, x, y, d: Math.hypot((x - lo) * geo.KX, (y - la) * geo.KZ) })).filter(t => t.d <= vs.radiusKm && t.d > 0.05);
    if (!cand.length) { setLos(null); return; }
    let alive = true;
    Promise.all(cand.map(t => data.terrain().profile([t.x, lo], [t.y, la], 30).then(p => losData(p, t.k, alto, RX[rx], loc.nombre[sel])))).then(
      list => { if (alive) setLos(list.sort((a, b) => a.lift - b.lift)[0]); },
      () => { if (alive) setLos(null); },
    );
    return () => { alive = false; };
  }, [sel, vs, loc, torres, alto, rx, data, geo]);

  useEffect(() => {
    if (sel < 0 || !loc) return;
    map.setPin(loc.nombre[sel], loc.lon[sel], loc.lat[sel]);
    return () => map.setPin(null);
  }, [map, sel, loc]);

  // ficha del cursor: qué torres se ven desde ahí
  useEffect(() => map.onHover(hit => {
    if (!vs) return null;
    const g = vs.grid, [W0, S0, E0, N0] = g.bounds;
    const c = Math.floor(((hit.lon - W0) / (E0 - W0)) * g.width), r = Math.floor(((N0 - hit.lat) / (N0 - S0)) * g.height);
    if (c < 0 || r < 0 || c >= g.width || r >= g.height) return null;
    const b = (g.data as Uint8Array)[r * g.width + c];
    if (!(b & 128)) return null;
    const ks = vs.sites.map((_, k) => k).filter(k => b & (1 << k));
    if (!ks.length) return ['Sin línea de vista con las torres'];
    const km = (k: number) => Math.hypot((vs.sites[k][0] - hit.lon) * geo.KX, (vs.sites[k][1] - hit.lat) * geo.KZ).toFixed(1);
    return [`Línea de vista con ${ks.length === 1 ? 'la torre' : 'las torres'} ${ks.map(k => `${LETTERS[k]} (${km(k)} km)`).join(', ')}`];
  }), [map, vs, geo]);

  const elegir = (id: string) => {
    const e = EJEMPLOS.find(x => x[0] === id)!;
    setTorres(e[2]); setAlto(e[3]); setRadio(e[4]); setSel(-1);
    const lon = e[2].map(p => p[0]), lat = e[2].map(p => p[1]);
    map.flyTo((Math.min(...lon) + Math.max(...lon)) / 2, (Math.min(...lat) + Math.max(...lat)) / 2, e[4] * 2.6 + (Math.max(...lon) - Math.min(...lon)) * geo.KX);
  };

  if (locErr) return <Note>No se pudieron cargar las localidades: {locErr}</Note>;
  const nt = vs?.sites.length ?? 0;
  return (
    <>
      <Section title="Torres" aside={busy ? <span className="rh-mono">calculando…</span> : undefined}>
        <Note>
          {torres.length === 0 && 'Haz clic en un cerro para poner una torre: se calcula lo que se ve desde su antena. Puedes poner hasta seis.'}
          {torres.length > 0 && `${torres.length} ${torres.length === 1 ? 'torre' : 'torres'}. Clic en el mapa: otra torre${torres.length < MAX ? '' : ' (ya no caben)'}; clic sobre una torre: quitarla; clic en una localidad: su línea de vista.`}
        </Note>
        <Chips label="Opciones" value={cima ? 'cima' : ''} onToggle={() => setCima(c => !c)} options={[['cima', 'Poner la torre en la cima más cercana (≤ 400 m)']]} />
        {EJEMPLOS.length > 0 && <Examples onPick={elegir} options={EJEMPLOS.map(([id, nombre]) => [id, nombre] as [string, string])} />}
        {torres.length > 0 && (
          <div className="rh-a-keys">
            <button type="button" className="rh-a-link" onClick={() => setTorres(p => p.slice(0, -1))}>Quitar la última torre</button>
            <button type="button" className="rh-a-link" onClick={() => { setTorres([]); setSel(-1); }}>Quitar todas</button>
          </div>
        )}
        {err && <Note>No se pudo calcular: {err}.</Note>}
        {!loc && <Loading text="Cargando localidades…" />}
      </Section>

      <Section title="Antena y receptor">
        <div className="rh-ctl">
          <div className="rh-head"><label htmlFor="rh-alto">Altura de la antena sobre el suelo</label><output htmlFor="rh-alto">{alto} m</output></div>
          <input id="rh-alto" type="range" min={5} max={150} step={5} value={alto} onChange={e => setAlto(+e.target.value)} />
        </div>
        <div className="rh-ctl">
          <div className="rh-head"><label htmlFor="rh-radio">Radio</label><output htmlFor="rh-radio">{radio} km</output></div>
          <input id="rh-radio" type="range" min={5} max={60} step={5} value={radio} onChange={e => setRadio(+e.target.value)} />
        </div>
        <Seg label="Altura del receptor" value={rx} onChange={setRx} options={[['persona', 'Persona · 1.5 m'], ['techo', 'Techo · 6 m'], ['mastil', 'Mástil · 12 m']]} />
        <Seg label="Qué mostrar" value={vista} onChange={setVista} options={[['cobertura', 'Lo que se ve'], ['sombra', 'Zonas de sombra']]} />
        {vista === 'cobertura'
          ? (nt > 1 ? <ClassLegend caption="Visible desde" colors={VIEW_RAMP} labels={['1 torre', '2 torres', '3 o más']} /> : <ClassLegend caption="Zona visible" colors={[VIEW_RAMP[0]]} labels={['Con línea de vista']} />)
          : <ClassLegend caption="Dentro del radio" colors={[NOVIEW]} labels={['Sin línea de vista']} />}
      </Section>

      {vs && cov && (
        <Section title="Cobertura">
          <p className="rh-a-lead">
            {nt === 1 ? 'La torre tiene' : `Las ${nt} torres tienen`} línea de vista con <b>{fmtKm2(cov.kmVis)} km²</b> de Hidalgo ({pct(cov.kmVis, cov.kmRadio)} de lo que queda a menos de {vs.radiusKm} km)
            {' '}y con <b>{fmtInt(cov.locs)}</b> de las {fmtInt(cov.locsRadio)} localidades del radio, donde viven <b>{fmtInt(cov.pob)}</b> personas.
          </p>
          <Stats items={[
            [pct(cov.pob, cov.pobRadio), 'Habitantes del radio con línea de vista'],
            [fmtInt(cov.sin.length), 'Localidades sin línea de vista'],
            [fmtShort(cov.pobRadio - cov.pob), 'Habitantes sin línea de vista'],
          ]} />
          <Facts items={vs.sites.map((s, k) => [`Torre ${LETTERS[k]} · ${fmtInt(s[2] + alto)} m`, `${fmtKm2(cov.porTorre[k].km)} km² · ${fmtInt(cov.porTorre[k].locs)} loc. · ${fmtShort(cov.porTorre[k].pob)} hab.`] as [string, string])} />
          {cov.sin.length > 0 && (
            <Facts items={cov.lifts.map(x => [`Antena de ${alto + x.m} m (+${x.m})`, x.locs ? `${fmtInt(x.locs)} localidades más · ${fmtShort(x.pob)} hab.` : 'ninguna más'] as [string, string])} />
          )}
        </Section>
      )}

      {los && loc && (
        <Section title={`Línea de vista a ${los.name}`} aside={<button type="button" className="rh-a-link" onClick={() => setSel(-1)}>Cerrar</button>}>
          <LosChart d={los} letter={LETTERS[los.tower]} />
          <Facts items={[
            ['Torre', `${LETTERS[los.tower]} · a ${los.km[los.km.length - 1].toFixed(1)} km`],
            ...(los.iBlock > 0 ? [[los.over > 0 ? 'Lo tapa' : 'Punto más justo', `el terreno a ${los.km[los.iBlock].toFixed(1)} km de la torre (${fmtInt(los.ground[los.iBlock])} m s. n. m.), ${fmtInt(Math.abs(los.over))} m ${los.over > 0 ? 'por encima' : 'por debajo'} de la línea`]] as [string, string][] : []),
            [los.lift <= 0 ? 'Despeje' : 'Le faltan a la antena', los.lift <= 0 ? `podría medir ${fmtInt(-los.lift)} m menos y aún vería el punto` : `≈ ${fmtInt(los.lift)} m (antena de ${fmtInt(alto + los.lift)} m)${los.lift > 150 ? ': no es práctico; conviene otra torre más cerca' : ''}`],
          ]} />
        </Section>
      )}
      {sel >= 0 && !los && vs && loc && <Note>{loc.nombre[sel]} queda fuera del radio de las torres.</Note>}

      {vs && cov && loc && cov.sin.length > 0 && (
        <Section title="Localidades más pobladas sin línea de vista">
          <Bars color={NOVIEW} onPick={id => { const i = Number(id); setSel(i); map.flyTo(loc.lon[i], loc.lat[i], 12); }}
            rows={cov.sin.slice(0, 8).map(i => ({
              id: i, value: loc.pob[i], text: `${fmtShort(loc.pob[i])} hab.`,
              label: `${loc.nombre[i]}${vs.points && vs.points.lift[i] < 200 ? ` · faltan ${fmtInt(Math.max(1, vs.points.lift[i]))} m` : ''}`,
            }))} />
        </Section>
      )}

      {vs && cov && cov.munis.length > 1 && (
        <Section title="Habitantes con línea de vista por municipio">
          <Bars color={VIEW_RAMP[1]} max={1} onPick={id => map.select(Number(id))} onHover={id => map.highlight(id === null ? 0 : Number(id))}
            rows={cov.munis.slice(0, 8).map(m => ({ id: m.id, label: meta.names[m.id - 1] ?? '', value: m.pob ? m.pobVis / m.pob : 0, text: `${pct(m.pobVis, m.pob)} de ${fmtShort(m.pob)}` }))} />
        </Section>
      )}

      <p className="rh-a-warn"><b>Es línea de vista, no un modelo de propagación.</b> No toma en cuenta la frecuencia, la potencia, la zona de Fresnel, los árboles ni los edificios: una localidad con línea de vista puede no tener señal y una sin ella puede recibirla por reflexión o difracción.</p>
      <Note>
        Calculado en el navegador con el relieve de INEGI a 30 m (90 m si las torres abarcan mucho), la curvatura de la Tierra y la
        refracción normal de la atmósfera (radio efectivo de 4/3). Las localidades del Censo 2020 cuentan por su punto, con la línea de
        vista revisada una por una; los km² son los de Hidalgo dentro del radio.
      </Note>
    </>
  );
}
