import { useEffect, useMemo, useState } from 'react';
import { makeGeo } from '../../shared/geo';
import type { Meta } from '../../shared/types';
import { USV_GROUPS } from '../../shared/usv';
import type { UsoSuelo } from '../datasets';
import { fmtInt } from '../scales';
import type { AnalysisProps } from '../types';
import { Bars, Facts, Loading, Note, Section, Seg, useAsync } from '../ui';

type Modo = 'cambios' | 'comparar';
const ETIQUETAS: [string, string] = ['Serie VI · 2014', 'Serie VII · 2018'];

/** Transiciones entre series (índice = valor de la capa; 0 = sin dato). */
const TRANS = [
  { id: 'nodata', nombre: 'Sin dato', color: null },
  { id: 'igual', nombre: 'Sin cambio', color: 'rgba(16, 20, 28, 0.55)' },
  { id: 'defor', nombre: 'Pérdida de bosque o selva', color: '#e8553d' },
  { id: 'matorral', nombre: 'Pérdida de matorral u otra vegetación', color: '#f2a541' },
  { id: 'urbano', nombre: 'Urbanización', color: '#c04dd8' },
  { id: 'degrada', nombre: 'Degradación (a vegetación secundaria)', color: '#f6e05e' },
  { id: 'recupera', nombre: 'Recuperación de vegetación', color: '#3fb26f' },
  { id: 'otro', nombre: 'Otros cambios', color: '#7fa6c9' },
] as const;

/** Grupos de USV_GROUPS reunidos en 6 para la matriz. */
const G = Object.fromEntries(USV_GROUPS.map((g, i) => [g.id, i])) as Record<string, number>;
const MACRO = ['Bosque y selva', 'Matorral y otra veg.', 'Agricultura', 'Pastizal', 'Urbano', 'Agua y sin veg.'];
const macroOf = (g: number) =>
  g === G.conifera || g === G.encino || g === G.mesofilo || g === G.selva ? 0
  : g === G.matorral || g === G.otra ? 1
  : g === G.temporal || g === G.riego ? 2
  : g === G.pastizal ? 3
  : g === G.urbano ? 4 : 5;

/** Categoría de cambio entre una clase de la Serie VI (grupo, secundaria) y una de la VII. */
function transicion(g6: number, s6: boolean, g7: number, s7: boolean) {
  const m6 = macroOf(g6), m7 = macroOf(g7), natural6 = m6 <= 1, natural7 = m7 <= 1, abierto7 = m7 === 2 || m7 === 3 || g7 === G.sinveg;
  if (g6 === g7 && s6 === s7) return 1;
  if (m7 === 4 && m6 !== 4) return 4;
  if (m6 === 0 && abierto7) return 2;
  if (m6 === 1 && abierto7) return 3;
  if ((g6 === g7 && !s6 && s7) || (m6 === 0 && m7 === 1)) return 5;
  if ((!natural6 && natural7) || (g6 === g7 && s6 && !s7) || (m6 === 1 && m7 === 0)) return 6;
  return 7;
}

interface Resumen {
  /** categoría de cambio por píxel (la capa) */
  capa: Uint8Array;
  /** km² por municipio (0 = todo Hidalgo) y categoría */
  km2: Float64Array[];
  /** matriz 6 × 6 (VI → VII) en km² por municipio (0 = todo Hidalgo) */
  matriz: Float64Array[];
}

/** Cruce de las dos series en la rejilla de ≈ 65 m; cada píxel cuenta en el municipio de su nodo del visor. */
function cruzar(s6: UsoSuelo, s7: UsoSuelo, muni: Uint8Array, meta: Meta): Resumen {
  const { w, h, f } = s7, geo = makeGeo(meta), pxKm2 = ((meta.step / f) * geo.KX) * ((meta.step / f) * geo.KZ);
  const capa = new Uint8Array(w * h), km2 = Array.from({ length: 85 }, () => new Float64Array(TRANS.length)), matriz = Array.from({ length: 85 }, () => new Float64Array(36));
  // transición por par de clases, una sola vez
  const tabla = new Uint8Array(256 * 256), macro = new Uint8Array(256 * 256);
  s6.clases.forEach((a, i) => s7.clases.forEach((b, j) => {
    tabla[(i + 1) * 256 + j + 1] = transicion(a.grupo, a.sec, b.grupo, b.sec);
    macro[(i + 1) * 256 + j + 1] = macroOf(a.grupo) * 6 + macroOf(b.grupo);
  }));
  for (let y = 0; y < h; y++) {
    const row = Math.round((y + 0.5) / f) * meta.W;
    for (let x = 0; x < w; x++) {
      const i = y * w + x, a = s6.clase[i], b = s7.clase[i];
      if (!a || !b) continue;
      const t = tabla[a * 256 + b], m = muni[row + Math.round((x + 0.5) / f)];
      capa[i] = t;
      if (!m) continue;
      km2[m][t] += pxKm2; km2[0][t] += pxKm2;
      matriz[m][macro[a * 256 + b]] += pxKm2; matriz[0][macro[a * 256 + b]] += pxKm2;
    }
  }
  return { capa, km2, matriz };
}

