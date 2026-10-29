import { useEffect, useMemo, useState } from 'react';
import { makeGeo } from '../../shared/geo';
import type { FlowPath, Watershed } from '../../shared/terrain';
import type { Meta } from '../../shared/types';
import type { Localidades, Pendiente, RiosNombres } from '../datasets';
import { fmtInt, hexToRgba } from '../scales';
import type { AnalysisProps } from '../types';
import { Bars, Chips, Facts, Loading, Note, Section, Stats, useAsync } from '../ui';

const FILL = '#38bdf8', EDGE = '#7dd3fc', MAIN = '#ffffff', DOWN = '#ffcf7a', WATER = '#8fd3f0';
type Capa = 'cuenca' | 'contorno' | 'cauce' | 'abajo';

/** Salidas de ejemplo sobre el cauce calculado (se ajustan igual que un clic). */
const EJEMPLOS: [string, string, number, number][] = [
  ['amajac', 'Río Amajac', -98.7654, 21.2387],
  ['metztitlan', 'Laguna de Metztitlán', -98.8796, 20.7079],
  ['pachuca', 'Pachuca', -98.7637, 20.0429],
  ['tula', 'Tula en Ixmiquilpan', -99.2379, 20.5079],
];

/** Ríos que reciben el agua del valle de México por obras de drenaje (ningún modelo de relieve las ve). */
const VALLE = /tula|salado|tepeji|cuautitl|tepozotl|el salto/i;

interface Resumen {
  pend: number; p15: number; p30: number;
  munis: { id: number; pct: number }[]; fuera: number;
  locs: number; pob: number; mayores: number[];
  rios: { nombre: string; km: number }[];
  presas: string[];
  abajo: string[];
  salida: string | null;
  /** el camino río abajo sale por el sur, hacia el valle de México */
  alValle: boolean;
}

