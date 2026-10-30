import type { JSX } from 'react';

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
export const IconLayers = () => <svg {...S}><path d="M12 4l8.5 4.5L12 13 3.5 8.5z" /><path d="M3.5 12.5L12 17l8.5-4.5" /><path d="M3.5 16.5L12 21l8.5-4.5" /></svg>;
export const IconHome = () => <svg {...S}><path d="M4 11l8-6.5 8 6.5" /><path d="M6.5 9.5V19h11V9.5" /><path d="M10.5 19v-5h3v5" /></svg>;
/** mapa doblado: minimapa */
export const IconMap = () => <svg {...S}><path d="M3.5 6.5l5.5-2.5 6 2.5 5.5-2.5v13.5l-5.5 2.5-6-2.5-5.5 2.5z" /><path d="M9 4v13.5M15 6.5V20" /></svg>;
export const IconInfo = () => <svg {...S}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.6v.1" /></svg>;
export const IconHand = () => <svg {...S}><path d="M8.5 12.5V6a1.5 1.5 0 0 1 3 0v5.5M11.5 11V4.5a1.5 1.5 0 0 1 3 0V11M14.5 11V6a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6 7-2.6 0-4.1-1.3-5.4-3.4L4 13.6a1.5 1.5 0 0 1 2.4-1.8l2.1 2.2" /></svg>;
export const IconDots = () => <svg {...S}><path d="M6 12h.01M12 12h.01M18 12h.01" /></svg>;

/* ---------- análisis (menú y encabezado del panel) ---------- */
const IconPeople = () => <svg {...S}><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" /><circle cx="16.5" cy="9.5" r="2.4" /><path d="M15.5 14.2c2.4-.3 4.5 1.2 5 4.3" /></svg>;
const IconPins = () => <svg {...S}><path d="M12 21s-6-5.5-6-10.5a6 6 0 0 1 12 0C18 15.5 12 21 12 21z" /><circle cx="12" cy="10.5" r="2.2" /></svg>;
const IconScale = () => <svg {...S}><path d="M12 4v16M7 20h10M5 7h14" /><path d="M5 7l-2.5 6a2.5 2.5 0 0 0 5 0z" /><path d="M19 7l-2.5 6a2.5 2.5 0 0 0 5 0z" /></svg>;
const IconRoute = () => <svg {...S}><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="6" r="2.2" /><path d="M8.2 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8" /></svg>;
const IconDrop = () => <svg {...S}><path d="M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5z" /><path d="M9 14.5a3 3 0 0 0 3 3" /></svg>;
const IconWaves = () => <svg {...S}><path d="M3 9c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0" /><path d="M3 14c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0" /><path d="M3 19c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0" /></svg>;
const IconSlope = () => <svg {...S}><path d="M3 20h18L9 5z" /><path d="M14.5 9.5l1.5-1M17 12.5l1.8-.6" /></svg>;
const IconLeaf = () => <svg {...S}><path d="M5 19c0-8 5-13 14-14-.5 9-5.5 14-13.5 14" /><path d="M5 19l7-7" /></svg>;
const IconProfile = () => <svg {...S}><path d="M3 19l5-8 4 4 4-9 5 13" /><path d="M3 21h18" /></svg>;
const IconTower = () => <svg {...S}><path d="M12 9v12M8.5 21L12 9l3.5 12" /><circle cx="12" cy="7.5" r="1.5" /><path d="M8.3 4.3a5 5 0 0 0 0 6.4M15.7 4.3a5 5 0 0 1 0 6.4" /></svg>;
const IconArcs = () => <svg {...S}><circle cx="4.5" cy="18" r="1.8" /><circle cx="19.5" cy="18" r="1.8" /><path d="M6 17C8 7 16 7 18 17" /><path d="M6 17.5c3-4.5 9-4.5 12 0" /></svg>;
const IconTour = () => <svg {...S}><circle cx="12" cy="12" r="8.5" /><path d="M10 8.5v7l5.5-3.5z" /></svg>;
const IconGem = () => <svg {...S}><path d="M7 4h10l4 5-9 11L3 9z" /><path d="M3 9h18M9.5 4L12 9l2.5-5M12 9v11" /></svg>;
const IconVideo = () => <svg {...S}><rect x="3" y="6.5" width="12.5" height="11" rx="2" /><path d="M15.5 10.5l5-3v9l-5-3" /></svg>;
const IconCube = () => <svg {...S}><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></svg>;
const IconSchool = () => <svg {...S}><path d="M2.5 9L12 4.5 21.5 9 12 13.5z" /><path d="M6.5 11v4.5c1.5 1.5 3.4 2.2 5.5 2.2s4-.7 5.5-2.2V11M21.5 9v5" /></svg>;
const IconChat = () => <svg {...S}><path d="M4 5.5h16v10H9l-5 4z" /><path d="M8.5 10.5h7" /></svg>;

const BY_ID: Record<string, () => JSX.Element> = {
  poblacion: IconPeople, localidades: IconPins, marginacion: IconScale, accesibilidad: IconRoute, cuencas: IconDrop, inundacion: IconWaves,
  laderas: IconSlope, 'cambio-uso': IconLeaf, perfil: IconProfile, antenas: IconTower, solar: IconSun, movilidad: IconArcs,
  recorridos: IconTour, geoparque: IconGem, video: IconVideo, impresion: IconCube, escuelas: IconSchool, preguntas: IconChat,
};
const BY_GROUP: Record<string, () => JSX.Element> = {
  'Población': IconPeople, 'Desigualdad': IconScale, 'Servicios': IconRoute, 'Agua y riesgo': IconDrop, 'Planeación': IconProfile,
  'Difusión': IconTour, 'Plataforma': IconChat,
};
/** Ícono de un análisis del registro (por id; si no tiene uno propio, el de su grupo). */
export function AnalysisIcon({ id, group }: { id: string; group: string }) {
  const I = BY_ID[id] ?? BY_GROUP[group] ?? IconGrid;
  return <I />;
}
