import type { BuildRequest, WorkerMessage } from '../shared/types';
import { build } from './build';

const ctx = self as unknown as {
  postMessage(msg: WorkerMessage, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<BuildRequest>) => void) | null;
};

ctx.onmessage = async ev => {
  try {
    const { result, transfer } = await build(ev.data, stage => ctx.postMessage({ type: 'progress', stage }));
    ctx.postMessage(result, transfer);
  } catch (e) {
    ctx.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
