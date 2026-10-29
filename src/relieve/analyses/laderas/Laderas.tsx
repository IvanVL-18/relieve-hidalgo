import { useEffect, useMemo, useState } from 'react';
import { makeGeo } from '../../shared/geo';
import { COBERTURA, LLUVIA, PENDIENTE, ROCAS, desempacar, puntos } from '../../shared/laderas';
import type { Meta } from '../../shared/types';
import type { RoadLines } from '../accesibilidad/router';
import type { Laderas as LaderasData, Localidades } from '../datasets';
import { fmtInt, hexToRgba } from '../scales';
import type { AnalysisProps } from '../types';
import { Bars, Chips, ClassLegend, Facts, Loading, Note, Section, Seg, useAsync } from '../ui';

type Vista = 'indice' | 'atlas' | 'comparar' | 'pendiente' | 'lluvia' | 'roca' | 'cobertura';

/** Clases 1–5 (muy baja → muy alta); la muy baja casi no se pinta para que el mapa se siga leyendo. */
const COLORES = ['rgba(238, 241, 245, 0.14)', '#fde68a', '#fbbf24', '#f97316', '#dc2626'];
const PALETA = [null, null, 'rgba(253, 230, 138, 0.55)', COLORES[2], COLORES[3], COLORES[4]];
const SOLO_ALTA = [null, null, null, null, COLORES[3], COLORES[4]];
/** zonas de peligro por deslizamiento del atlas estatal de Hidalgo (CENAPRED) */
const ZONA = '#f97316';
const PALETA_ZONA = [null, ZONA];
/** Roca y cobertura: azul si restan puntos, de amarillo a ámbar según cuánto suman (pendiente y lluvia: la escala por clase). */
const RESTA = '#60a5fa';
const sumaColor = (p: number) => (p < 0 ? RESTA : p === 0 ? COLORES[0] : p <= 1 ? COLORES[1] : p <= 2 ? COLORES[2] : p <= 4 ? COLORES[3] : COLORES[4]);
const ROCA_GRUPOS: [number, string][] = [[-1, 'Roca dura · −1'], [0, 'Intermedia · 0'], [1, 'Poco consolidada · +1'], [2, 'Lutitas y limolitas · +2']];
const signo = (p: number) => (p > 0 ? `+${p}` : p < 0 ? `−${-p}` : '0');
/** radio para «laderas cerca» de una localidad */
const CERCA_KM = 0.3;

