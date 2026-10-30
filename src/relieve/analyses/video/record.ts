/**
 * Grabación de video: cuadro por cuadro con la grabación del motor (MapApi.capture), cada cuadro compuesto en un lienzo
 * 2D y codificado en H.264 con WebCodecs (VideoEncoder) y empaquetado en MP4 (mp4.ts): sin tirones aunque el equipo sea
 * lento, porque el reloj del motor avanza exactamente 1/cps por cuadro. Donde no hay WebCodecs con H.264 se usa
 * MediaRecorder (en tiempo real: en equipos lentos puede salir con tirones).
 */
import type { CaptureSession, MapApi } from '../../engine/mapApi';
import { composeFrame, type Overlay } from './compose';
import { Mp4Writer, avcCodecs } from './mp4';

export type Encoder = { kind: 'webcodecs'; codec: string } | { kind: 'mediarecorder'; mime: string };

/** Bits por segundo: ≈ 0.16 bits por pixel y cuadro a 30 cps (≈ 10 Mb/s en 1080p). */
export const bitrateFor = (w: number, h: number, fps: number) => Math.round(w * h * fps * (fps > 30 ? 0.11 : 0.16));

/** El mejor codificador disponible para ese tamaño. */
export async function pickEncoder(width: number, height: number, fps: number): Promise<Encoder | null> {
  if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
    for (const codec of avcCodecs(width, height, fps)) {
      try {
        const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: bitrateFor(width, height, fps), framerate: fps, avc: { format: 'avc' } });
        if (r.supported) return { kind: 'webcodecs', codec };
      } catch { /* siguiente */ }
    }
  }
  if (typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function') {
    const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
    if (mime) return { kind: 'mediarecorder', mime };
  }
  return null;
}

export interface RecordJob {
  map: MapApi;
  width: number;
  height: number;
  fps: number;
  frames: number;
  encoder: Encoder;
  /** se llama con la grabación ya abierta, antes del primer cuadro (arrancar el camino de la cámara) */
  begin(): void;
  /** lo que va encima del cuadro i */
  overlay(i: number): Overlay;
  onProgress(done: number): void;
  cancelled(): boolean;
}

export interface RecordResult { blob: Blob; ext: 'mp4' | 'webm'; seconds: number }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function recordVideo(job: RecordJob): Promise<RecordResult | null> {
  const { map, width: W, height: H, fps, frames: N, encoder } = job;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  let session: CaptureSession | null = null;
  try {
    session = map.capture({ width: W, height: H });
    job.begin();
    if (encoder.kind === 'webcodecs') {
      const mux = new Mp4Writer({ width: W, height: H, fps });
      let failure: Error | null = null;
      const enc = new VideoEncoder({
        output: (chunk, meta) => {
          if (meta?.decoderConfig?.description) mux.setConfig(meta.decoderConfig.description as ArrayBuffer);
          const b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          mux.add(b, chunk.type === 'key');
        },
        error: e => { failure = e instanceof Error ? e : new Error(String(e)); },
      });
      enc.configure({ codec: encoder.codec, width: W, height: H, bitrate: bitrateFor(W, H, fps), framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality' });
      for (let i = 0; i < N; i++) {
        if (job.cancelled()) { enc.close(); return null; }
        if (failure) throw failure;
        const ov = job.overlay(i);
        await session.frame(i ? 1 / fps : 0, f => composeFrame(ctx, f, ov), { maxWaitMs: i ? 6000 : 15000 });
        const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
        enc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
        vf.close();
        while (enc.encodeQueueSize > 4) await sleep(4);
        job.onProgress(i + 1);
      }
      await enc.flush();
      enc.close();
      if (failure) throw failure;
      return { blob: mux.finish(), ext: 'mp4', seconds: N / fps };
    }
    // MediaRecorder: el lienzo se publica cuadro por cuadro y se espera el tiempo real de cada uno
    const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    const rec = new MediaRecorder(stream, { mimeType: encoder.mime, videoBitsPerSecond: bitrateFor(W, H, fps) });
    const parts: Blob[] = [];
    rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
    const stopped = new Promise<void>(r => { rec.onstop = () => r(); });
    rec.start(1000);
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      if (job.cancelled()) { rec.stop(); await stopped; return null; }
      const ov = job.overlay(i);
      await session.frame(i ? 1 / fps : 0, f => composeFrame(ctx, f, ov), { maxWaitMs: i ? 3000 : 15000 });
      track.requestFrame();
      job.onProgress(i + 1);
      const wait = t0 + ((i + 1) * 1000) / fps - performance.now();
      if (wait > 0) await sleep(wait);
    }
    rec.stop();
    await stopped;
    return { blob: new Blob(parts, { type: encoder.mime.split(';')[0] }), ext: encoder.mime.includes('mp4') ? 'mp4' : 'webm', seconds: N / fps };
  } finally {
    session?.end();
  }
}

/** Imagen grande (4K u 8K) de la vista actual con etiquetas y créditos; espera todas las teselas de detalle. */
export async function recordStill(map: MapApi, width: number, height: number, overlay: Overlay): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const session = map.capture({ width, height });
  try {
    await session.frame(0, f => composeFrame(ctx, f, overlay), { still: true, maxWaitMs: 25000 });
  } finally {
    session.end();
  }
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('No se pudo generar la imagen'))), 'image/png'));
}
