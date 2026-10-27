const RAD = Math.PI / 180;

/** Hora de México (centro): UTC−6 todo el año desde 2022. */
export const MX_UTC_OFFSET = -6;

/** Fecha de hoy en México como [año, mes 0–11, día]. */
export function todayInMexico(): [number, number, number] {
  const d = new Date(Date.now() + MX_UTC_OFFSET * 3600e3);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

export function mexicoDate(ymd: [number, number, number], hour: number) {
  return new Date(Date.UTC(ymd[0], ymd[1], ymd[2]) + (hour - MX_UTC_OFFSET) * 3600e3);
}

/**
 * Posición del Sol (ecuaciones de la NOAA, error < 0.1°).
 * azimuth: desde el norte en sentido horario; elevation: sobre el horizonte. Ambos en radianes.
 */
export function sunPosition(date: Date, lat: number, lon: number) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan((eps * RAD) / 2) ** 2;
  const eqTime = (4 / RAD) * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD)
    + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) - 0.5 * y * y * Math.sin(4 * L0 * RAD)
    - 1.25 * e * e * Math.sin(2 * M * RAD));
  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const tst = (((utcMin + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const ha = (tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180) * RAD;
  const phi = lat * RAD;
  const cosZ = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const elevation = Math.PI / 2 - Math.acos(Math.max(-1, Math.min(1, cosZ)));
  const azimuth = (Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI) % (2 * Math.PI);
  return { azimuth, elevation };
}

/** Hora local (decimal) en que el Sol cruza el horizonte, buscando entre 4 y 21 h. */
export function sunTimes(ymd: [number, number, number], lat: number, lon: number) {
  const el = (h: number) => sunPosition(mexicoDate(ymd, h), lat, lon).elevation;
  const cross = (a: number, b: number) => {
    for (let k = 0; k < 40; k++) { const m = (a + b) / 2; if ((el(a) < 0) === (el(m) < 0)) a = m; else b = m; }
    return (a + b) / 2;
  };
  return { sunrise: cross(4, 12.5), sunset: cross(12.5, 21) };
}
