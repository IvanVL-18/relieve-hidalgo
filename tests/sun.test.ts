import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mexicoDate, sunPosition, sunTimes } from '../src/relieve/engine/sun';

const PACHUCA = { lat: 20.1, lon: -98.75 };
const hm = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

test('amanecer y anochecer en Pachuca (hora del centro, UTC−6)', () => {
  // solsticio de verano: día de ≈ 13 h 15 min centrado en el mediodía solar (≈ 12:37)
  const jun = sunTimes([2026, 5, 21], PACHUCA.lat, PACHUCA.lon);
  assert.ok(jun.sunrise > 5.9 && jun.sunrise < 6.15, `amanecer en junio ${hm(jun.sunrise)}`);
  assert.ok(jun.sunset > 19.1 && jun.sunset < 19.35, `anochecer en junio ${hm(jun.sunset)}`);
  // solsticio de invierno: día de ≈ 10 h 50 min
  const dic = sunTimes([2026, 11, 21], PACHUCA.lat, PACHUCA.lon);
  const day = dic.sunset - dic.sunrise;
  assert.ok(day > 10.6 && day < 11.1, `duración del día en diciembre ${day.toFixed(2)} h`);
});

test('altura del Sol al mediodía del solsticio de verano ≈ 90° − |φ − δ|', () => {
  let best = 0;
  for (let h = 11.5; h <= 13.5; h += 1 / 60) best = Math.max(best, sunPosition(mexicoDate([2026, 5, 21], h), PACHUCA.lat, PACHUCA.lon).elevation);
  const deg = (best * 180) / Math.PI;
  assert.ok(Math.abs(deg - (90 - Math.abs(PACHUCA.lat - 23.44))) < 0.6, `altura máxima ${deg.toFixed(2)}°`);
});

test('acimut: por la mañana al este, por la tarde al oeste', () => {
  const am = sunPosition(mexicoDate([2026, 2, 20], 9), PACHUCA.lat, PACHUCA.lon).azimuth;
  const pm = sunPosition(mexicoDate([2026, 2, 20], 16), PACHUCA.lat, PACHUCA.lon).azimuth;
  assert.ok(am > 0 && am < Math.PI, 'mañana: entre norte y sur por el este');
  assert.ok(pm > Math.PI && pm < 2 * Math.PI, 'tarde: por el oeste');
});
