import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HORIZON_DIRS, MONTH_DAYS, byteToH, dirAzimuths, dirWeights, hToByte, horizonAt, horizonSweep, irradiation, skyView, slopeAspect, solarGeometry, sunTable } from '../src/relieve/shared/solar';

const RAD = Math.PI / 180;
const dirAz = dirAzimuths(90, 90), wts = dirWeights(dirAz);
/** alrededores planos: horizonte a 0° en todas las direcciones */
const open = new Float64Array(16);
const GHI = [4.6, 5.4, 6.3, 6.8, 6.6, 6.2, 6.0, 6.0, 5.2, 5.1, 4.7, 4.5], DHI = [1.4, 1.6, 1.9, 2.2, 2.6, 2.9, 2.9, 2.8, 2.5, 2.0, 1.6, 1.4];

test('sol: elevación al mediodía del solsticio y azimut de la mañana', () => {
  const noon = solarGeometry(20.5, 172, 12);
  assert.ok(Math.abs(noon.e / RAD - (90 - (23.44 - 20.5))) < 0.3, `elevación ${noon.e / RAD}`);
  const morning = solarGeometry(20.5, 80, 9);
  assert.ok(morning.az > 60 * RAD && morning.az < 130 * RAD, 'por la mañana el Sol está al este');
});

test('factor de vista del cielo: 1 en lo plano y (1 + cos S) / 2 en un plano inclinado sobre un llano', () => {
  assert.ok(Math.abs(skyView(0, 0, open, dirAz, wts) - 1) < 1e-9);
  for (const s of [15, 30, 45]) {
    const v = skyView(s * RAD, 1, open, dirAz, wts), want = (1 + Math.cos(s * RAD)) / 2;
    assert.ok(Math.abs(v - want) < 0.01, `pendiente ${s}°: ${v.toFixed(4)} vs ${want.toFixed(4)}`);
  }
  // un horizonte de 30° parejo deja ver cos²(30°) del cielo a una superficie plana
  assert.ok(Math.abs(skyView(0, 0, new Float64Array(16).fill(30 * RAD), dirAz, wts) - Math.cos(30 * RAD) ** 2) < 1e-9);
});

test('horizonte: el barrido con la envolvente coincide con buscar en toda la línea', () => {
  const w = 60, h = 45, z = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = 1000 + 300 * Math.sin(c / 7) * Math.cos(r / 5) + 4 * ((c * 7 + r * 13) % 11);
  HORIZON_DIRS.forEach(([a, b], d) => {
    const got = new Float64Array(w * h), step = Math.hypot(a * 90, b * 90);
    horizonSweep(z, w, h, a, b, step, (i, v) => { got[i] = v; });
    for (const [c, r] of [[5, 5], [30, 20], [50, 40], [12, 33]]) {
      const want = horizonAt(z, w, h, c, r, 90, 90)[d];
      assert.ok(Math.abs(got[r * w + c] - want) < 1e-9, `dirección ${d} en (${c}, ${r}): ${got[r * w + c]} vs ${want}`);
    }
  });
  assert.ok(Math.abs(byteToH(hToByte(12.3 * RAD)) - 12.5 * RAD) < 1e-9 || Math.abs(byteToH(hToByte(12.3 * RAD)) - 12.3 * RAD) < 0.26 * RAD);
});

test('radiación: en lo plano y sin horizonte es la global de POWER; ladera sur más, ladera norte menos; un cañón tapa el invierno', () => {
  const t = sunTable(20.5, dirAz), months = new Float64Array(12);
  const flat = irradiation(t, 0, 0, open, 1, GHI, DHI, months);
  const want = GHI.reduce((s, g, m) => s + g * MONTH_DAYS[m], 0);
  assert.ok(Math.abs(flat - want) < 0.01, `${flat} vs ${want}`);
  const south = irradiation(t, 25 * RAD, Math.PI, open, skyView(25 * RAD, Math.PI, open, dirAz, wts), GHI, DHI, months);
  const decSouth = months[11];
  const north = irradiation(t, 25 * RAD, 0, open, skyView(25 * RAD, 0, open, dirAz, wts), GHI, DHI, months);
  assert.ok(south > flat && north < flat * 0.9, `sur ${south.toFixed(0)}, plano ${flat.toFixed(0)}, norte ${north.toFixed(0)}`);
  assert.ok(decSouth > GHI[11], 'en diciembre la ladera sur recibe más que lo plano');
  // horizonte de 60° del este-sureste al oeste-suroeste: en diciembre (Sol a ≤ 46°, de 115° a 245°) no llega directa
  const canyon = Float64Array.from(dirAz, az => (Math.abs(az - Math.PI) < 80 * RAD ? 60 * RAD : 0));
  const parts = new Float64Array(36);
  irradiation(t, 0, 0, canyon, skyView(0, 0, canyon, dirAz, wts), GHI, DHI, months, parts);
  assert.equal(parts[11 * 3], 0);
  assert.ok(parts[5 * 3] > 0, 'en junio el Sol pasa por encima');
});

test('pendiente y orientación por Horn: un plano que baja hacia el este', () => {
  const w = 5, h = 5, z = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = 500 - c * 90 * Math.tan(20 * RAD);
  const { slope, aspect } = slopeAspect(z, w, h, 2, 2, 90, 90);
  assert.ok(Math.abs(slope - 20 * RAD) < 1e-6 && Math.abs(aspect - Math.PI / 2) < 1e-6);
});
