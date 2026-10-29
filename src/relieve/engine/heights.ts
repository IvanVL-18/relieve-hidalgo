import * as THREE from 'three';

/**
 * Superficie del relieve en la GPU, compartida por el terreno, las paredes, las luces y las capas de los análisis:
 * todo lo que se apoya en el relieve lo hace sobre la misma superficie, sea cual sea el nivel de detalle.
 *   270 m siempre (tH0) · 90 m (tH1) al acercarse, si ya llegó · 30 m (atlas tH2) donde hay tesela cargada
 * La mezcla depende de la distancia a la cámara (km, con la altura exagerada), igual en todos los sombreadores, así
 * que dos objetos en el mismo punto calculan la misma altura.
 */

const tex = (data: ArrayBufferView, format: THREE.PixelFormat, type: THREE.TextureDataType, w = 1, h = 1) => {
  const t = new THREE.DataTexture(data as never, w, h, format, type);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
};
/** Texturas de 1 × 1 del tipo correcto para los muestreadores sin dato (un usampler2D necesita una entera). */
export const blankFloat = () => tex(new Float32Array(1), THREE.RedFormat, THREE.FloatType);
export const blankUint2 = () => tex(new Uint16Array(2), THREE.RGIntegerFormat, THREE.UnsignedShortType);
export const blankBytes = (rgba: number[] = [0, 0, 0, 0]) => tex(new Uint8Array(rgba), THREE.RGBAFormat, THREE.UnsignedByteType);

export function makeHeightUniforms() {
  return {
    /** 270 m, R32F (m) */
    tH0: { value: blankFloat() as THREE.Texture },
    /** x0, z0 (km) del nodo (0, 0) y km por celda en x y z */
    uGridMap: { value: new THREE.Vector4(0, 0, 1, 1) },
    /** cámara en km locales, con la altura exagerada */
    uCamE: { value: new THREE.Vector3() },
    uEx: { value: 1 },
    /** distancias (km) de la mezcla: 90 m entero hasta x y nada desde y; 30 m entero hasta z y nada desde w */
    uLod: { value: new THREE.Vector4(60, 100, 14, 24) },
    /** 90 m, R32F (m, 0 = sin dato); uH1On = aparición (0–1) */
    tH1: { value: blankFloat() as THREE.Texture },
    uH1On: { value: 0 },
    /** atlas de 30 m, RG16UI (altura en cuartos de metro, normal empacada) y páginas (ranura, aparición, residente) */
    tH2: { value: blankUint2() as THREE.Texture },
    tPages: { value: blankBytes() as THREE.Texture },
    /** teselas en x e y, nodos por ranura del atlas, nodos finos por tesela */
    uPage2: { value: new THREE.Vector4(1, 1, 145, 144) },
    uH2On: { value: 0 },
  };
}
export type HeightUniforms = ReturnType<typeof makeHeightUniforms>;

/** Defines de los sombreadores que usan la superficie: RH_DETAIL (90 m) y RH_TILES (30 m). */
export const heightDefines = (detail: boolean, tiles: boolean): Record<string, string> => ({
  ...(detail ? { RH_DETAIL: '' } : {}),
  ...(tiles ? { RH_TILES: '' } : {}),
});

