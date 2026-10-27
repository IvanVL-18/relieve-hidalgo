import * as THREE from 'three';
import { USV_GROUPS } from '../shared/usv';
import type { BaseMapId } from '../shared/basemaps';
import { fetchBin } from '../worker/decode';

export type { BaseMapId } from '../shared/basemaps';
export { BASE_MAPS } from '../shared/basemaps';

export interface LoadedBaseMap {
  texture: THREE.Texture;
  /** descripción del punto para la ficha del cursor (p. ej. la clase de uso de suelo) */
  describe?(col: number, row: number): string | null;
}

export interface BaseMapUrls { usvBin: string; usvJson: string; sat: string }

const hexRGB = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

async function loadUsv(urls: BaseMapUrls): Promise<LoadedBaseMap> {
  const [bin, meta] = await Promise.all([fetchBin(urls.usvBin), fetch(urls.usvJson).then(r => r.json() as Promise<{ clases: { nombre: string; grupo: number; sec: boolean }[] }>)]);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  if (dv.getUint32(0, true) !== 0x31555248) throw new Error('usv.bin no es un archivo RHU1');
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true), cls = bin.subarray(12, 12 + w * h);
  // color por clase: el de su grupo; la vegetación secundaria, más clara y apagada
  const lut = new Uint8Array(256 * 4);
  meta.clases.forEach((c, i) => {
    let [r, g, b] = hexRGB(USV_GROUPS[c.grupo].color);
    if (c.sec) { r = r * 0.62 + 168 * 0.38; g = g * 0.62 + 170 * 0.38; b = b * 0.62 + 128 * 0.38; }
    lut.set([r, g, b, 255], (i + 1) * 4);
  });
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { const k = cls[i] * 4; rgba[i * 4] = lut[k]; rgba[i * 4 + 1] = lut[k + 1]; rgba[i * 4 + 2] = lut[k + 2]; rgba[i * 4 + 3] = 255; }
  const tex = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.onUpdate = () => { (tex.image as { data: Uint8Array | null }).data = null; };
  return {
    texture: tex,
    describe: (col, row) => {
      const x = Math.round(col * 2 - 0.5), y = Math.round(row * 2 - 0.5);
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      const c = cls[y * w + x];
      return c ? meta.clases[c - 1].nombre : null;
    },
  };
}

async function loadSatellite(url: string): Promise<LoadedBaseMap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar la imagen satelital (${res.status})`);
  const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'none', premultiplyAlpha: 'none' });
  const tex = new THREE.Texture(bmp);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.onUpdate = () => bmp.close();
  return { texture: tex };
}

export function loadBaseMap(id: Exclude<BaseMapId, 'altitud'>, urls: BaseMapUrls, anisotropy: number) {
  const p = id === 'usodesuelo' ? loadUsv(urls) : loadSatellite(urls.sat);
  return p.then(b => { b.texture.anisotropy = anisotropy; return b; });
}
