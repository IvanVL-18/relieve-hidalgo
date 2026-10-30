import { buildSurface, previewImage, stlBytes, triangleCount, writeStl, type PrintInput } from './model';

/**
 * Worker de impresión 3D: arma la superficie (con relieves táctiles) y devuelve la vista previa o el STL completo, sin
 * detener la interfaz. Cada mensaje trae todo lo necesario (no guarda estado).
 */
export interface StlRequest { id: number; kind: 'preview' | 'stl'; input: PrintInput; maxPx?: number }
export interface StlStats { cells: number; triangles: number; bytes: number; height: number; elevMin: number; elevMax: number }
export interface StlReply {
  id: number;
  error?: string;
  stats?: StlStats;
  preview?: { width: number; height: number; rgba: Uint8ClampedArray };
  stl?: ArrayBuffer;
}

const ctx = self as unknown as { postMessage(m: StlReply, t?: Transferable[]): void; onmessage: ((e: MessageEvent<StlRequest>) => void) | null };

ctx.onmessage = ({ data: { id, kind, input, maxPx } }) => {
  try {
    const s = buildSurface(input), triangles = triangleCount(s.inside, input.grid.nx, input.grid.ny);
    const stats: StlStats = { cells: s.cells, triangles, bytes: stlBytes(triangles), height: s.height, elevMin: s.elevMin, elevMax: s.elevMax };
    if (kind === 'preview') {
      const preview = previewImage(s, input.grid, maxPx ?? 360);
      ctx.postMessage({ id, stats, preview }, [preview.rgba.buffer]);
    } else {
      const stl = writeStl(s, input.grid);
      ctx.postMessage({ id, stats, stl }, [stl]);
    }
  } catch (e) {
    ctx.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
