import { buildWeather, type WeatherGrid } from '../shared/clouds';
import { fetchBin } from './decode';

export interface CloudWeatherRequest {
  /** capas/lluvia.bin */
  url: string;
  elev: Float32Array;
  muni: Uint8Array;
  W: number;
  H: number;
  cellKm: number;
}
export interface CloudWeatherResult { grid: WeatherGrid; warning?: string }

const ctx = self as unknown as {
  postMessage(msg: CloudWeatherResult, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<CloudWeatherRequest>) => void) | null;
};

/** Clima de las nubes fuera del hilo principal: baja la lluvia media anual y arma la rejilla gruesa (clouds.ts). */
ctx.onmessage = async ev => {
  const { url, elev, muni, W, H, cellKm } = ev.data;
  let rain: Uint8Array | null = null, warning: string | undefined;
  try {
    const bin = await fetchBin(url);
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    if (dv.getUint32(0, true) === 0x31555248 && dv.getUint32(4, true) === W && dv.getUint32(8, true) === H) rain = bin.subarray(12, 12 + W * H);
    else warning = 'lluvia.bin no coincide con la rejilla; las nubes se reparten parejo.';
  } catch (e) {
    warning = `nubes sin la lluvia media anual (${e instanceof Error ? e.message : String(e)}).`;
  }
  const grid = buildWeather(elev, muni, W, H, cellKm, rain);
  ctx.postMessage({ grid, warning }, [grid.data.buffer]);
};