/** Declaraciones y funciones (vértices). g = coordenadas en celdas de la rejilla del visor (columna, fila). */
export const HEIGHT_GLSL = /* glsl */ `
uniform highp sampler2D tH0;
uniform vec4 uGridMap; uniform vec3 uCamE; uniform float uEx; uniform vec4 uLod;
#ifdef RH_DETAIL
uniform highp sampler2D tH1; uniform float uH1On;
#endif
#ifdef RH_TILES
uniform highp usampler2D tH2; uniform highp sampler2D tPages; uniform vec4 uPage2; uniform float uH2On;
#endif
vec2 rhXZ(vec2 g) { return uGridMap.xy + g * uGridMap.zw; }
vec2 rhGridOf(vec2 xz) { return (xz - uGridMap.xy) / uGridMap.zw; }
// bilineal con texelFetch (los flotantes de 32 bits no se filtran en todos los equipos); lo = mínimo de los cuatro
float rhBilinear(highp sampler2D t, vec2 p, out float lo) {
  ivec2 mx = textureSize(t, 0) - 1;
  p = clamp(p, vec2(0.0), vec2(mx) - 0.001);
  ivec2 b = ivec2(p); vec2 f = p - vec2(b);
  float a = texelFetch(t, b, 0).r, c = texelFetch(t, b + ivec2(1, 0), 0).r;
  float d = texelFetch(t, b + ivec2(0, 1), 0).r, e = texelFetch(t, b + ivec2(1, 1), 0).r;
  lo = min(min(a, c), min(d, e));
  return mix(mix(a, c, f.x), mix(d, e, f.x), f.y);
}
float rhH0(vec2 g) { float lo; return rhBilinear(tH0, g, lo); }
// distancia (km) de la cámara al punto g con altura hM (m), con la altura exagerada
float rhDistE(vec2 g, float hM) { vec2 xz = rhXZ(g); return distance(vec3(xz.x, hM * 0.001 * uEx, xz.y), uCamE); }
#ifdef RH_TILES
// página de la tesela de 30 m del nodo fino p: rg = ranura del atlas, b = aparición, a = cargada; local = nodo en la tesela
vec4 rhPage2(vec2 p, out vec2 local) {
  vec2 t = floor(p / uPage2.w);
  local = p - t * uPage2.w;
  if (t.x < 0.0 || t.y < 0.0 || t.x >= uPage2.x || t.y >= uPage2.y) return vec4(0.0);
  return texelFetch(tPages, ivec2(t), 0);
}
// altura de 30 m (m); w = peso de la tesela (0 si no está cargada o falta algún nodo)
float rhH2(vec2 g, out float w) {
  vec2 local; vec4 pg = rhPage2(g * 9.0, local);
  w = 0.0;
  if (pg.a < 0.5) return 0.0;
  vec2 q = clamp(local, vec2(0.0), vec2(uPage2.w - 0.001));
  ivec2 b = ivec2(q); vec2 f = q - vec2(b);
  ivec2 o = ivec2(floor(pg.rg * 255.0 + 0.5)) * int(uPage2.z) + b;
  float a = float(texelFetch(tH2, o, 0).r), c = float(texelFetch(tH2, o + ivec2(1, 0), 0).r);
  float d = float(texelFetch(tH2, o + ivec2(0, 1), 0).r), e = float(texelFetch(tH2, o + ivec2(1, 1), 0).r);
  if (min(min(a, c), min(d, e)) < 0.5) return 0.0;
  w = pg.b;
  return mix(mix(a, c, f.x), mix(d, e, f.x), f.y) * 0.25;
}
#endif
// superficie que se dibuja (m) en g, con h0 = altura de 270 m y dist = distancia a la cámara (km)
float rhSurfaceAt(vec2 g, float h0, float dist) {
  float h = h0;
  #ifdef RH_DETAIL
  float a1 = uH1On * (1.0 - smoothstep(uLod.x, uLod.y, dist));
  if (a1 > 0.0) { float lo; float h1 = rhBilinear(tH1, g * 3.0, lo); if (lo > 0.0) h = mix(h, h1, a1); }
  #endif
  #ifdef RH_TILES
  float a2 = uH2On * (1.0 - smoothstep(uLod.z, uLod.w, dist));
  if (a2 > 0.0) { float w; float h2 = rhH2(g, w); if (w > 0.0) h = mix(h, h2, a2 * w); }
  #endif
  return h;
}
float rhSurface(vec2 g) { float h0 = rhH0(g); return rhSurfaceAt(g, h0, rhDistE(g, h0)); }
`;

/** Añade la superficie a un material de three (onBeforeCompile): uniformes compartidas y defines. */
export function withHeights(sh: { uniforms: Record<string, THREE.IUniform>; vertexShader: string }, hu: HeightUniforms) {
  Object.assign(sh.uniforms, hu);
  sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${HEIGHT_GLSL}`);
}
