import { useEffect, useMemo, useState } from 'react';
import type { FlowPath } from '../../shared/terrain';
import type { RiosNombres } from '../datasets';
import { CLIMA_COLORS, PROVINCIA_COLORS, REGION_COLORS, TOPOFORMA_COLORS, fmtInt, hexToRgba } from '../scales';
import type { AnalysisProps } from '../types';
import { Facts, Loading, Note, Seg, oneOf, useAsync, useLinked } from '../ui';
import TEMAS from './temas.json';

type Tema = 'regiones' | 'relieve' | 'clima' | 'agua' | 'preguntas';
type Capa = 'provincia' | 'topoforma';
interface Ir { tema?: string; region?: string; capa?: string; volar?: string }
interface Pregunta { q: string; op: string[]; ok: number; por: string; ir?: Ir }

const T = TEMAS as {
  aviso: string;
  regiones: Record<string, { color: number; texto: string }>;
  provincias: Record<string, string>;
  topoformas: Record<string, string>;
  climas: { temperatura: string; humedad: string };
  agua: string[];
  preguntas: Pregunta[];
};
const COLORS: Record<'clima' | Capa, Record<string, string>> = { clima: CLIMA_COLORS, provincia: PROVINCIA_COLORS, topoforma: TOPOFORMA_COLORS };
const DIM = '#3a404c';
const WATER = '#4fb3ff';
const PRISMAS: [number, number] = [-98.5634, 20.2345];

/** Ríos con nombre por los que pasa un camino del agua (como en Cuencas: cada nombre cuenta tras 3 celdas). */
function riversAlong(p: FlowPath, rios: RiosNombres, lon0: number, lat0: number, step: number, W: number) {
  const f = 3, wf = (W - 1) * f + 1, out: string[] = [], hits = new Map<string, number>();
  const nameAt = (lon: number, lat: number) => {
    const j = Math.round(((lat0 - lat) / step) * f) * wf + Math.round(((lon - lon0) / step) * f);
    let lo = 0, hi = rios.n - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1, v = rios.cell[mid]; if (v === j) return rios.nombres[rios.rio[mid]]; if (v < j) lo = mid + 1; else hi = mid - 1; }
    return null;
  };
  for (let k = 0; k < p.lon.length; k++) {
    const nm = nameAt(p.lon[k], p.lat[k]);
    if (!nm) continue;
    const q = (hits.get(nm) ?? 0) + 1;
    hits.set(nm, q);
    if (q >= 3 && !out.includes(nm)) out.push(nm);
  }
  return out;
}

