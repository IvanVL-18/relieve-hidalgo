import type { BuildRequest, WorkerMessage } from '../shared/types';
import { build, buildLines } from './build';

const ctx = self as unknown as {
  postMessage(msg: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<BuildRequest>) => void) | null;
};

/**
 * Primero lo que hace falta para el primer cuadro (texturas del relieve, paredes, luces, minimapa); luego, ya con el
 * relieve en pantalla, las líneas. Si las líneas fallan, el visor sigue sin ellas. El relieve fino lo trae el worker
 * de relieve (terrain.worker.ts).
 */
ctx.onmessage = async ev => {
  const req = ev.data;
  let base;
  try {
    base = await build(req, stage => ctx.postMessage({ type: 'progress', stage }));
    ctx.postMessage(base.result, base.transfer);
  } catch (e) {
    ctx.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    return;
  }
  try {
    const lines = buildLines(base.vec, req.grid.W, req.grid.H, req.quality.tex);
    ctx.postMessage(lines.result, lines.transfer);
  } catch (e) {
    ctx.postMessage({ type: 'warning', message: e instanceof Error ? e.message : String(e) });
  }
};