/** Color de cada clase como en el mapa base: el de su grupo; la vegetación secundaria, más clara y apagada. */
function paletaClases(s: UsoSuelo) {
  return [null, ...s.clases.map(c => {
    const n = parseInt(USV_GROUPS[c.grupo].color.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (c.sec) { r = r * 0.62 + 168 * 0.38; g = g * 0.62 + 170 * 0.38; b = b * 0.62 + 128 * 0.38; }
    return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
  })];
}

const km = (v: number) => (v >= 100 ? fmtInt(v) : v >= 10 ? v.toFixed(0) : v.toFixed(1));

export default function CambioUso({ ctx }: AnalysisProps) {
  const { map, data, meta } = ctx;
  const [series, err] = useAsync(() => Promise.all([data.usv6(), data.usv()]), [data]);
  const [modo, setModo] = useState<Modo>('cambios');
  const [muni, setMuni] = useState(0);
  const [punto, setPunto] = useState<{ a: string; b: string } | null>(null);
  const res = useMemo(() => (series ? cruzar(series[0], series[1], map.municipioGrid(), meta) : null), [series, map, meta]);

  // capa: cambios (categorías) o la Serie VI a la izquierda de la cortina, con la VII como mapa base a la derecha
  useEffect(() => {
    if (!series || !res) return;
    const [s6] = series, g = meta, bounds: [number, number, number, number] = [g.lon0, g.lat0 - (g.H - 1) * g.step, g.lon0 + (g.W - 1) * g.step, g.lat0];
    if (modo === 'cambios') {
      const r = map.addRaster({ kind: 'categorical', bounds, width: s6.w, height: s6.h, data: res.capa, palette: TRANS.map(t => t.color), opacity: 0.9 });
      return () => r.dispose();
    }
    const r = map.addRaster({ kind: 'categorical', bounds, width: s6.w, height: s6.h, data: s6.clase, palette: paletaClases(s6), opacity: 1, side: 'left' });
    const c = map.compare({ base: 'usodesuelo', labels: ETIQUETAS });
    return () => { c.dispose(); r.dispose(); };
  }, [map, series, res, modo, meta]);

  useEffect(() => map.onHover(hit => {
    if (!series) return null;
    const [s6, s7] = series, x = Math.floor(((hit.lon - meta.lon0) / meta.step) * s7.f), y = Math.floor(((meta.lat0 - hit.lat) / meta.step) * s7.f);
    if (x < 0 || y < 0 || x >= s7.w || y >= s7.h) return null;
    const a = s6.clase[y * s6.w + x], b = s7.clase[y * s7.w + x];
    if (!a || !b) return null;
    return a === b || s6.clases[a - 1].clave === s7.clases[b - 1].clave
      ? [`Sin cambio: ${s7.clases[b - 1].nombre}`]
      : [`2014: ${s6.clases[a - 1].nombre}`, `2018: ${s7.clases[b - 1].nombre}`];
  }), [map, series, meta]);

  useEffect(() => map.onClick(hit => {
    setMuni(hit.municipio);
    if (series) {
      const [s6, s7] = series, x = Math.floor(((hit.lon - meta.lon0) / meta.step) * s7.f), y = Math.floor(((meta.lat0 - hit.lat) / meta.step) * s7.f);
      const a = s6.clase[y * s6.w + x], b = s7.clase[y * s7.w + x];
      setPunto(a && b ? { a: s6.clases[a - 1].nombre, b: s7.clases[b - 1].nombre } : null);
    }
    return false;
  }), [map, series, meta]);

  if (err) return <Note>No se pudieron cargar las series de uso de suelo: {err}</Note>;
  if (!series || !res) return <Loading text="Cargando las series VI y VII de uso de suelo…" />;

  const k = res.km2[muni], mat = res.matriz[muni], total = k.reduce((s, v) => s + v, 0), nombre = muni ? meta.names[muni - 1] : 'Hidalgo';
  const bosque6 = mat.slice(0, 6).reduce((s, v) => s + v, 0), cambio = total - k[1];
  const perdida = Array.from({ length: 84 }, (_, i) => ({ id: i + 1, v: res.km2[i + 1][2], pct: (100 * res.km2[i + 1][2]) / Math.max(1e-9, res.matriz[i + 1].slice(0, 6).reduce((s, v) => s + v, 0)) }))
    .filter(x => x.v > 0.05).sort((a, b) => b.v - a.v).slice(0, 8);

  return (
    <>
      <Section title="Vista">
        <Seg label="Vista" value={modo} onChange={setModo} options={[['cambios', 'Cambios'], ['comparar', 'Comparar con cortina']]} />
        {modo === 'cambios'
          ? <div className="rh-a-keys">{TRANS.slice(2).map(t => <span key={t.id} className="rh-a-road rh-a-sw"><i style={{ background: t.color as string }} />{t.nombre}</span>)}</div>
          : <Note>Arrastra la cortina: a la izquierda la Serie VI (2014), a la derecha la Serie VII (2018), con los mismos colores del mapa base.</Note>}
      </Section>

      <Section title={nombre} aside={muni ? <button type="button" className="rh-a-link" onClick={() => { setMuni(0); setPunto(null); }}>Todo el estado</button> : <span className="rh-mono">clic: un municipio</span>}>
        <p className="rh-a-lead">Entre 2014 y 2018 cambió el uso de <b>{km(cambio)} km²</b> ({((100 * cambio) / Math.max(1e-9, total)).toFixed(1)} % de {muni ? 'su territorio' : 'el estado'}); <b>{km(k[2])} km²</b> de bosque o selva pasaron a agricultura, pastizal o suelo desnudo ({((100 * k[2]) / Math.max(1e-9, bosque6)).toFixed(1)} % del bosque y la selva de 2014).</p>
        <Facts items={TRANS.slice(2).map(t => [t.nombre, `${km(k[TRANS.indexOf(t)])} km²`] as [string, string])} />
        {punto && <Note>En el punto del clic: <b>{punto.a}</b> en 2014 → <b>{punto.b}</b> en 2018.</Note>}
      </Section>

      <Section title="Matriz de cambio" aside={<span className="rh-mono">km² · filas 2014, columnas 2018</span>}>
        <div className="rh-a-matrix" role="table" aria-label={`Matriz de cambio de uso de suelo de ${nombre}, en km²`}>
          <div role="row"><span role="columnheader" />{MACRO.map(m => <span key={m} role="columnheader">{m}</span>)}</div>
          {MACRO.map((m, i) => (
            <div key={m} role="row">
              <span role="rowheader">{m}</span>
              {MACRO.map((_, j) => <span key={j} role="cell" className={i === j ? 'rh-a-diag' : mat[i * 6 + j] >= 1 ? 'rh-a-hot' : undefined}>{mat[i * 6 + j] >= 0.05 ? km(mat[i * 6 + j]) : '·'}</span>)}
            </div>
          ))}
        </div>
      </Section>

      {!muni && perdida.length > 0 && (
        <Section title="Municipios con más pérdida de bosque y selva" aside={<span className="rh-mono">km²</span>}>
          <Bars color={TRANS[2].color} rows={perdida.map(x => ({ id: x.id, label: meta.names[x.id - 1], value: x.v, text: `${km(x.v)} (${x.pct.toFixed(1)} %)` }))}
            onPick={id => { setMuni(Number(id)); map.select(Number(id), true); }} onHover={id => map.highlight(id === null ? 0 : Number(id))} />
        </Section>
      )}

      <p className="rh-a-warn"><b>Ojo con la escala:</b> las series son 1:250 000 (el polígono más chico mide unas 50 ha), así que los cambios pequeños no se ven, y parte de las diferencias entre series son de interpretación de las imágenes, no cambios reales en el terreno.</p>
      <Note>Para cambios finos, complementar con la pérdida anual de cobertura arbórea de Global Forest Change (Hansen, Universidad de Maryland; 30 m, CC BY 4.0).</Note>
    </>
  );
}
