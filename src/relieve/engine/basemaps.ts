import * as THREE from 'three';
import { USV_GROUPS } from '../shared/usv';
import type { BaseMapId } from '../shared/basemaps';
import { fetchBin } from '../worker/decode';

export type { BaseMapId } from '../shared/basemaps';
export { BASE_MAPS } from '../shared/basemaps';

export interface LoadedBaseMap {
  /** 1 = imagen (sRGB), 2 = clases (índice por texel + paleta; el sombreador suaviza los bordes entre clases) */
  kind: 1 | 2;
  texture: THREE.Texture;
  /** texeles de la textura */
  size: [number, number];
  /** clases: color sRGB por índice (256 × RGBA; alfa 0 = sin dato) */
  lut?: Uint8Array;
  /** imagen con teselas finas al acercarse (satélite) */
  tiles?: boolean;
  /** descripción del punto para la ficha del cursor (p. ej. la clase de uso de suelo) */
  describe?(col: number, row: number): string | null;
}

export interface BaseMapUrls { usvBin: string; usvJson: string; sat: string }

const hexRGB = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

/** Uso de suelo: rejilla de clases (≈ 65 m) con la paleta por grupo; W = columnas de la rejilla del visor. */
async function loadUsv(urls: BaseMapUrls, W: number): Promise<LoadedBaseMap> {
  const [bin, meta] = await Promise.all([fetchBin(urls.usvBin), fetch(urls.usvJson).then(r => r.json() as Promise<{ clases: { nombre: string; grupo: number; sec: boolean }[] }>)]);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  if (dv.getUint32(0, true) !== 0x31555248) throw new Error('usv.bin no es un archivo RHU1');
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true), cls = bin.slice(12, 12 + w * h);
  // color por clase: el de su grupo; la vegetación secundaria, más clara y apagada
  const lut = new Uint8Array(256 * 4);
  meta.clases.forEach((c, i) => {
    let [r, g, b] = hexRGB(USV_GROUPS[c.grupo].color);
    if (c.sec) { r = r * 0.62 + 168 * 0.38; g = g * 0.62 + 170 * 0.38; b = b * 0.62 + 128 * 0.38; }
    lut.set([Math.round(r), Math.round(g), Math.round(b), 255], (i + 1) * 4);
  });
  const tex = new THREE.DataTexture(cls, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  const S = w / (W - 1);
  return {
    kind: 2, texture: tex, size: [w, h], lut,
    describe: (col, row) => {
      const x = Math.floor(col * S), y = Math.floor(row * S);
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
  const size: [number, number] = [bmp.width, bmp.height];
  tex.onUpdate = () => bmp.close();
  return { kind: 1, texture: tex, size, tiles: true };
}

export function loadBaseMap(id: Exclude<BaseMapId, 'altitud'>, urls: BaseMapUrls, anisotropy: number, W: number) {
  const p = id === 'usodesuelo' ? loadUsv(urls, W) : loadSatellite(urls.sat);
  return p.then(b => { if (b.kind === 1) b.texture.anisotropy = anisotropy; return b; });
}
