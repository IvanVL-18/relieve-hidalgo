#!/usr/bin/env node
/**
 * Captura el visor en Edge/Chrome sin interfaz (con GPU) para revisar cambios visuales y tiempos de carga.
 *
 *   pnpm shot      → shots/main.png
 *   pnpm shot --name=noche --hour=19.5 --w=1280 --h=800
 *   pnpm shot --path=/?embed --name=embed
 *   pnpm shot --script="api.topView()"   (código a ejecutar con window.__rh = motor)
 *
 * Usa Edge (incluido en Windows). Para usar Chrome: --channel=chrome
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true']; }));
const W = +(args.w || 1440), H = +(args.h || 900), name = args.name || 'main';
const urlPath = (args.path || '/') + (args.hour ? ((args.path || '/').includes('?') ? '&' : '?') + 'hora=' + args.hour : '');
const outDir = path.join(root, 'shots');
fs.mkdirSync(outDir, { recursive: true });

const server = await createServer({ root, logLevel: 'error', server: { port: 5199, strictPort: false } });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');

const browser = await chromium.launch({ channel: args.channel || 'msedge', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: +(args.dpr || 1) });
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

const t0 = Date.now();
await page.goto(base + urlPath, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => !document.querySelector('.rh-loading'), null, { timeout: 60000 });
} catch {
  logs.push('[timeout] el visor no terminó de cargar');
}
const loadMs = Date.now() - t0;
await page.waitForTimeout(+(args.wait || 3500));
if (args.script) {
  await page.evaluate(code => new Function('api', code)(window.__rh), args.script);
  await page.waitForTimeout(+(args.after || 2000));
}
const file = path.join(outDir, `${name}.png`);
await page.screenshot({ path: file });
const timings = await page.evaluate(() => window.__rhTimings || null);
console.log(JSON.stringify({ file, loadMs, timings, logs }, null, 2));
await browser.close();
await server.close();
