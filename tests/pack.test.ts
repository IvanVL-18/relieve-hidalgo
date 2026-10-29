import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { decodeElev } from '../src/relieve/worker/decode';
import { Pack, gunzip } from '../src/relieve/worker/pack';
import meta from '../src/relieve/data/meta.json' with { type: 'json' };

/**
 * Paquete de teselas (RHP1) leído por partes con Range, como lo pide el visor; y la alternativa cuando el servidor no
 * acepta Range y manda el archivo completo.
 */
const file = new URL('../src/relieve/data/relieve-30m.bin', import.meta.url);
const bytes = fs.readFileSync(file);
let server: http.Server, base = '';
const seen: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    seen.push(req.url + ' ' + (range ? 'range' : 'full'));
    if (range && req.url === '/con-range.bin') {
      const a = +range[1], b = Math.min(bytes.length - 1, +range[2]);
      res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': `bytes ${a}-${b}/${bytes.length}` });
      res.end(bytes.subarray(a, b + 1));
    } else if (req.url === '/con-range.bin' || req.url === '/sin-range.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(bytes);
    } else { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<!doctype html>'); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

const centerTile = (nx: number, cells: number) => Math.floor((meta.H - 1) / 2 / cells) * nx + Math.floor((meta.W - 1) / 2 / cells);

test('cabecera y directorio: teselas de 16 celdas a 30 m sobre la rejilla del visor', async () => {
  const p = new Pack(`${base}/con-range.bin`), info = await p.open();
  assert.equal(info.kind, 1);
  assert.equal(info.tileCells, 16);
  assert.equal(info.f, 9);
  assert.equal(info.px, 16 * 9 + 3);
  assert.equal(info.nx, Math.ceil((meta.W - 1) / 16));
  assert.equal(info.ny, Math.ceil((meta.H - 1) / 16));
  assert.ok(info.has.reduce((s, v) => s + v, 0) > 1000);
});

test('una tesela por Range: alturas plausibles en cuartos de metro', async () => {
  const p = new Pack(`${base}/con-range.bin`), info = await p.open();
  seen.length = 0;
  const raw = await p.tile(centerTile(info.nx, info.tileCells));
  assert.ok(raw);
  assert.deepEqual(seen, ['/con-range.bin range']);
  const q = decodeElev(await gunzip(raw!), info.px, info.px);
  let min = Infinity, max = -Infinity;
  for (const v of q) if (v) { min = Math.min(min, v / 4); max = Math.max(max, v / 4); }
  assert.ok(min > 0 && max < meta.relief.max + 50 && max > min, `de ${min} a ${max} m`);
});

test('sin Range: el archivo completo se descarga una vez y las teselas salen de ahí', async () => {
  const p = new Pack(`${base}/sin-range.bin`), info = await p.open();
  seen.length = 0;
  const a = await p.tile(centerTile(info.nx, info.tileCells)), b = await p.tile(centerTile(info.nx, info.tileCells) + 1);
  assert.ok(a && b);
  assert.equal(seen.length, 0);
});

test('archivo faltante: error claro', async () => {
  await assert.rejects(new Pack(`${base}/no-existe.bin`).open(), /Falta el archivo de datos/);
});
