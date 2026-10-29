/** Íconos de trazo, 24×24, heredan el color del texto. */
const S = { viewBox: '0 0 24 24', 'aria-hidden': true } as const;

export const IconSearch = () => <svg {...S}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>;
export const IconPlus = () => <svg {...S}><path d="M12 5v14M5 12h14" /></svg>;
export const IconMinus = () => <svg {...S}><path d="M5 12h14" /></svg>;
export const IconChevron = () => <svg {...S}><path d="M6 9l6 6 6-6" /></svg>;
export const IconClose = () => <svg {...S}><path d="M6 6l12 12M18 6L6 18" /></svg>;
export const IconLink = () => <svg {...S}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.4 1.4" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.4-1.4" /></svg>;
export const IconCamera = () => <svg {...S}><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>;
export const IconExpand = () => <svg {...S}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>;
export const IconShrink = () => <svg {...S}><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>;
export const IconTarget = () => <svg {...S}><circle cx="12" cy="12" r="7" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>;
export const IconSun = () => <svg {...S}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
export const IconMoon = () => <svg {...S}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>;
export const IconCompass = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="rh-needle-svg">
    <path className="rh-n" d="M12 3l3.2 9h-6.4z" />
    <path className="rh-s" d="M12 21l-3.2-9h6.4z" />
  </svg>
);
export const IconPlay = () => <svg {...S}><path d="M8 5.5v13l10.5-6.5z" /></svg>;
export const IconPause = () => <svg {...S}><path d="M8.5 5.5v13M15.5 5.5v13" /></svg>;
/** flecha hacia arriba (se gira con CSS para marcar hacia dónde va el viento) */
export const IconArrow = () => <svg {...S}><path d="M12 19V5M6.5 10.5L12 5l5.5 5.5" /></svg>;
export const IconGrid = () => <svg {...S}><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></svg>;
