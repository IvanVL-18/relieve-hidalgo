import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAdjacency, dijkstra, nodeIndex, pathEdges, type RoadGraph } from '../src/relieve/shared/routing';

/** Grafo chico: 0 —10 s— 1 —10 s— 2, y un atajo lento 0 —30 s— 2; el nodo 3 queda aislado. */
function graph(): RoadGraph {
  const ea = Uint32Array.of(0, 1, 0), eb = Uint32Array.of(1, 2, 2);
  const nNodes = 4, nEdges = 3;
  return {
    nNodes, nEdges,
    nx: Uint16Array.of(0, 80, 160, 800), ny: Uint16Array.of(0, 0, 0, 800),
    ea, eb, et: Float32Array.of(10, 10, 30), el: Float32Array.of(100, 100, 250), ec: new Uint8Array(3), en: new Uint16Array(3), names: [''],
    gs: new Uint32Array(3), gl: new Uint16Array(3), gx: new Uint16Array(0), gy: new Uint16Array(0),
    ...buildAdjacency(nNodes, ea, eb),
  };
}

test('Dijkstra elige el camino más rápido y reconstruye la ruta', () => {
  const g = graph();
  const { dist, pred, src } = dijkstra(g, [0], [0]);
  assert.deepEqual(Array.from(dist), [0, 10, 20, Infinity]);
  assert.deepEqual(pathEdges(g, pred, 2), [0, 1]);
  assert.equal(src[2], 0);
});

test('varias fuentes con costo inicial: gana la de menor tiempo total', () => {
  const { dist, src } = dijkstra(graph(), [0, 2], [0, 25]);
  assert.equal(dist[1], 10);
  assert.equal(src[1], 0);
  assert.equal(dist[2], 20);
});

test('límite de tiempo: los nodos más allá se descubren pero no se expanden', () => {
  const { dist } = dijkstra(graph(), [0], [0], 5);
  assert.equal(dist[1], 10);
  // sin expandir el nodo 1 no aparece el camino de 20 s: queda el atajo directo
  assert.equal(dist[2], 30);
});

test('nodo más cercano', () => {
  const near = nodeIndex(graph(), 120, 120);
  assert.equal(near(70, 5), 1);
  assert.equal(near(790, 790), 3);
});