export default function Escuelas({ ctx }: AnalysisProps) {
  const { map, meta, link, scene, data } = ctx;
  const [d, error] = useAsync(() => data.escuelas(), [data]);
  const [tema, setTema] = useLinked<Tema>(link, 'tema', 'regiones', oneOf('regiones', 'relieve', 'clima', 'agua', 'preguntas'));
  const [regionId, setRegionId] = useLinked<string>(link, 'region', '', s => (s in T.regiones ? s : undefined));
  const [capa, setCapa] = useLinked<Capa>(link, 'capa', 'provincia', oneOf('provincia', 'topoforma'));
  const [clase, setClase] = useState<string | null>(null);
  // capa que muestra «Ver en el mapa» sin salir de las preguntas
  const [quizLayer, setQuizLayer] = useState<'clima' | Capa | null>(null);
  const region = d?.regiones.find(r => r.id === regionId) ?? null;
  // municipio → región
  const regionOf = useMemo(() => {
    const a = new Int8Array(85).fill(-1);
    d?.regiones.forEach((r, k) => r.municipios.forEach(m => { a[m] = k; }));
    return a;
  }, [d]);
  const bounds = useMemo<[number, number, number, number]>(() => [meta.lon0, meta.lat0 - (meta.H - 1) * meta.step, meta.lon0 + (meta.W - 1) * meta.step, meta.lat0], [meta]);
  useEffect(() => { setClase(null); }, [tema, capa]);

  // regiones: municipios con el color de su región (con una elegida, las demás apagadas)
  useEffect(() => {
    if (!d || (tema !== 'regiones' && !(tema === 'preguntas' && region))) { map.setMunicipioFill(null); return; }
    const colors: Record<number, string> = {};
    d.regiones.forEach(r => {
      const c = REGION_COLORS[T.regiones[r.id]?.color ?? 0];
      for (const m of r.municipios) colors[m] = !region || region.id === r.id ? c : DIM;
    });
    map.setMunicipioFill(colors, 0.6);
  }, [map, d, tema, region]);

  // relieve y clima: capa de clases de INEGI
  const plane: 'clima' | Capa | null = tema === 'clima' ? 'clima' : tema === 'relieve' ? capa : tema === 'preguntas' ? quizLayer : null;
  useEffect(() => {
    if (!d || !plane) return;
    const cls = d.clases[plane], pal = [null, ...cls.map(c => (clase && c.nombre !== clase ? DIM : COLORS[plane][c.nombre] ?? '#888888'))];
    const r = map.addRaster({ kind: 'categorical', bounds, width: d.w, height: d.h, data: d[plane], palette: pal, opacity: 0.82 });
    return () => r.dispose();
  }, [map, d, plane, clase, bounds]);

  // ficha del cursor: región, clima o forma del relieve
  useEffect(() => map.onHover(hit => {
    if (!d) return null;
    if (tema === 'regiones') { const k = regionOf[hit.municipio]; return k >= 0 ? [`Región ${d.regiones[k].nombre}`] : null; }
    if (!plane) return null;
    const x = Math.floor(((hit.lon - meta.lon0) / meta.step) * 2), y = Math.floor(((meta.lat0 - hit.lat) / meta.step) * 2);
    if (x < 0 || y < 0 || x >= d.w || y >= d.h) return null;
    const v = d[plane][y * d.w + x], c = v ? d.clases[plane][v - 1] : null;
    return c ? [plane === 'clima' ? `Clima ${c.nombre.toLowerCase()}${c.claves?.length ? ` (${c.claves.slice(0, 2).join(', ')})` : ''}` : c.nombre] : null;
  }), [map, d, tema, plane, regionOf, meta]);

  // agua: ¿a dónde va la lluvia que cae en un punto?
  const [rios] = useAsync(() => (tema === 'agua' ? data.riosNombres() : Promise.resolve(null)), [data, tema === 'agua']);
  const [gota, setGota] = useState<{ lon: number; lat: number; path: FlowPath | null; error?: string } | null>(null);
  useEffect(() => { if (tema === 'agua') scene.set({ layers: { water: true } }); }, [tema, scene]);
  useEffect(() => map.onClick(hit => {
    if (!d) return;
    if (tema === 'agua') {
      setGota({ lon: hit.lon, lat: hit.lat, path: null });
      data.terrain().flowPath(hit.lon, hit.lat, 900).then(path => setGota({ lon: hit.lon, lat: hit.lat, path }), e => setGota({ lon: hit.lon, lat: hit.lat, path: null, error: String(e?.message ?? e) }));
      return true;
    }
    if (tema === 'regiones') { const k = regionOf[hit.municipio]; if (k >= 0) { setRegionId(d.regiones[k].id); return true; } }
  }), [map, d, tema, regionOf, data, setRegionId]);
  useEffect(() => {
    if (tema !== 'agua' || !gota?.path || gota.path.lon.length < 2) return;
    const p = gota.path, line = { lon: p.lon, lat: p.lat, start: Uint32Array.of(0), len: Uint32Array.of(p.lon.length), onTop: true };
    const casing = map.addLines({ ...line, color: Uint8Array.of(12, 17, 27, 255), width: 6 });
    const top = map.addLines({ ...line, color: Uint8Array.from(hexToRgba(WATER)), width: 3.5 });
    return () => { top.dispose(); casing.dispose(); };
  }, [map, tema, gota]);
  useEffect(() => {
    if (tema === 'agua' && gota) map.setPin('Gota de lluvia', gota.lon, gota.lat);
    else if (tema !== 'preguntas') map.setPin(null);
  }, [map, tema, gota]);

  // preguntas
  const [qi, setQi] = useState(0);
  const [answer, setAnswer] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const pregunta = T.preguntas[qi];
  const answerQ = (k: number) => { if (answer !== null) return; setAnswer(k); if (k === pregunta.ok) setScore(s => s + 1); };
  const next = () => { setAnswer(null); setQi(i => i + 1); setQuizLayer(null); setRegionId(''); map.setPin(null); };
  const go = (ir: Ir) => {
    if (ir.volar === 'cima') { const [lon, lat, m] = meta.relief.peak; map.setPin(`Punto más alto · ${fmtInt(m)} m`, lon, lat); map.flyTo(lon, lat, 14); return; }
    if (ir.volar === 'prismas') { map.setPin('Prismas Basálticos', ...PRISMAS); map.flyTo(...PRISMAS, 8); return; }
    const inQuiz = tema === 'preguntas';
    if (ir.capa === 'provincia' || ir.capa === 'topoforma') { setCapa(ir.capa); if (inQuiz) setQuizLayer(ir.capa); }
    if (ir.tema === 'clima' && inQuiz) setQuizLayer('clima');
    if (ir.region) { setRegionId(ir.region); flyRegion(ir.region); }
    else if (inQuiz && (ir.capa || ir.tema === 'clima' || ir.tema === 'regiones')) map.flyTo(-98.86, 20.47, 260);
    // agua no se puede mostrar desde las preguntas: se cambia de tema
    if (ir.tema && (!inQuiz || ir.tema === 'agua' || (ir.tema === 'regiones' && !ir.region))) setTema(ir.tema as Tema);
  };
  const flyRegion = (id: string) => {
    const r = d?.regiones.find(x => x.id === id);
    if (!r) return;
    let lon = 0, lat = 0, wsum = 0;
    for (const m of r.municipios) { const [cl, ct, n] = meta.cent[m - 1]; lon += cl * n; lat += ct * n; wsum += n; }
    map.flyTo(lon / wsum, lat / wsum, Math.max(40, Math.sqrt(r.km2) * 2.2));
  };

  if (error) return <p className="rh-a-warn">{error}</p>;
  if (!d) return <Loading />;
  const shown = (p: 'clima' | Capa) => d.clases[p].map((c, k) => ({ ...c, k })).filter(c => c.km2 > 0).sort((a, b) => b.km2 - a.km2);
  const legend = (p: 'clima' | Capa) => (
    <ul className="rh-edu-legend">
      {shown(p).map(c => (
        <li key={c.nombre}>
          <button type="button" aria-pressed={clase === c.nombre} onClick={() => setClase(clase === c.nombre ? null : c.nombre)}>
            <i style={{ background: COLORS[p][c.nombre] }} />
            <span>{c.nombre}{p === 'clima' && c.claves?.length ? <small> · {c.claves.slice(0, 3).join(', ')}</small> : null}</span>
            <b>{c.pct.toLocaleString('es-MX')} %</b>
          </button>
        </li>
      ))}
    </ul>
  );
  const gotaRios = gota?.path && rios ? riversAlong(gota.path, rios, meta.lon0, meta.lat0, meta.step, meta.W) : [];
  const gotaFin = (() => {
    const p = gota?.path;
    if (!p || p.lon.length < 2) return '';
    const lon = p.lon[p.lon.length - 1], lat = p.lat[p.lat.length - 1], e = 0.03;
    const W0 = meta.lon0, E0 = meta.lon0 + (meta.W - 1) * meta.step, N0 = meta.lat0, S0 = meta.lat0 - (meta.H - 1) * meta.step;
    if (lat < S0 + e) return 'Sale del mapa por el sur, hacia el valle de México.';
    if (lon > E0 - e || lat > N0 - e) return 'Sale del mapa rumbo a Veracruz y San Luis Potosí: sigue hacia el golfo de México.';
    if (lon < W0 + e) return 'Sale del mapa hacia Querétaro.';
    return 'Termina en una laguna o en un llano sin salida dentro del mapa.';
  })();

  return (
    <>
      <Seg label="Tema" value={tema} onChange={setTema} options={[['regiones', 'Regiones'], ['relieve', 'Relieve'], ['clima', 'Clima'], ['agua', 'Agua'], ['preguntas', 'Preguntas']]} />

      {tema === 'regiones' && (
        <>
          <p className="rh-a-lead">Hidalgo se divide en <b>10 regiones</b> que comparten paisaje, clima y cultura. Toca una en el mapa o en la lista.</p>
          {region ? (
            <section className="rh-edu-card">
              <div className="rh-mono">Región geocultural</div>
              <h4>{region.nombre}</h4>
              <p>{T.regiones[region.id]?.texto}</p>
              <Facts items={[
                ['Municipios', String(region.municipios.length)], ['Habitantes (2020)', fmtInt(region.pob)], ['Superficie', `${fmtInt(region.km2)} km²`],
                ['Clima que más ocupa', d.clases.clima[region.clima]?.nombre ?? '—'], ['Provincia del relieve', d.clases.provincia[region.provincia]?.nombre ?? '—'], ['Forma del relieve', d.clases.topoforma[region.topoforma]?.nombre ?? '—'],
              ]} />
              <Note>{region.municipios.map(m => meta.names[m - 1]).join(', ')}.</Note>
              <div className="rh-geo-actions">
                <button type="button" className="rh-a-btn" onClick={() => flyRegion(region.id)}>Ver la región</button>
                <button type="button" className="rh-a-btn rh-a-btn2" onClick={() => setRegionId('')} aria-label="Ver todas">✕</button>
              </div>
            </section>
          ) : null}
          <ul className="rh-edu-legend">
            {d.regiones.map(r => (
              <li key={r.id}>
                <button type="button" aria-pressed={r.id === regionId} onClick={() => { setRegionId(r.id === regionId ? '' : r.id); if (r.id !== regionId) flyRegion(r.id); }}>
                  <i style={{ background: REGION_COLORS[T.regiones[r.id]?.color ?? 0] }} />
                  <span>{r.nombre}</span>
                  <b>{r.municipios.length} mun.</b>
                </button>
              </li>
            ))}
          </ul>
          <Note>{d.nota} Fuente: Secretaría de Cultura del Estado de Hidalgo (2019).</Note>
        </>
      )}

      {tema === 'relieve' && (
        <>
          <p className="rh-a-lead">El relieve son las formas del terreno. En Hidalgo se juntan dos grandes <b>provincias</b>: la Sierra Madre Oriental y el Eje Neovolcánico.</p>
          <Seg label="Capa" value={capa} onChange={setCapa} options={[['provincia', 'Provincias'], ['topoforma', 'Formas del relieve']]} />
          {legend(capa)}
          {clase && <section className="rh-edu-card"><h4>{clase}</h4><p>{(capa === 'provincia' ? T.provincias : T.topoformas)[clase] ?? ''}</p></section>}
          {!clase && <Note>Toca una clase de la lista para verla sola en el mapa y leer qué es.</Note>}
          <div className="rh-toggles" role="group" aria-label="Lugares">
            <button type="button" onClick={() => go({ volar: 'cima' })}>Punto más alto · {fmtInt(meta.relief.max)} m</button>
            <button type="button" onClick={() => go({ volar: 'prismas' })}>Prismas Basálticos</button>
          </div>
          <Note>Fuente: INEGI, provincias fisiográficas y sistemas de topoformas, escala 1:1 000 000.</Note>
        </>
      )}

      {tema === 'clima' && (
        <>
          <p className="rh-a-lead">El clima depende de la altura, de la lluvia y de dónde vienen los vientos húmedos del golfo de México.</p>
          {legend('clima')}
          <Note>{T.climas.temperatura} {T.climas.humedad}</Note>
          <Note>Las claves entre paréntesis son las del sistema de Köppen modificado por Enriqueta García. Fuente: INEGI, unidades climáticas 1:1 000 000.</Note>
        </>
      )}

      {tema === 'agua' && (
        <>
          <p className="rh-a-lead"><b>¿A dónde va la lluvia?</b> Toca cualquier punto del mapa y sigue el camino de una gota hasta que sale del estado.</p>
          {gota && (
            <section className="rh-edu-card" aria-live="polite">
              {!gota.path && !gota.error && <Loading text="Siguiendo el agua…" />}
              {gota.error && <p className="rh-a-warn">{gota.error}</p>}
              {gota.path && (
                <>
                  <h4>{gota.path.km < 0.5 ? 'Aquí el agua no corre' : `Recorre ${fmtInt(gota.path.km)} km`}</h4>
                  <p>{gotaRios.length ? `Pasa por: ${gotaRios.join(' → ')}.` : 'Va por arroyos y barrancas sin nombre en el mapa.'} {gotaFin}</p>
                </>
              )}
            </section>
          )}
          {T.agua.map((t, i) => <Note key={i}>{t}</Note>)}
          <Note>El camino se calcula con el relieve de 90 m: el agua siempre baja hacia la celda vecina más baja.</Note>
        </>
      )}

      {tema === 'preguntas' && (
        qi >= T.preguntas.length ? (
          <section className="rh-edu-card">
            <h4>¡Terminaste!</h4>
            <p>Acertaste <b>{score}</b> de {T.preguntas.length} preguntas.</p>
            <button type="button" className="rh-a-btn" onClick={() => { setQi(0); setScore(0); setAnswer(null); }}>Volver a empezar</button>
          </section>
        ) : (
          <section className="rh-edu-quiz" aria-live="polite">
            <div className="rh-mono">Pregunta {qi + 1} de {T.preguntas.length} · {score} aciertos</div>
            <h4>{pregunta.q}</h4>
            <div className="rh-edu-options">
              {pregunta.op.map((o, k) => (
                <button key={k} type="button" disabled={answer !== null}
                  className={answer === null ? '' : k === pregunta.ok ? 'ok' : k === answer ? 'no' : ''} onClick={() => answerQ(k)}>
                  {answer !== null && k === pregunta.ok && <span aria-hidden="true">✓ </span>}
                  {answer === k && k !== pregunta.ok && <span aria-hidden="true">✗ </span>}
                  {o}
                </button>
              ))}
            </div>
            {answer !== null && (
              <>
                <p><b>{answer === pregunta.ok ? '¡Correcto!' : `La respuesta es: ${pregunta.op[pregunta.ok]}.`}</b> {pregunta.por}</p>
                <div className="rh-geo-actions">
                  <button type="button" className="rh-a-btn" onClick={next}>{qi + 1 < T.preguntas.length ? 'Siguiente' : 'Ver resultado'}</button>
                  {pregunta.ir && <button type="button" className="rh-a-btn rh-a-btn2 rh-edu-see" onClick={() => go(pregunta.ir!)}>Ver en el mapa</button>}
                </div>
              </>
            )}
          </section>
        )
      )}

      <Note>{T.aviso}</Note>
    </>
  );
}