/** Cifras de la cuenca con los datos del visor: pendiente a 30 m, municipios, localidades, ríos y presas con nombre. */
function resumir(ws: Watershed, down: FlowPath, loc: Localidades, pend: Pendiente, rios: RiosNombres, meta: Meta, muni: Uint8Array): Resumen {
  const g = ws.grid, [W0, S0, E0, N0] = g.bounds, gw = g.width, gh = g.height, m = g.data;
  const dLon = (E0 - W0) / gw, dLat = (N0 - S0) / gh;
  const inside = (lon: number, lat: number) => {
    const c = Math.floor((lon - W0) / dLon), r = Math.floor((N0 - lat) / dLat);
    return c >= 0 && r >= 0 && c < gw && r < gh && m[r * gw + c] > 0;
  };
  // cada celda de 90 m cuenta con su nodo del visor (municipio y pendiente a 30 m resumida)
  const share = new Float64Array(85);
  let cells = 0, sl = 0, s15 = 0, s30 = 0, ns = 0;
  for (let r = 0; r < gh; r++) {
    const R = Math.round((meta.lat0 - (N0 - (r + 0.5) * dLat)) / meta.step);
    if (R < 0 || R >= meta.H) continue;
    for (let c = 0; c < gw; c++) {
      if (!m[r * gw + c]) continue;
      const C = Math.round((W0 + (c + 0.5) * dLon - meta.lon0) / meta.step);
      if (C < 0 || C >= meta.W) continue;
      const k = R * meta.W + C;
      cells++; share[muni[k]]++;
      if (pend.mean[k]) { sl += pend.mean[k]; s15 += pend.p15[k]; s30 += pend.p30[k]; ns++; }
    }
  }
  const munis = [...share].map((v, id) => ({ id, pct: (100 * v) / cells })).filter(x => x.id > 0 && x.pct >= 0.5).sort((a, b) => b.pct - a.pct);

  let locs = 0, pob = 0;
  const mayores: number[] = [];
  for (let i = 0; i < loc.n; i++) {
    if (!inside(loc.lon[i], loc.lat[i])) continue;
    locs++; pob += loc.pob[i];
    if (mayores.length < 3) mayores.push(i);
  }

  // ríos: la máscara es un recorte de la misma rejilla de 90 m donde están las celdas con nombre
  const f = Math.round(meta.step / dLon), wf = (meta.W - 1) * f + 1, geo = makeGeo(meta);
  const c0 = Math.round(((W0 - meta.lon0) / meta.step) * f + 0.5), r0 = Math.round(((meta.lat0 - N0) / meta.step) * f + 0.5);
  const count = new Map<number, number>();
  for (let k = 0; k < rios.n; k++) {
    const r = Math.floor(rios.cell[k] / wf) - r0, c = (rios.cell[k] % wf) - c0;
    if (r >= 0 && c >= 0 && r < gh && c < gw && m[r * gw + c]) count.set(rios.rio[k], (count.get(rios.rio[k]) ?? 0) + 1);
  }
  // pasos D8 de ≈ 1.15 celdas en promedio entre rectos y diagonales
  const cellKm = ((meta.step / f) * (geo.KX + geo.KZ)) / 2 * 1.15;
  const lista = [...count].map(([id, q]) => ({ nombre: rios.nombres[id], km: q * cellKm })).filter(x => x.km >= 2).sort((a, b) => b.km - a.km);

  // camino río abajo: los ríos por los que pasa, en orden (un nombre cuenta tras 3 celdas, para no tomar roces)
  const nameAt = (lon: number, lat: number) => {
    const j = Math.round(((meta.lat0 - lat) / meta.step) * f) * wf + Math.round(((lon - meta.lon0) / meta.step) * f);
    let lo = 0, hi = rios.n - 1;
    while (lo <= hi) { const mid = (lo + hi) >> 1, v = rios.cell[mid]; if (v === j) return rios.nombres[rios.rio[mid]]; if (v < j) lo = mid + 1; else hi = mid - 1; }
    return null;
  };
  const abajo: string[] = [], hits = new Map<string, number>();
  let salida: string | null = null;
  for (let k = 0; k < down.lon.length; k++) {
    const nm = nameAt(down.lon[k], down.lat[k]);
    if (!nm) continue;
    if (k < 15 && !salida) salida = nm;
    const q = (hits.get(nm) ?? 0) + 1;
    hits.set(nm, q);
    if (q >= 3 && abajo[abajo.length - 1] !== nm && !abajo.includes(nm)) abajo.push(nm);
  }
  const mc = ws.mainChannel;
  for (let k = mc.lon.length - 1; k >= Math.max(0, mc.lon.length - 15) && !salida; k--) salida = nameAt(mc.lon[k], mc.lat[k]);
  const end = down.lon.length - 1, south = meta.lat0 - (meta.H - 1) * meta.step;

  return {
    pend: ns ? sl / ns / 4 : NaN, p15: ns ? s15 / ns / 2 : NaN, p30: ns ? s30 / ns / 2 : NaN,
    munis, fuera: (100 * share[0]) / cells, locs, pob, mayores, rios: lista,
    presas: meta.lakeLabels.filter(l => inside(l.lon, l.lat)).map(l => l.n),
    abajo, salida, alValle: end >= 0 && down.lat[end] < south + 0.05 && down.lon[end] > -99.6 && down.lon[end] < -98.5,
  };
}

/** Camino con borde oscuro debajo, para que se lea sobre cualquier fondo (campos claros, bosque, ciudad). */
function addPath(map: AnalysisProps['ctx']['map'], p: FlowPath, color: string) {
  const line = { lon: p.lon, lat: p.lat, start: Uint32Array.of(0), len: Uint32Array.of(p.lon.length), onTop: true };
  // opaco: entre capas del mismo orden se dibuja primero la creada antes, y la línea de color queda encima
  const casing = map.addLines({ ...line, color: Uint8Array.of(12, 17, 27, 255), width: 5.5 });
  const top = map.addLines({ ...line, color: Uint8Array.from(hexToRgba(color)), width: 3 });
  return () => { top.dispose(); casing.dispose(); };
}

const fmtKm = (km: number) => (km >= 100 ? fmtInt(km) : km.toFixed(1));
const fmtArea = (a: number) => (a >= 10 ? fmtInt(a) : a.toFixed(1));

