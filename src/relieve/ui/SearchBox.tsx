import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { SearchItem } from '../engine/search';
import { IconSearch } from './icons';

interface Props {
  disabled: boolean;
  search: (q: string) => SearchItem[];
  onChoose: (r: SearchItem) => void;
  /** cambia cuando el índice crece (localidades y colonias que llegan después del arranque) */
  version?: number;
}

export function SearchBox({ disabled, search, onChoose, version }: Props) {
  const id = useId();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchItem[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);

  // si el índice crece mientras hay una búsqueda escrita, se rehace sin abrir ni cerrar la lista
  useEffect(() => {
    if (!q.trim()) return;
    const r = search(q);
    setResults(r);
    setActive(r.length ? 0 : -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const update = (value: string) => {
    setQ(value);
    const r = value.trim() ? search(value) : [];
    setResults(r);
    setActive(r.length ? 0 : -1);
    setOpen(!!value.trim());
  };
  const choose = (r: SearchItem) => {
    setQ(r.n);
    setOpen(false);
    onChoose(r);
    (document.activeElement as HTMLElement | null)?.blur();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && results.length) { setActive((active + 1) % results.length); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && results.length) { setActive((active - 1 + results.length) % results.length); e.preventDefault(); }
    else if (e.key === 'Enter' && results[active]) { choose(results[active]); e.preventDefault(); }
    else if (e.key === 'Escape') update('');
  };

  return (
    <div className="rh-search">
      <IconSearch />
      <input
        type="search"
        autoComplete="off"
        spellCheck={false}
        placeholder={disabled ? 'Cargando lugares…' : 'Buscar municipio, localidad, colonia o río'}
        aria-label="Buscar lugar"
        role="combobox"
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        disabled={disabled}
        value={q}
        onChange={e => update(e.target.value)}
        onKeyDown={onKey}
        onFocus={() => q.trim() && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />
      {open && (
        <ul className="rh-results" id={id} role="listbox">
          {results.length === 0 && <li className="rh-empty">Sin resultados en Hidalgo</li>}
          {results.map((r, i) => (
            <li
              key={`${r.kind}-${r.n}-${r.lon}`}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              onPointerDown={e => { e.preventDefault(); choose(r); }}
              onPointerEnter={() => setActive(i)}
            >
              <span>{r.n}</span>
              <small>{r.sub && r.kind !== 'Municipio' ? `${r.tipo ?? r.kind} · ${r.sub}` : r.kind}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
