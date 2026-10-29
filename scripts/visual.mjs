#!/usr/bin/env node
/**
 * Regresión visual: captura vistas fijas del visor (Edge sin interfaz, con GPU) y las compara con las de referencia.
 *
 *   npm run visual -- --update        guarda las referencias en shots/visual-base/ (antes de tocar el motor)
 *   npm run visual                    captura en shots/visual/ y compara: % de píxeles distintos y shots/visual-diff/
 *   npm run visual -- --only=pachuca,noche
 *
 * Las referencias dependen de la GPU y del navegador: se generan y se comparan en el mismo equipo (shots/ no se versiona).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true']; }));
const update = args.update === 'true';
const only = args.only ? new Set(args.only.split(',')) : null;
const dir = path.join(root, 'shots', update ? 'visual-base' : 'visual');
const baseDir = path.join(root, 'shots', 'visual-base'), diffDir = path.join(root, 'shots', 'visual-diff');
for (const d of [dir, diffDir]) fs.mkdirSync(d, { recursive: true });

/** Vistas: parámetros de la URL y cámara (lon, lat, distancia en unidades de escena = 100 km, ángulos en grados). */
const VIEWS = [
  { name: 'inicio', q: '' },
  { name: 'planta-altitud', q: '&mapa=altitud', view: { lon: -98.88, lat: 20.5, dist: 3.2, polar: 0.1, az: 0 } },
  { name: 'metztitlan-sat', q: '&mapa=satelite', view: { lon: -98.76, lat: 20.6, dist: 0.24, polar: 55, az: 20 } },
  { name: 'barranca-cerca', q: '&mapa=altitud', view: { lon: -98.83, lat: 20.56, dist: 0.13, polar: 62, az: -30 } },
  { name: 'tula-usv', q: '', view: { lon: -99.34, lat: 20.06, dist: 0.26, polar: 50, az: 0 } },
  { name: 'borde-norte', q: '', view: { lon: -99.05, lat: 21.28, dist: 0.32, polar: 45, az: 160 } },
  { name: 'pachuca', q: '', view: { lon: -98.74, lat: 20.12, dist: 0.18, polar: 40, az: 0 } },
  { name: 'sierra-curvas', q: '&mapa=altitud', view: { lon: -98.6, lat: 20.75, dist: 0.5, polar: 50, az: -40 }, script: 'api.setLayer("contours", true)' },
  { name: 'noche', q: '', hour: 20, view: { lon: -98.9, lat: 20.3, dist: 1.6, polar: 45, az: 0 } },
  { name: 'poblacion', q: '&analisis=poblacion', view: { lon: -98.9, lat: 20.3, dist: 1.8, polar: 50, az: 0 }, wait: 4000 },
  { name: 'movil', q: '', w: 390, h: 844, dpr: 2 },
];

const server = await createServer({ root, logLevel: 'error', server: { port: 5198, strictPort: false } });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ channel: args.channel || 'msedge', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });

async function capture(v) {
  const page = await browser.newPage({ viewport: { width: v.w || 1440, height: v.h || 900 }, deviceScaleFactor: v.dpr || 1 });
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`${base}/?quieto&hora=${v.hour ?? 11}${v.q}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.querySelector('.rh-loading'), null, { timeout: 90000 });
  // entrada (2.6 s), líneas y relieve fino
  await page.waitForTimeout(3500);
  if (v.view) {
    await page.evaluate(view => {
      const api = window.__rh;
      if (api.setView) { api.setView(view, 0); return; }
      // versión anterior del motor: se arma la cámara a mano
      const t = api.worldOf(view.lon, view.lat);
      api.fly = null;
      api.controls.autoRotate = false;
      api.controls.target.copy(t);
      api.camera.position.copy(t).add(t.clone().setFromSphericalCoords(view.dist, (view.polar * Math.PI) / 180, (view.az * Math.PI) / 180));
      api.invalidate();
    }, v.view);
  }
  if (v.script) await page.evaluate(code => new Function('api', code)(window.__rh), v.script);
  await page.waitForTimeout(v.wait || 3000);
  const file = path.join(dir, `${v.name}.png`);
  await page.screenshot({ path: file });
  await page.close();
  return { file, logs };
}

async function compare(name) {
  const a = path.join(baseDir, `${name}.png`), b = path.join(dir, `${name}.png`);
  if (!fs.existsSync(a)) return { vista: name, nota: 'sin referencia' };
  const [ra, rb] = await Promise.all([a, b].map(f => sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return { vista: name, nota: 'otro tamaño' };
  const n = ra.info.width * ra.info.height, out = Buffer.alloc(n * 3);
  let changed = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(ra.data[i * 3 + k] - rb.data[i * 3 + k]));
    sum += d;
    const hit = d > 24;
    if (hit) changed++;
    // diferencias en rojo sobre la captura nueva atenuada
    for (let k = 0; k < 3; k++) out[i * 3 + k] = hit ? (k === 0 ? 255 : 40) : rb.data[i * 3 + k] * 0.35;
  }
  await sharp(out, { raw: { width: ra.info.width, height: ra.info.height, channels: 3 } }).png().toFile(path.join(diffDir, `${name}.png`));
  return { vista: name, 'píxeles distintos (%)': +((100 * changed) / n).toFixed(2), 'diferencia media': +(sum / n).toFixed(2) };
}

const rows = [];
for (const v of VIEWS) {
  if (only && !only.has(v.name)) continue;
  const { logs } = await capture(v);
  if (logs.length) console.log(v.name, logs.slice(0, 5).join('\n  '));
  rows.push(update ? { vista: v.name, nota: 'referencia guardada' } : await compare(v.name));
}
console.table(rows);
await browser.close();
await server.close();