/** Valor de la rejilla de CHIRPS en un punto (bilineal entre centros de celda, como en build-laderas). */
function lluviaEn(l: LaderasData['lluvia'], g: (number | null)[], lon: number, lat: number) {
  const fx = Math.min(l.cols - 1.001, Math.max(0, (lon - l.lon0) / l.step - 0.5)), fy = Math.min(l.rows - 1.001, Math.max(0, (l.lat0 - lat) / l.step - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, i = y0 * l.cols + x0;
  const v = [g[i], g[i + 1], g[i + l.cols], g[i + l.cols + 1]];
  if (v.some(x => x === null)) return null;
  const [a, b, c, d] = v as number[];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

interface Resumen {
  /** km² por municipio (0 = Hidalgo) y clase 1–5 */
  km2: Float64Array[];
  /** km² por municipio en zonas de peligro del atlas estatal, y de ellas en alta o muy alta del índice */
  zona: Float64Array; ambos: Float64Array;
  /** km² en alta o muy alta por municipio y tipo de roca */
  roca: Float64Array[];
  /** por localidad: clase en su centro y la más alta a menos de 300 m */
  centro: Uint8Array; cerca: Uint8Array;
}

function resumir(l: LaderasData, loc: Localidades, muni: Uint8Array, meta: Meta): Resumen {
  const geo = makeGeo(meta), pxKm2 = ((meta.step / l.f) * geo.KX) * ((meta.step / l.f) * geo.KZ);
  const km2 = Array.from({ length: 85 }, () => new Float64Array(6)), zona = new Float64Array(85), ambos = new Float64Array(85);
  const roca = Array.from({ length: 85 }, () => new Float64Array(ROCAS.length));
  for (let y = 0; y < l.h; y++) {
    const row = Math.round((y + 0.5) / l.f) * meta.W;
    for (let x = 0; x < l.w; x++) {
      const i = y * l.w + x, k = l.clase[i], m = muni[row + Math.round((x + 0.5) / l.f)];
      if (!k || !m) continue;
      const alta = k >= 4, z = l.zona[i];
      for (const j of [0, m]) {
        km2[j][k] += pxKm2;
        if (z) { zona[j] += pxKm2; if (alta) ambos[j] += pxKm2; }
        if (alta && l.p1[i]) roca[j][l.p1[i] - 1] += pxKm2;
      }
    }
  }
  const centro = new Uint8Array(loc.n), cerca = new Uint8Array(loc.n), R = Math.ceil(CERCA_KM / ((meta.step / l.f) * geo.KZ));
  for (let i = 0; i < loc.n; i++) {
    const x0 = Math.floor(((loc.lon[i] - meta.lon0) / meta.step) * l.f), y0 = Math.floor(((meta.lat0 - loc.lat[i]) / meta.step) * l.f);
    if (x0 < 0 || y0 < 0 || x0 >= l.w || y0 >= l.h) continue;
    centro[i] = l.clase[y0 * l.w + x0];
    let mx = 0;
    for (let y = Math.max(0, y0 - R); y <= Math.min(l.h - 1, y0 + R); y++) for (let x = Math.max(0, x0 - R); x <= Math.min(l.w - 1, x0 + R); x++) {
      if ((x - x0) ** 2 + (y - y0) ** 2 <= R * R && l.clase[y * l.w + x] > mx) mx = l.clase[y * l.w + x];
    }
    cerca[i] = mx;
  }
  return { km2, zona, ambos, roca, centro, cerca };
}

/** km de vías dentro de Hidalgo (o del municipio) que cruzan laderas de susceptibilidad alta o muy alta. */
function viasEnAlta(v: RoadLines, l: LaderasData, muni: Uint8Array, meta: Meta) {
  const geo = makeGeo(meta), out = new Float64Array(85);
  for (let e = 0; e < v.start.length; e++) for (let k = v.start[e]; k + 1 < v.start[e] + v.len[e]; k++) {
    const lo = (v.lon[k] + v.lon[k + 1]) / 2, la = (v.lat[k] + v.lat[k + 1]) / 2;
    const x = Math.floor(((lo - meta.lon0) / meta.step) * l.f), y = Math.floor(((meta.lat0 - la) / meta.step) * l.f);
    if (x < 0 || y < 0 || x >= l.w || y >= l.h || l.clase[y * l.w + x] < 4) continue;
    const m = muni[Math.round((meta.lat0 - la) / meta.step) * meta.W + Math.round((lo - meta.lon0) / meta.step)];
    if (!m) continue;
    const d = Math.hypot((v.lon[k + 1] - v.lon[k]) * geo.KX, (v.lat[k + 1] - v.lat[k]) * geo.KZ);
    out[m] += d; out[0] += d;
  }
  return out;
}

/**
 * Validación con los deslizamientos del atlas estatal: proporción de deslizamientos en cada clase entre la proporción del
 * área (razón de frecuencia; > 1 = más deslizamientos de los que tocarían por su área), y cuántos caen en las zonas de
 * peligro del mismo atlas.
 */
function validar(l: LaderasData, meta: Meta, res: Resumen) {
  const pxOf = (lon: number, lat: number) => Math.floor(((meta.lat0 - lat) / meta.step) * l.f) * l.w + Math.floor(((lon - meta.lon0) / meta.step) * l.f);
  const enClase = new Float64Array(6);
  let n = 0, enZona = 0;
  for (const p of l.historicos) {
    const i = pxOf(p.lon, p.lat), k = l.clase[i];
    if (!k) continue;
    n++; enClase[k]++; enZona += l.zona[i];
  }
  const area = res.km2[0], tot = area.reduce((s, v) => s + v, 0);
  return {
    n,
    clase: [1, 2, 3, 4, 5].map(k => ({ k, pctEv: (100 * enClase[k]) / n, pctArea: (100 * area[k]) / tot })),
    altaEv: (100 * (enClase[4] + enClase[5])) / n, altaArea: (100 * (area[4] + area[5])) / tot,
    zonaEv: (100 * enZona) / n, zonaArea: (100 * res.zona[0]) / tot,
  };
}

const km = (v: number) => (v >= 100 ? fmtInt(v) : v.toFixed(1));
const pc = (a: number, b: number) => `${((100 * a) / Math.max(1e-9, b)).toFixed(0)} %`;

export default function Laderas({ ctx }: AnalysisProps) {
  const { map, data, meta } = ctx;
  const [base, err] = useAsync(() => Promise.all([data.laderas(), data.localidades()]), [data]);
  const [muni, setMuni] = useState(0);
  const [vista, setVista] = useState<Vista>('indice');
  const [solo, setSolo] = useState(false);
  const [eventosOn, setEventosOn] = useState(true);
  const [zonasOn, setZonasOn] = useState(false);
  const [vias, setVias] = useState<Float64Array | null>(null);
  const res = useMemo(() => (base ? resumir(base[0], base[1], map.municipioGrid(), meta) : null), [base, map, meta]);
  const val = useMemo(() => (base && res ? validar(base[0], meta, res) : null), [base, res, meta]);

  // capa: índice, zonas del atlas estatal, ambos con cortina o lo que suma cada factor
  useEffect(() => {
    if (!base) return;
    const l = base[0], g = meta, bounds: [number, number, number, number] = [g.lon0, g.lat0 - (g.H - 1) * g.step, g.lon0 + (g.W - 1) * g.step, g.lat0];
    const raster = (d: Uint8Array, palette: (string | null)[], side?: 'left' | 'right') => map.addRaster({ kind: 'categorical', bounds, width: l.w, height: l.h, data: d, palette, opacity: 0.85, side });
    const indice = solo ? SOLO_ALTA : PALETA;
    if (vista === 'comparar') {
      const a = raster(l.clase, indice, 'left'), b = raster(l.zona, PALETA_ZONA, 'right'), c = map.compare({ labels: ['Índice propio', 'Atlas estatal'] });
      return () => { c.dispose(); b.dispose(); a.dispose(); };
    }
    let r;
    if (vista === 'indice') r = raster(l.clase, indice);
    else if (vista === 'atlas') r = raster(l.zona, PALETA_ZONA);
    else if (vista === 'pendiente') r = raster(l.p0.map((v, i) => (l.clase[i] ? ((v >> 3) & 7) + 1 : 0)), [null, ...COLORES]);
    else if (vista === 'lluvia') r = raster(l.p2.map((v, i) => (l.clase[i] ? v & 7 : 0)), [null, ...COLORES]);
    else if (vista === 'roca') r = raster(l.p1.map((v, i) => (l.clase[i] ? v : 0)), [null, ...ROCAS.map(x => sumaColor(x.puntos))]);
    else r = raster(l.p0.map((v, i) => (l.clase[i] ? (v >> 6) + 1 : 0)), [null, ...COBERTURA.map(x => sumaColor(x.puntos))]);
    return () => r.dispose();
  }, [map, base, vista, solo, meta]);

  // deslizamientos registrados: atlas estatal (CENAPRED) en blanco y catálogo de la NASA en lila
  useEffect(() => {
    if (!base || !eventosOn) return;
    const [l] = base, hs = l.historicos, ev = l.eventos, n = hs.length + ev.length, color = new Uint8Array(n * 4);
    for (let k = 0; k < n; k++) color.set(hexToRgba(k < hs.length ? '#ffffff' : '#c4b5fd'), k * 4);
    const enMapa = (lon: number, lat: number) => {
      const i = Math.floor(((meta.lat0 - lat) / meta.step) * l.f) * l.w + Math.floor(((lon - meta.lon0) / meta.step) * l.f);
      return `Índice propio: ${l.clase[i] ? l.clases[l.clase[i] - 1].toLowerCase() : 'sin dato'}${l.zona[i] ? ' · en una zona de peligro del atlas' : ''}`;
    };
    const h = map.addPoints({
      shape: 'dot', lon: Float32Array.from([...hs, ...ev], e => e.lon), lat: Float32Array.from([...hs, ...ev], e => e.lat), color, size: 7, pickable: true,
      tooltip: k => {
        if (k < hs.length) {
          const p = hs[k], nota = p.nota.length > 150 ? `${p.nota.slice(0, 147)}…` : p.nota;
          return { title: `Deslizamiento · ${p.fecha}`, lines: [...(nota ? [nota] : []), `Atlas estatal (CENAPRED): peligro ${p.nivel.toLowerCase()}, roca ${p.roca.toLowerCase()}`, enMapa(p.lon, p.lat)] };
        }
        const e = ev[k - hs.length];
        return { title: `Deslizamiento · ${e.fecha} (NASA)`, lines: [e.lugar, `Ubicación con precisión de ${e.precision === 'unknown' ? 'desconocida' : e.precision}`, ...(e.muertes ? [`${e.muertes} muertes`] : [])] };
      },
    });
    return () => h.dispose();
  }, [map, base, eventosOn, meta]);

  // zonas de peligro por deslizamiento del atlas estatal
  useEffect(() => {
    if (!base || !zonasOn) return;
    const z = base[0].zonas, len = Uint32Array.from(z, r => r.length + 1), start = new Uint32Array(z.length);
    for (let k = 1; k < z.length; k++) start[k] = start[k - 1] + len[k - 1];
    const pts = z.flatMap(r => [...r, r[0]]), color = new Uint8Array(z.length * 4);
    for (let k = 0; k < z.length; k++) color.set(hexToRgba('#ffffff'), k * 4);
    const h = map.addLines({ lon: Float32Array.from(pts, p => p[0]), lat: Float32Array.from(pts, p => p[1]), start, len, color, onTop: true, width: 2 });
    return () => h.dispose();
  }, [map, base, zonasOn]);

  // tramos de carretera sobre laderas de susceptibilidad alta (la red se carga aparte: worker de rutas)
  useEffect(() => {
    if (!base) return;
    let alive = true;
    data.router().ready.then(r => { if (alive) setVias(viasEnAlta(r.lines, base[0], map.municipioGrid(), meta)); }, () => undefined);
    return () => { alive = false; };
  }, [base, data, map, meta]);

  // desglose de puntos del píxel bajo el cursor
  useEffect(() => map.onHover(hit => {
    if (!base) return null;
    const [l] = base, x = Math.floor(((hit.lon - meta.lon0) / meta.step) * l.f), y = Math.floor(((meta.lat0 - hit.lat) / meta.step) * l.f);
    if (x < 0 || y < 0 || x >= l.w || y >= l.h) return null;
    const i = y * l.w + x, d = desempacar(l.p0[i], l.p1[i], l.p2[i]);
    if (!d.clase) return null;
    const pts = puntos(d.pendiente, d.lluvia, d.roca, d.cobertura), mm = lluviaEn(l.lluvia, l.lluvia.rx5, hit.lon, hit.lat), mm10 = lluviaEn(l.lluvia, l.lluvia.rx10, hit.lon, hit.lat);
    const roca = d.roca >= 0 ? ROCAS[d.roca] : null;
    return [
      `Susceptibilidad ${l.clases[d.clase - 1].toLowerCase()} (${signo(pts)} puntos${d.pendiente === 0 && d.clase <= 2 ? '; en lo plano, a lo más baja' : ''})`,
      `Pendiente ${PENDIENTE.etiquetas[d.pendiente]}: ${signo(PENDIENTE.peso * d.pendiente)}`,
      `Lluvia máx. en 5 días ≈ ${mm === null ? '—' : Math.round(mm)} mm (una vez cada 10 años: ${mm10 === null ? '—' : Math.round(mm10)}): ${signo(d.lluvia)}`,
      `Roca: ${roca ? `${roca.tipo.toLowerCase()}: ${signo(roca.puntos)}` : 'sin dato: 0'}`,
      `Cobertura: ${COBERTURA[d.cobertura].nombre.toLowerCase()}: ${signo(COBERTURA[d.cobertura].puntos)}`,
      ...(d.zona ? ['Zona de peligro por deslizamiento del atlas estatal (CENAPRED)'] : []),
    ];
  }), [map, base, meta]);

  useEffect(() => map.onClick(hit => { setMuni(hit.municipio); return false; }), [map]);

  if (err) return <Note>No se pudo cargar la susceptibilidad de laderas: {err}</Note>;
  if (!base || !res || !val) return <Loading text="Cargando susceptibilidad de laderas…" />;
  const [l, loc] = base, k = res.km2[muni], tot = k.reduce((s, v) => s + v, 0), alta = k[4] + k[5], nombre = muni ? meta.names[muni - 1] : 'Hidalgo';
  // localidades del ámbito con laderas altas en su centro o a menos de 300 m
  let nCentro = 0, pCentro = 0, nCerca = 0, pCerca = 0;
  const top: number[] = [];
  for (let i = 0; i < loc.n; i++) {
    if (muni && loc.muni[i] !== muni) continue;
    if (res.centro[i] >= 4) { nCentro++; pCentro += loc.pob[i]; if (top.length < 5) top.push(i); }
    else if (res.cerca[i] >= 4) { nCerca++; pCerca += loc.pob[i]; }
  }
  const ranking = Array.from({ length: 84 }, (_, i) => { const m = res.km2[i + 1], t = m.reduce((s, v) => s + v, 0); return { id: i + 1, pct: t ? (100 * (m[4] + m[5])) / t : 0 }; })
    .sort((a, b) => b.pct - a.pct).slice(0, 8);
  const rocas = ROCAS.map((r, i) => ({ id: i, label: r.tipo, value: res.roca[muni][i], text: `${km(res.roca[muni][i])} km² · ${signo(r.puntos)}`, color: sumaColor(r.puntos) }))
    .filter(r => r.value >= 0.5).sort((a, b) => b.value - a.value).slice(0, 6);
  const factor = vista === 'pendiente' || vista === 'lluvia' || vista === 'roca' || vista === 'cobertura';

  return (
    <>
      <Section title="Mapa">
        <Seg label="Mapa de susceptibilidad" value={vista} onChange={setVista} options={[['indice', 'Índice propio'], ['atlas', 'Atlas estatal'], ['comparar', 'Comparar']]} />
        <Seg label="Lo que suma cada factor" value={vista} onChange={setVista} options={[['pendiente', 'Pendiente'], ['lluvia', 'Lluvia'], ['roca', 'Roca'], ['cobertura', 'Cobertura']]} />
        {vista === 'indice' && <ClassLegend colors={COLORES} labels={l.clases} />}
        {vista === 'atlas' && <ClassLegend colors={[ZONA]} labels={['Zona de peligro por deslizamiento']} caption="Atlas estatal de Hidalgo en el Atlas Nacional de Riesgos (CENAPRED)" />}
        {vista === 'comparar' && <Note>Arrastra la cortina: a la izquierda el índice propio, a la derecha las zonas de peligro por deslizamiento del atlas estatal (CENAPRED). El atlas marca tramos estudiados (sobre todo caminos y poblados de la Sierra), no todo el estado.</Note>}
        {vista === 'pendiente' && <ClassLegend colors={COLORES} labels={PENDIENTE.etiquetas.map((e, k) => `${e} · ${signo(PENDIENTE.peso * k)}`)} caption="Pendiente media a 30 m" />}
        {vista === 'lluvia' && <ClassLegend colors={COLORES} labels={LLUVIA.etiquetas.map((e, k) => `${e} · ${signo(k)}`)} caption={`Lluvia máxima en 5 días, promedio de cada año ${l.lluvia.anios[0]}–${l.lluvia.anios[1]} (CHIRPS)`} />}
        {vista === 'roca' && <ClassLegend colors={ROCA_GRUPOS.map(([p]) => sumaColor(p))} labels={ROCA_GRUPOS.map(([, t]) => t)} caption="Tipo de roca (INEGI 1:250 000)" />}
        {vista === 'cobertura' && <ClassLegend colors={COBERTURA.map(x => sumaColor(x.puntos))} labels={COBERTURA.map(x => `${x.nombre} · ${signo(x.puntos)}`)} caption="Uso de suelo y vegetación (Serie VII)" />}
        <Chips label="Capas de laderas" value={new Set([...(solo ? ['solo'] : []), ...(eventosOn ? ['eventos'] : []), ...(zonasOn ? ['zonas'] : [])])}
          onToggle={v => (v === 'solo' ? setSolo(!solo) : v === 'eventos' ? setEventosOn(!eventosOn) : setZonasOn(!zonasOn))}
          options={[...(factor || vista === 'atlas' ? [] : [['solo', 'Solo alta y muy alta']] as ['solo', string][]), ['eventos', `Deslizamientos registrados (${l.historicos.length + l.eventos.length})`], ['zonas', 'Zonas del atlas estatal']]} />
      </Section>

      <Section title={nombre} aside={muni ? <button type="button" className="rh-a-link" onClick={() => setMuni(0)}>Todo el estado</button> : <span className="rh-mono">clic: un municipio</span>}>
        <p className="rh-a-lead"><b>{km(alta)} km²</b> ({((100 * alta) / Math.max(1e-9, tot)).toFixed(1)} % de {muni ? 'su territorio' : 'el estado'}) tienen susceptibilidad alta o muy alta en el índice propio.</p>
        <Facts items={[
          ['Localidades en ladera alta', fmtInt(nCentro)],
          ['Habitantes en ellas', fmtInt(pCentro)],
          ['Con ladera alta a < 300 m', fmtInt(nCerca)],
          ['Habitantes (a < 300 m)', fmtInt(pCerca)],
          ['Carreteras sobre ladera alta', vias ? `${km(vias[muni])} km` : 'cargando…'],
          ['Zonas de peligro del atlas estatal', `${km(res.zona[muni])} km²`],
          ['De ellas, alta o muy alta en el índice', res.zona[muni] ? pc(res.ambos[muni], res.zona[muni]) : '—'],
        ]} />
        {top.length > 0 && <Note>Más pobladas con ladera alta en su centro: {top.map(i => `${loc.nombre[i]} (${fmtInt(loc.pob[i])})`).join(', ')}.</Note>}
        {rocas.length > 0 && (
          <>
            <div className="rh-mono">Roca de las laderas altas</div>
            <Bars color={COLORES[3]} rows={rocas} />
          </>
        )}
      </Section>

      {!muni && (
        <Section title="¿Coincide con los deslizamientos registrados?" aside={<span className="rh-mono">{fmtInt(val.n)} del atlas estatal</span>}>
          <p className="rh-a-lead">El <b>{val.altaEv.toFixed(0)} %</b> de los deslizamientos registrados en 2008 y 2009 cayó en laderas alta o muy alta del índice, que ocupan el {val.altaArea.toFixed(0)} % del estado; dentro de las zonas de peligro del mismo atlas, el {val.zonaEv.toFixed(0)} % (en el {val.zonaArea.toFixed(1)} % del estado).</p>
          <Bars color={COLORES[3]} rows={val.clase.map(x => ({ id: x.k, label: l.clases[x.k - 1], value: x.pctEv / Math.max(1e-9, x.pctArea), text: `${(x.pctEv / Math.max(1e-9, x.pctArea)).toFixed(1)}× · ${x.pctEv.toFixed(0)} % de los deslizamientos`, color: COLORES[x.k - 1] }))} />
          <Note>Razón de frecuencia: la parte de los deslizamientos que cae en cada clase entre la parte del estado que ocupa (1× = lo esperado por su área). Los registros están junto a caminos y poblados, donde alguien los reporta, y tienen la ubicación del reporte. Las zonas del atlas se trazaron con esos mismos reportes, así que no se validan entre sí.</Note>
        </Section>
      )}

      {!muni && (
        <Section title="Municipios con más laderas susceptibles" aside={<span className="rh-mono">% alta o muy alta</span>}>
          <Bars color={COLORES[3]} rows={ranking.map(x => ({ id: x.id, label: meta.names[x.id - 1], value: x.pct, text: `${x.pct.toFixed(0)} %` }))}
            onPick={id => { setMuni(Number(id)); map.select(Number(id), true); }} onHover={id => map.highlight(id === null ? 0 : Number(id))} />
        </Section>
      )}

      <p className="rh-a-warn"><b>Es susceptibilidad, no riesgo ni pronóstico:</b> indica dónde el terreno es más propenso a deslizarse, no cuándo. El índice propio suma pendiente a 30 m, lluvia intensa, tipo de roca y cobertura vegetal; no sustituye al Mapa Nacional de Susceptibilidad del CENAPRED, que aún no se publica para Hidalgo.</p>
      <Note>Puntos: 2 × pendiente (&lt; 10°, 10–20, 20–30, 30–40, &gt; 40°) + lluvia máxima en 5 días (&lt; 60 mm, 60–100, 100–150, 150–200, &gt; 200; CHIRPS {l.lluvia.anios[0]}–{l.lluvia.anios[1]}) + roca (−1 dura a +2 lutitas; INEGI 1:250 000) + cobertura (−1 bosque o selva primarios a +1 agricultura, pastizal o suelo desnudo). Muy baja ≤ 2, baja 3–4, media 5–6, alta 7–8, muy alta ≥ 9. Pasa el cursor para ver los puntos de cada lugar. Deslizamientos: atlas estatal de Hidalgo en el CENAPRED (2008–2009) y catálogo de la NASA (ubicación con kilómetros de error).</Note>
    </>
  );
}
