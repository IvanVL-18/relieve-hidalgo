import { useMemo, useRef, useState } from 'react';
import { RelieveHidalgo, decodeViewState, viewStateUrl, type MunicipioInfo, type ReadyInfo, type RelieveApi, type ViewState } from './relieve';
import type { ReliefEngine } from './relieve/engine/Engine';
import meta from './relieve/data/meta.json';

/** En desarrollo deja el motor en window.__rh para scripts/screenshot.mjs. */
const debugHooks = import.meta.env.DEV
  ? {
      debug: true,
      onEngine: (e: ReliefEngine) => Object.assign(window, { __rh: e }),
      onReady: (i: ReadyInfo) => Object.assign(window, { __rhTimings: i.timings }),
    }
  : {};

/** La URL sigue a la vista (como en un mapa web): reemplaza la entrada del historial, no agrega una por movimiento. */
const keepUrl = (s: ViewState) => history.replaceState(history.state, '', viewStateUrl(location.href, s));

/**
 * Pantalla completa, como el artefacto. La URL guarda la vista (enlaces a vistas, shared/enlaces.ts): ?vista=lon,lat,km,
 * inclinación,rumbo · ?mapa=satelite|altitud · ?hora=19.5 · ?exag=3 · ?nubes=auto|cumulos|nublado|niebla|tormenta|no ·
 * ?mun=13048 · ?analisis=accesibilidad (con sus parámetros a.*). Además: ?quieto · ?embed · ?lapso (nubes en movimiento) ·
 * ?kiosco (recorrido guiado en bucle para un módulo táctil) · ?escuelas (interfaz simplificada para clase)
 */
export function App() {
  const qs = new URLSearchParams(location.search);
  if (qs.has('embed')) return <EmbedDemo />;
  const mode = qs.has('kiosco') ? 'kiosco' : qs.has('escuelas') ? 'escuelas' : 'normal';
  return (
    <RelieveHidalgo
      style={{ position: 'fixed', inset: 0, height: 'auto' }}
      mode={mode}
      initialView={decodeViewState(location.search)}
      // en el kiosco la URL no cambia (se recarga igual si alguien la toca)
      onViewChange={mode === 'kiosco' ? undefined : keepUrl}
      initialClouds={qs.has('lapso') ? { play: true } : undefined}
      autoRotate={!qs.has('quieto')}
      {...debugHooks}
    />
  );
}

/** Quintiles de un indicador → paleta secuencial (demo con la superficie de cada municipio). */
function quintileColors(values: number[], codes: string[]) {
  const palette = ['#2d1e4f', '#5b2a7a', '#9a3f72', '#d9674e', '#f6b04a'];
  const sorted = [...values].sort((a, b) => a - b);
  const cuts = [0.2, 0.4, 0.6, 0.8].map(q => sorted[Math.floor(q * (sorted.length - 1))]);
  return Object.fromEntries(codes.map((c, i) => [c, palette[cuts.filter(t => values[i] > t).length]]));
}

function EmbedDemo() {
  const api = useRef<RelieveApi>(null);
  const [sel, setSel] = useState<MunicipioInfo | null>(null);
  const [choro, setChoro] = useState(false);
  const colors = useMemo(() => quintileColors(meta.cent.map(c => c[2]), meta.codes), []);
  return (
    <main className="demo">
      <h1>Laboratorio · Demo de integración</h1>
      <p>
        El mapa es un componente React normal: llena su contenedor, se pausa cuando sale de la pantalla y la rueda del
        ratón solo acerca con <kbd>Ctrl</kbd> para no robarle el scroll a la página.
      </p>
      <div className="demo-actions">
        <button type="button" onClick={() => setChoro(!choro)}>{choro ? 'Quitar indicador' : 'Colorear por superficie municipal'}</button>
        <button type="button" onClick={() => api.current?.flyToMunicipio('13048')}>Ir a Pachuca de Soto</button>
        <button type="button" onClick={() => api.current?.goHome()}>Vista inicial</button>
        <span>{sel ? `Seleccionado: ${sel.name} (${sel.code})` : 'Haz clic en un municipio'}</span>
      </div>
      <div className="demo-map">
        <RelieveHidalgo
          ref={api}
          cooperativeGestures
          autoRotate={false}
          municipioColors={choro ? colors : null}
          onSelectMunicipio={setSel}
          {...debugHooks}
        />
      </div>
      {Array.from({ length: 4 }, (_, i) => (
        <p key={i} className="demo-filler">
          Contenido de la página del laboratorio para probar el desplazamiento. Al bajar, el relieve deja de dibujarse y no
          consume GPU; al volver, continúa donde se quedó.
        </p>
      ))}
    </main>
  );
}