export default function Cuencas({ ctx }: AnalysisProps) {
  const { map, data, meta } = ctx;
  const [base] = useAsync(() => Promise.all([data.localidades(), data.pendiente(), data.riosNombres()]), [data]);
  const [pick, setPick] = useState<{ lon: number; lat: number; fly: boolean } | null>(null);
  const [res, setRes] = useState<{ ws: Watershed; down: FlowPath } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [capas, setCapas] = useState<Set<Capa>>(() => new Set(['cuenca', 'contorno', 'cauce', 'abajo']));
  const on = (c: Capa) => capas.has(c);

  useEffect(() => map.onClick(hit => { setPick({ lon: hit.lon, lat: hit.lat, fly: false }); return true; }), [map]);

  useEffect(() => {
    if (!pick) return;
    let alive = true;
    setBusy(true); setErr('');
    (async () => {
      const t = data.terrain(), ws = await t.watershed(pick.lon, pick.lat);
      return { ws, down: await t.flowPath(ws.outlet[0], ws.outlet[1]) };
    })().then(
      r => {
        if (!alive) return;
        setRes(r); setBusy(false);
        // de una cuenca grande se ve todo; las chicas ya están a la vista del clic
        const [W0, S0, E0, N0] = r.ws.grid.bounds, geo = makeGeo(meta), km = Math.max((E0 - W0) * geo.KX, (N0 - S0) * geo.KZ);
        if (pick.fly || km > 25) map.flyTo((W0 + E0) / 2, (S0 + N0) / 2, Math.max(10, km * 1.25));
      },
      e => { if (alive) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); } },
    );
    return () => { alive = false; };
  }, [pick, data, map, meta]);

  const info = useMemo(() => (res && base ? resumir(res.ws, res.down, base[0], base[1], base[2], meta, map.municipioGrid()) : null), [res, base, meta, map]);

  // capas en el mapa
  const cuencaOn = on('cuenca'), contornoOn = on('contorno'), cauceOn = on('cauce'), abajoOn = on('abajo');
  useEffect(() => {
    if (!res || !cuencaOn) return;
    const g = res.ws.grid;
    const h = map.addRaster({ kind: 'categorical', bounds: g.bounds, width: g.width, height: g.height, data: g.data, palette: [null, FILL], opacity: 0.5 });
    return () => h.dispose();
  }, [map, res, cuencaOn]);
  useEffect(() => {
    if (!res || !contornoOn) return;
    const o = res.ws.outline, color = new Uint8Array(o.start.length * 4);
    for (let k = 0; k < o.start.length; k++) color.set(hexToRgba(EDGE), k * 4);
    const h = map.addLines({ ...o, color, width: 2 });
    return () => h.dispose();
  }, [map, res, contornoOn]);
  useEffect(() => {
    if (!res || !cauceOn || res.ws.mainChannel.lon.length < 2) return;
    return addPath(map, res.ws.mainChannel, MAIN);
  }, [map, res, cauceOn]);
  useEffect(() => {
    if (!res || !abajoOn || res.down.lon.length < 2) return;
    return addPath(map, res.down, DOWN);
  }, [map, res, abajoOn]);
  useEffect(() => {
    if (!res) return;
    map.setPin(info?.salida ?? 'Salida de la cuenca', res.ws.outlet[0], res.ws.outlet[1]);
    return () => map.setPin(null);
  }, [map, res, info]);

  useEffect(() => map.onHover(hit => {
    if (!res) return null;
    const g = res.ws.grid, [W0, S0, E0, N0] = g.bounds;
    const c = Math.floor(((hit.lon - W0) / (E0 - W0)) * g.width), r = Math.floor(((N0 - hit.lat) / (N0 - S0)) * g.height);
    const dentro = c >= 0 && r >= 0 && c < g.width && r < g.height && g.data[r * g.width + c] > 0;
    return [dentro ? 'Dentro de la cuenca: su lluvia escurre a la salida' : 'Fuera de la cuenca'];
  }), [map, res]);

  const ws = res?.ws;
  return (
    <>
      <Section title="Punto de salida" aside={busy ? <span className="rh-mono">calculando…</span> : undefined}>
        {!ws && <Note>Haz clic sobre un río o en cualquier punto: se ilumina el área cuya lluvia escurre hasta ahí (su cuenca), con el cauce principal y el camino que sigue el agua río abajo.</Note>}
        <Chips label="Ejemplos" value="" onToggle={id => { const e = EJEMPLOS.find(x => x[0] === id)!; setPick({ lon: e[2], lat: e[3], fly: true }); }} options={EJEMPLOS.map(([id, nombre]) => [id, nombre] as [string, string])} />
        {err && <Note>No se pudo calcular la cuenca: {err}</Note>}
      </Section>

      {ws && (
        <Section title="La cuenca">
          <p className="rh-a-lead">El agua de <b>{fmtArea(ws.areaKm2)} km²</b> llega a este punto{info?.salida ? <> del <b>{info.salida}</b></> : ''}.</p>
          <Stats items={[
            [`${fmtInt(ws.elev.max - ws.elev.min)} m`, 'Desnivel'],
            [`${fmtKm(ws.mainChannel.km)} km`, 'Cauce principal'],
            [info ? `${info.pend.toFixed(1)}°` : '…', 'Pendiente media (a 30 m)'],
          ]} />
          {info ? (
            <Facts items={[
              ['Altitud máxima', `${fmtInt(ws.elev.max)} m`],
              ['Altitud de la salida', `${fmtInt(ws.elev.min)} m`],
              ['Terreno con más de 15°', `${info.p15.toFixed(0)} %`],
              ['Con más de 30°', `${info.p30.toFixed(0)} %`],
              ['Habitantes (2020)', fmtInt(info.pob)],
              ['Localidades', fmtInt(info.locs)],
            ]} />
          ) : <Loading text="Cargando localidades y pendientes…" />}
          {info && info.mayores.length > 0 && base && <Note>Mayores localidades: {info.mayores.map(i => `${base[0].nombre[i]} (${fmtInt(base[0].pob[i])})`).join(', ')}.</Note>}
          {ws.truncated && (
            <p className="rh-a-warn">
              <b>Cuenca incompleta:</b> parte del área que drena aquí queda fuera del rectángulo que cubre el mapa, así que la cuenca real es mayor.
              {info?.rios.some(r => VALLE.test(r.nombre)) && ' Además, el río Tula recibe el agua del valle de México por el Emisor Central, el Emisor Oriente y el Gran Canal, obras que ningún modelo de relieve ve: aquí la cuenca real es mucho mayor que la calculada.'}
            </p>
          )}
        </Section>
      )}

      {ws && info && info.munis.length > 0 && (
        <Section title="Municipios en la cuenca" aside={<span className="rh-mono">% del área</span>}>
          <Bars color={FILL} rows={info.munis.slice(0, 8).map(x => ({ id: x.id, label: meta.names[x.id - 1], value: x.pct, text: `${x.pct.toFixed(x.pct < 10 ? 1 : 0)} %` }))}
            onPick={id => map.select(Number(id), true)} onHover={id => map.highlight(id === null ? 0 : Number(id))} />
          {info.fuera >= 0.5 && <Note>{info.fuera.toFixed(info.fuera < 10 ? 1 : 0)} % de la cuenca está en estados vecinos.</Note>}
        </Section>
      )}

      {ws && info && (info.rios.length > 0 || info.presas.length > 0) && (
        <Section title="Ríos y presas con nombre" aside={info.rios.length > 0 ? <span className="rh-mono">km en la cuenca</span> : undefined}>
          {info.rios.length > 0 && <Bars color={WATER} rows={info.rios.slice(0, 8).map((r, k) => ({ id: k, label: r.nombre, value: r.km, text: `≈ ${fmtKm(r.km)} km` }))} />}
          {info.presas.length > 0 && <Note>Presas y lagos: {info.presas.join(', ')}.</Note>}
        </Section>
      )}

      {res && info && (
        <Section title="Río abajo">
          <p className="rh-a-lead">{info.abajo.length ? info.abajo.join(' → ') : 'Por cauces sin nombre en OpenStreetMap'}<span className="rh-a-note"> · sale de la zona del mapa a {fmtKm(res.down.km)} km</span></p>
          {info.alValle && <Note>Este punto drena hacia el valle de México, que desagua por obras (Gran Canal, Emisor Central, Emisor Oriente) al río Tula: su agua regresa a Hidalgo por el Salto y Tula.</Note>}
        </Section>
      )}

      {ws && (
        <Section title="Capas">
          <Chips label="Capas de la cuenca" value={capas} onToggle={c => setCapas(s => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; })}
            options={[['cuenca', 'Cuenca'], ['contorno', 'Contorno'], ['cauce', 'Cauce principal'], ['abajo', 'Río abajo']]} />
          <div className="rh-a-keys">
            <span className="rh-a-road"><i style={{ background: FILL }} />cuenca</span>
            <span className="rh-a-road"><i style={{ background: MAIN }} />cauce principal (el camino de flujo más largo)</span>
            <span className="rh-a-road"><i style={{ background: DOWN }} />camino del agua río abajo</span>
          </div>
        </Section>
      )}

      <Note>Calculada con la dirección del flujo a 90 m sobre el relieve de INEGI, guiada por los ríos de OpenStreetMap; el clic se ajusta al cauce más cercano (hasta 300 m). Es drenaje superficial: no cuenta canales, túneles ni bombeo, y en las cuencas cerradas (Tecocomulco, Apan) el relleno de la depresión les asigna una salida.</Note>
    </>
  );
}
