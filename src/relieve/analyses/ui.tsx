import { useEffect, useState, type ReactNode } from 'react';

/** Piezas comunes de los paneles de análisis. Estilos en relieve.css (prefijo rh-a-). */

export function Section({ title, children, aside }: { title?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rh-a-sec">
      {title && <div className="rh-a-sechead"><h3>{title}</h3>{aside}</div>}
      {children}
    </section>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="rh-seg" role="radiogroup" aria-label={label} style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map(([v, t]) => <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}>{t}</button>)}
    </div>
  );
}

export function Chips<T extends string>({ value, options, onToggle, label }: { value: Set<T> | T; options: [T, string][]; onToggle: (v: T) => void; label: string }) {
  const on = (v: T) => (value instanceof Set ? value.has(v) : value === v);
  return (
    <div className="rh-toggles" role="group" aria-label={label}>
      {options.map(([v, t]) => <button key={v} type="button" aria-pressed={on(v)} onClick={() => onToggle(v)}>{t}</button>)}
    </div>
  );
}

/** Leyenda de clases ordenadas: bloques contiguos con su etiqueta debajo. */
export function ClassLegend({ colors, labels, caption }: { colors: string[]; labels: string[]; caption?: string }) {
  return (
    <div className="rh-a-legend">
      {caption && <div className="rh-mono">{caption}</div>}
      <div className="rh-a-classes" style={{ gridTemplateColumns: `repeat(${colors.length}, 1fr)` }}>
        {colors.map((c, i) => <div key={i}><i style={{ background: c }} /><span>{labels[i]}</span></div>)}
      </div>
    </div>
  );
}

export function Stats({ items }: { items: [string, string][] }) {
  return <div className="rh-a-stats">{items.map(([v, l]) => <div key={l}><b>{v}</b><span>{l}</span></div>)}</div>;
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return <dl className="rh-a-facts">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

/** Barras horizontales delgadas con la cifra a la derecha; filas señalables. */
export function Bars({ rows, max, color, onPick, onHover }: {
  rows: { id: string | number; label: string; value: number; text: string; color?: string }[];
  max?: number; color: string;
  onPick?: (id: string | number) => void; onHover?: (id: string | number | null) => void;
}) {
  const m = max ?? Math.max(...rows.map(r => r.value), 1);
  return (
    <ul className="rh-a-bars">
      {rows.map(r => (
        <li key={r.id}>
          <button type="button" onClick={() => onPick?.(r.id)} onPointerEnter={() => onHover?.(r.id)} onPointerLeave={() => onHover?.(null)} onFocus={() => onHover?.(r.id)} onBlur={() => onHover?.(null)}>
            <span className="rh-a-blabel">{r.label}</span>
            <span className="rh-a-bval">{r.text}</span>
            <span className="rh-a-btrack"><i style={{ width: `${Math.max(1, (100 * r.value) / m)}%`, background: r.color ?? color }} /></span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Note({ children }: { children: ReactNode }) { return <p className="rh-a-note">{children}</p>; }

export function Loading({ text = 'Cargando datos…' }: { text?: string }) {
  return <div className="rh-a-loading"><span className="rh-spinner" aria-hidden="true" />{text}</div>;
}

/** Carga asíncrona con estado: [dato, error]. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, string | null] {
  const [state, set] = useState<[T | null, string | null]>([null, null]);
  useEffect(() => {
    let alive = true;
    set([null, null]);
    fn().then(v => alive && set([v, null]), e => alive && set([null, e instanceof Error ? e.message : String(e)]));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
