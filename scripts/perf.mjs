#!/usr/bin/env node
/**
 * Mide carga y fluidez del visor (build de producción) y, opcionalmente, de otra página para comparar.
 *   pnpm perf [--compare=ruta/al/original.html]   (compila y mide)
 * Métricas: tiempo hasta ver el relieve, bloqueo del hilo principal (tareas > 50 ms),
 * cuadros por segundo girando, cuadros dibujados en reposo y memoria JS.
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true']; }));

const INIT = () => {
  window.__raf = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(t => { window.__raf++; cb(t); });
  window.__long = [];
  new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: true });
};

async function measure(browser, url, readyFn, idleSetup) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(INIT);
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(readyFn, null, { timeout: 90000 });
  const ready = Date.now() - t0;
  const blocking = await page.evaluate(() => window.__long.reduce((s, d) => s + Math.max(0, d - 50), 0));
  const longest = await page.evaluate(() => Math.max(0, ...window.__long));
  await page.waitForTimeout(3000);   // termina la animación de entrada
  const fps = await page.evaluate(() => new Promise(res => {
    const a = window.__raf, t = performance.now();
    setTimeout(() => res(((window.__raf - a) * 1000) / (performance.now() - t)), 4000);
  }));
  await page.evaluate(idleSetup);
  await page.waitForTimeout(11000);   // pasa la ventana de animación ambiental (nubes) tras la última interacción
  const idle = await page.evaluate(() => new Promise(res => { const a = window.__raf; setTimeout(() => res(window.__raf - a), 4000); }));
  const heap = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : NaN));
  await page.close();
  return { 'listo (ms)': ready, 'bloqueo hilo principal (ms)': Math.round(blocking), 'tarea más larga (ms)': Math.round(longest), 'cps girando': Math.round(fps), 'cuadros en 4 s de reposo': idle, 'memoria JS (MB)': Math.round(heap) };
}

const server = await preview({ root, logLevel: 'error', preview: { port: 4199 } });
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: args.channel || 'msedge', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-precise-memory-info'] });
const results = {};
results.proyecto = await measure(browser, base, () => !document.querySelector('.rh-loading'), () => document.querySelector('[aria-label="Orientar al norte"]')?.click());
if (args.compare) {
  results.original = await measure(browser, pathToFileURL(path.resolve(args.compare)).href,
    () => document.getElementById('loading')?.classList.contains('done'),
    () => document.getElementById('compass')?.click());
}
console.table(results);
await browser.close();
server.httpServer.close();
