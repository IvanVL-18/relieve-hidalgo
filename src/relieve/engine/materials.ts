import * as THREE from 'three';
import { BASE_KM } from '../shared/geo';
import { HEIGHT_GLSL, withHeights, type HeightUniforms } from './heights';

/** Ruido de valor y fbm en GLSL (nubes, ondas del agua, estratos). */
const NOISE = /* glsl */ `
float rhHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float rhNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rhHash(i), rhHash(i + vec2(1.0, 0.0)), u.x), mix(rhHash(i + vec2(0.0, 1.0)), rhHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float rhFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { s += a * rhNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s / 0.9375;
}`;

/** Bruma por distancia, relativa a la distancia de la cámara a su objetivo: solo se nota al volar bajo. */
const HAZE_PARS = /* glsl */ `uniform vec3 uHazeColor; uniform float uHazeAmt; uniform float uHazeRef;`;
const HAZE = /* glsl */ `
  float rhD = length(vViewPosition) / max(uHazeRef, 1e-4);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uHazeColor, smoothstep(0.9, 3.4, rhD) * uHazeAmt);`;

export function makeSharedUniforms() {
  return {
    uTime: { value: 0 },
    uNight: { value: 0 },
    uClouds: { value: 1 },
    uWind: { value: new THREE.Vector2(0.006, 0.0025) },
    /** sRGB de salida: se mezcla después de la conversión de color */
    uHazeColor: { value: new THREE.Vector3(0.66, 0.73, 0.8) },
    uHazeAmt: { value: 0.45 },
    uHazeRef: { value: 3 },
  };
}
export type SharedUniforms = ReturnType<typeof makeSharedUniforms>;

/** Textura de 1×1 para los muestreadores sin usar. */
export const blankTexture = (rgba: [number, number, number, number] = [255, 255, 255, 0]) => {
  const t = new THREE.DataTexture(new Uint8Array(rgba), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
};

/** Filas de la paleta compartida (256 × 8, sRGB): una sola textura para todas las rampas y tablas de color. */
export const PALETTE_ROW = { choro: 0, alt: 1, baseA: 2, baseB: 3, raster0: 4, raster1: 5 } as const;
export const PALETTE_ROWS = 8;

export interface TerrainTextures {
  /** RG8 a ~50 m: municipio y distancia con signo al contorno del estado */
  muni: THREE.Texture;
  /** RGBA8 por nodo de la rejilla: oclusión, brillo nocturno, normal (x, z) de 270 m */
  fields: THREE.Texture;
  palette: THREE.DataTexture;
}

export function makeTerrainUniforms(shared: SharedUniforms, hu: HeightUniforms, t: TerrainTextures, W: number, H: number) {
  const mi = t.muni.image as { width: number; height: number };
  const vec2 = (x = 1, y = 1) => ({ value: new THREE.Vector2(x, y) });
  const vec4 = () => ({ value: new THREE.Vector4() });
  return {
    ...shared,
    ...hu,
    uGridMax: vec2(W - 1, H - 1),
    tMuni: { value: t.muni },
    /** nodos − 1 de la rejilla de municipios */
    uGrid: vec2(mi.width - 1, mi.height - 1),
    tFields: { value: t.fields },
    uFieldsSize: vec2(W, H),
    tPalette: { value: t.palette },
    /** mapas base: tipo 0 = ninguno (color por altitud), 1 = imagen, 2 = clases (índice + paleta); uBaseTex = fundido */
    uBaseKindA: { value: 0 }, tBaseA: { value: blankTexture() as THREE.Texture }, uBaseSizeA: vec2(), uBaseTilesA: { value: 0 },
    uBaseTex: { value: 0 },
    uBaseKindB: { value: 0 }, tBaseB: { value: blankTexture() as THREE.Texture }, uBaseSizeB: vec2(), uBaseTilesB: { value: 0 },
    /** cortina para comparar: x en píxeles del lienzo (−1 = sin cortina) */
    uCurtain: { value: -1 },
    /** capas raster de los análisis: map = uv de la capa desde la del terreno; par = modo, opacidad, lado, suave */
    tR0: { value: blankTexture() as THREE.Texture }, uR0Map: vec4(), uR0Par: vec4(), uR0Size: vec2(),
    tR1: { value: blankTexture() as THREE.Texture }, uR1Map: vec4(), uR1Par: vec4(), uR1Size: vec2(),
    uHover: { value: 0 },
    uSel: { value: 0 },
    uContours: { value: 0 },
    uBorders: { value: 1 },
    uWater: { value: 1 },
    uChoroAmt: { value: 0 },
    /** campos de distancia de ríos, límites y presas (LinesResult); uLines = 0 mientras no llegan */
    tLines: { value: blankTexture([255, 255, 255, 0]) as THREE.Texture },
    uLines: { value: 0 },
    uLinesSize: { value: 1 },
    uLinesRange: { value: 1 },
    /** metros por texel de tLines */
    uLinesTexelM: { value: 1 },
    /** relieve de 90 m: normal (x, z) y apertura del cielo; uDetail = aparición; (escala, desplazamiento) de la normal */
    tDetail: { value: blankTexture([0, 0, 255, 255]) as THREE.Texture },
    uDetail: { value: 0 },
    uDetailSize: vec2(),
    uDetailEnc: vec2(1, 0),
    /** imagen satelital fina: atlas y páginas (teselas x, y; fila inicial en tPages; celdas por tesela) */
    tSatAtlas: { value: blankTexture() as THREE.Texture },
    uSatPage: vec4(),
    uSatSlot: { value: 256 },
    uSatAtlasSize: vec2(),
    uRock: { value: new THREE.Color('#6e5d4c') },
    uWaterShallow: { value: new THREE.Color('#3b7f8c') },
    uWaterDeep: { value: new THREE.Color('#1b4a63') },
    uSkyRefl: { value: new THREE.Color('#9fc3dc') },
    uCityLight: { value: new THREE.Color('#ffb35c').multiplyScalar(1.15) },
  };
}
export type TerrainUniforms = ReturnType<typeof makeTerrainUniforms>;

/** Vértices de los parches del relieve (terrain.ts): posición, fundido entre niveles y altura (heights.ts). */
const PATCH_VERTEX = /* glsl */ `
  vec2 gp = position.xz;
  vec2 g = aPatch.xy + gp * aPatch.z;
  float h0 = rhH0(g);
  float morph = clamp((rhDistE(g, h0) - aPatch.w) / max(aMorph - aPatch.w, 1e-3), 0.0, 1.0);
  // los vértices impares se funden con el par vecino al acercarse al rango del nivel más grueso
  g -= fract(gp * 0.5) * 2.0 * aPatch.z * morph;
  h0 = rhH0(g);`;

/** Material del relieve. Las capas raster (RH_RASTERS) y la cortina (RH_COMPARE) se cambian en mat.defines + needsUpdate. */
export function createTerrainMaterial(u: TerrainUniforms, defines: Record<string, string>) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0 });
  // el recorte por el contorno da alfa < 1 en la orilla: con MSAA es cobertura; sin MSAA, el lienzo transparente la suaviza
  mat.alphaToCoverage = true;
  mat.defines = { ...defines, RH_RASTERS: '0' };
  mat.customProgramCacheKey = () => `rh-terrain-${mat.defines!.RH_RASTERS}-${'RH_COMPARE' in mat.defines! ? 1 : 0}`;
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aPatch; attribute float aMorph;
        uniform vec2 uGridMax;
        varying vec2 vWUv; varying vec2 vG; varying float vHM; varying vec2 vXZ;
        ${HEIGHT_GLSL}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', `${PATCH_VERTEX}
        float hM = rhSurfaceAt(g, h0, rhDistE(g, h0));
        vec2 xz = rhXZ(g);
        vec3 transformed = vec3(xz.x, hM * 0.001, xz.y);
        // la sombra se consulta sobre el relieve de 270 m, el mismo que la proyecta (si no, el relieve fino de cerca
        // sobresale del volumen de sombra y las crestas dejan de sombrear)
        vec4 rhShadowWorld = modelMatrix * vec4(xz.x, h0 * 0.001, xz.y, 1.0);
        vG = g; vWUv = g / uGridMax; vHM = hM; vXZ = xz;`)
      .replace('#include <shadowmap_vertex>', THREE.ShaderChunk.shadowmap_vertex.replace(/worldPosition/g, 'rhShadowWorld'));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uHover; uniform float uSel; uniform float uContours; uniform float uBorders; uniform float uWater;
        uniform float uClouds; uniform float uNight; uniform float uTime; uniform float uChoroAmt; uniform vec2 uWind;
        uniform sampler2D tMuni; uniform vec2 uGrid; uniform vec2 uGridMax;
        uniform sampler2D tFields; uniform vec2 uFieldsSize; uniform sampler2D tPalette;
        uniform float uBaseKindA; uniform sampler2D tBaseA; uniform vec2 uBaseSizeA; uniform float uBaseTilesA; uniform float uBaseTex;
        uniform float uCurtain;
        uniform sampler2D tLines; uniform float uLines; uniform float uLinesSize; uniform float uLinesRange; uniform float uLinesTexelM;
        uniform mat3 normalMatrix;
        uniform vec3 uRock; uniform vec3 uWaterShallow; uniform vec3 uWaterDeep; uniform vec3 uSkyRefl; uniform vec3 uCityLight;
        #ifdef RH_COMPARE
        uniform float uBaseKindB; uniform sampler2D tBaseB; uniform vec2 uBaseSizeB; uniform float uBaseTilesB;
        #endif
        #if RH_RASTERS > 0
        uniform sampler2D tR0; uniform vec4 uR0Map; uniform vec4 uR0Par; uniform vec2 uR0Size;
        #endif
        #if RH_RASTERS > 1
        uniform sampler2D tR1; uniform vec4 uR1Map; uniform vec4 uR1Par; uniform vec2 uR1Size;
        #endif
        #ifdef RH_DETAIL
        uniform sampler2D tDetail; uniform float uDetail; uniform vec2 uDetailSize; uniform vec2 uDetailEnc;
        #endif
        #ifdef RH_TILES
        uniform highp usampler2D tH2; uniform highp sampler2D tPages; uniform vec4 uPage2;
        uniform sampler2D tSatAtlas; uniform vec4 uSatPage; uniform float uSatSlot; uniform vec2 uSatAtlasSize;
        #endif
        ${HAZE_PARS}
        varying vec2 vWUv; varying vec2 vG; varying float vHM; varying vec2 vXZ;
        float rhWater; float rhDim; float rhGlow; float rhAOv; float rhGpp; vec3 rhNm;
        ${NOISE}
        vec2 rhMuni2(ivec2 p) { return texelFetch(tMuni, clamp(p, ivec2(0), ivec2(uGrid)), 0).rg; }
        vec4 rhPal(float row, float i) { return textureLod(tPalette, vec2((i + 0.5) / 256.0, (row + 0.5) / ${PALETTE_ROWS}.0), 0.0); }
        vec4 rhChoro(float m) { vec4 c = rhPal(0.0, m); return vec4(c.rgb * c.a, c.a); }
        // borde suave: fracción bilineal de las 4 celdas vecinas que pertenecen al municipio m
        float rhShare(float m, vec4 ids, vec4 w) { return dot(vec4(equal(ids, vec4(m))), w); }
        float contourLine(float h, float dh, float interval, float width) {
          float d = abs(fract(h / interval - 0.5) - 0.5) / max(dh / interval, 1e-4);
          return 1.0 - clamp(d / width, 0.0, 1.0);
        }
        // clases (índice R8 + fila de la paleta) con bordes suaves: gana la clase con más peso bilineal entre los cuatro
        // texeles vecinos y se mezcla con la segunda en la orilla. aa = texeles por píxel.
        vec4 rhClasses(sampler2D t, vec2 size, vec2 uv, float row, float aa) {
          vec2 p = uv * size - 0.5, f = fract(p);
          ivec2 b = ivec2(floor(p)), mx = ivec2(size) - 1;
          vec4 c = floor(vec4(texelFetch(t, clamp(b, ivec2(0), mx), 0).r, texelFetch(t, clamp(b + ivec2(1, 0), ivec2(0), mx), 0).r,
            texelFetch(t, clamp(b + ivec2(0, 1), ivec2(0), mx), 0).r, texelFetch(t, clamp(b + ivec2(1, 1), ivec2(0), mx), 0).r) * 255.0 + 0.5);
          vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
          vec4 s = vec4(dot(vec4(equal(c, vec4(c.x))), w), dot(vec4(equal(c, vec4(c.y))), w), dot(vec4(equal(c, vec4(c.z))), w), dot(vec4(equal(c, vec4(c.w))), w));
          float c1 = c.x, s1 = s.x;
          if (s.y > s1) { c1 = c.y; s1 = s.y; } if (s.z > s1) { c1 = c.z; s1 = s.z; } if (s.w > s1) { c1 = c.w; s1 = s.w; }
          float c2 = c1, s2 = 0.0;
          if (c.x != c1 && s.x > s2) { c2 = c.x; s2 = s.x; } if (c.y != c1 && s.y > s2) { c2 = c.y; s2 = s.y; }
          if (c.z != c1 && s.z > s2) { c2 = c.z; s2 = s.z; } if (c.w != c1 && s.w > s2) { c2 = c.w; s2 = s.w; }
          float k = smoothstep(-0.5, 0.5, (s1 - s2) / max(aa * 0.6, 0.05));
          vec4 a = rhPal(row, c1), z = rhPal(row, c2);
          return mix(z, a, s2 > 0.0 ? k : 1.0);
        }
        #ifdef RH_TILES
        // imagen satelital fina; w = peso (aparición × que el atlas no se vea más chico que la pantalla)
        vec3 rhSatTile(out float w) {
          vec2 t = floor(vG / uSatPage.w);
          w = 0.0;
          if (t.x < 0.0 || t.y < 0.0 || t.x >= uSatPage.x || t.y >= uSatPage.y) return vec3(0.0);
          vec4 pg = texelFetch(tPages, ivec2(t) + ivec2(0, int(uSatPage.z)), 0);
          if (pg.a < 0.5) return vec3(0.0);
          vec2 local = (vG - t * uSatPage.w) / uSatPage.w;
          vec2 px = floor(pg.rg * 255.0 + 0.5) * uSatSlot + clamp(local * uSatSlot, vec2(0.5), vec2(uSatSlot - 0.5));
          w = pg.b * (1.0 - smoothstep(1.2, 2.4, rhGpp * uSatSlot / uSatPage.w));
          return textureLod(tSatAtlas, px / uSatAtlasSize, 0.0).rgb;
        }
        // normal de 30 m (x, z) desde el atlas; w = aparición de la tesela
        vec2 rhN2(out float w) {
          vec2 p = vG * 9.0, t = floor(p / uPage2.w), q = clamp(p - t * uPage2.w, vec2(0.0), vec2(uPage2.w - 0.001));
          w = 0.0;
          if (t.x < 0.0 || t.y < 0.0 || t.x >= uPage2.x || t.y >= uPage2.y) return vec2(0.0);
          vec4 pg = texelFetch(tPages, ivec2(t), 0);
          if (pg.a < 0.5) return vec2(0.0);
          ivec2 b = ivec2(q); vec2 f = q - vec2(b);
          ivec2 o = ivec2(floor(pg.rg * 255.0 + 0.5)) * int(uPage2.z) + b;
          uint a = texelFetch(tH2, o, 0).g, c = texelFetch(tH2, o + ivec2(1, 0), 0).g;
          uint d = texelFetch(tH2, o + ivec2(0, 1), 0).g, e = texelFetch(tH2, o + ivec2(1, 1), 0).g;
          vec2 na = vec2(float(a >> 8u), float(a & 255u)), nc = vec2(float(c >> 8u), float(c & 255u));
          vec2 nd = vec2(float(d >> 8u), float(d & 255u)), ne = vec2(float(e >> 8u), float(e & 255u));
          w = pg.b;
          return mix(mix(na, nc, f.x), mix(nd, ne, f.x), f.y) / 127.5 - 1.0;
        }
        #endif
        // mapa base: imagen (con teselas finas) o clases; alfa = cobertura
        vec4 rhBase(float kind, sampler2D t, vec2 size, float row, float tiles) {
          if (kind < 0.5) return vec4(0.0);
          if (kind > 1.5) return rhClasses(t, size, vWUv, row, rhGpp * size.x / uGridMax.x);
          vec3 c = texture2D(t, vWUv).rgb;
          #ifdef RH_TILES
          if (tiles > 0.5) { float w; vec3 tc = rhSatTile(w); c = mix(c, tc, w); }
          #endif
          return vec4(c, 1.0);
        }
        // capa raster: par.x modo (0 rgba, 1 valor + paleta, 2 clases), y opacidad, z lado (0 ambos, 1 izq., 2 der.), w suave
        vec4 rhRaster(sampler2D t, vec4 map, vec4 par, vec2 size, float row) {
          vec2 luv = vec2(map.x + map.y * vWUv.x, map.z + map.w * vWUv.y);
          if (par.y <= 0.0 || luv.x < 0.0 || luv.y < 0.0 || luv.x > 1.0 || luv.y > 1.0) return vec4(0.0);
          if (par.z > 0.5 && uCurtain >= 0.0 && ((gl_FragCoord.x > uCurtain) != (par.z > 1.5))) return vec4(0.0);
          vec4 c;
          if (par.x < 0.5) c = textureLod(t, luv, 0.0);
          else if (par.x < 1.5) { vec4 v = textureLod(t, luv, 0.0); c = rhPal(row, floor(v.r * 255.0 + 0.5)); c.a *= v.g; }
          else if (par.w > 0.5) c = rhClasses(t, size, luv, row, rhGpp * map.y * size.x / uGridMax.x);
          else c = rhPal(row, floor(texelFetch(t, clamp(ivec2(luv * size), ivec2(0), ivec2(size) - 1), 0).r * 255.0 + 0.5));
          return vec4(c.rgb, c.a * par.y);
        }`)
      .replace('#include <color_fragment>', `
        // derivadas primero, fuera de ramas y antes de descartar
        rhGpp = max(max(fwidth(vG.x), fwidth(vG.y)), 1e-6);
        vec2 dUv = vec2(fwidth(vWUv.x), fwidth(vWUv.y));
        float dH = fwidth(vHM);
        // municipios (50 m) y contorno del estado: los 4 nodos vecinos
        vec2 tc = vWUv * uGrid, tf = fract(tc);
        ivec2 tb = ivec2(floor(tc));
        vec2 m00 = rhMuni2(tb), m10 = rhMuni2(tb + ivec2(1, 0)), m01 = rhMuni2(tb + ivec2(0, 1)), m11 = rhMuni2(tb + ivec2(1, 1));
        vec4 ids = floor(vec4(m00.x, m10.x, m01.x, m11.x) * 255.0 + 0.5);
        vec4 tw = vec4((1.0 - tf.x) * (1.0 - tf.y), tf.x * (1.0 - tf.y), (1.0 - tf.x) * tf.y, tf.x * tf.y);
        // distancia al contorno en nodos de 50 m (> 0 fuera): el terreno se recorta sobre el polígono de INEGI
        float sd = (dot(vec4(m00.y, m10.y, m01.y, m11.y), tw) * 255.0 - 128.0) * (6.0 / 127.0);
        float sdAA = max(fwidth(sd), 1e-4);
        float hovS = rhShare(uHover, ids, tw), selS = rhShare(uSel, ids, tw);
        float hovAA = max(fwidth(hovS), 1e-3) * 0.75, selAA = max(fwidth(selS), 1e-3) * 0.75;
        if (sd > 0.5 * sdAA) discard;
        // campos de 270 m: oclusión, brillo nocturno, normal
        vec4 fl = texture2D(tFields, (vG + 0.5) / uFieldsSize);
        vec2 dn = fl.ba * 2.0 - 1.0;
        rhAOv = fl.r; rhGlow = fl.g;
        #ifdef RH_DETAIL
        // texeles del relieve de 90 m centrados en sus nodos
        vec4 det = texture2D(tDetail, (vG * 3.0 + 0.5) / uDetailSize);
        dn = mix(dn, det.rg * uDetailEnc.x + uDetailEnc.y, uDetail);
        rhAOv = mix(rhAOv, mix(0.3, 1.0, smoothstep(0.6, 0.97, det.b)), uDetail);
        #endif
        #ifdef RH_TILES
        // la normal de 30 m solo en laderas: en lo plano el relieve de INEGI trae un rayado que se vería como grano
        { float w2; vec2 n2 = rhN2(w2); dn = mix(dn, n2, w2 * (1.0 - smoothstep(1.5, 3.0, rhGpp * 9.0)) * smoothstep(0.03, 0.12, length(dn))); }
        #endif
        rhNm = vec3(dn.x, sqrt(max(0.0, 1.0 - dot(dn, dn))), dn.y);
        // color por altitud (de la superficie dibujada) con una variación suave; roca en laderas fuertes
        vec3 tint = textureLod(tPalette, vec2(clamp(vHM / 3400.0, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 1.5 / ${PALETTE_ROWS}.0), 0.0).rgb;
        tint *= 0.97 + 0.06 * (0.6 * rhNoise(vG / 7.0 + 90.0) + 0.4 * rhNoise(vG / 3.5 + 37.0));
        tint = mix(tint, uRock, clamp((degrees(asin(clamp(length(dn), 0.0, 1.0))) - 16.0) / 30.0, 0.0, 0.55));
        vec4 base = rhBase(uBaseKindA, tBaseA, uBaseSizeA, 2.0, uBaseTilesA);
        float baseAmt = uBaseTex;
        #ifdef RH_COMPARE
        vec4 baseB = rhBase(uBaseKindB, tBaseB, uBaseSizeB, 3.0, uBaseTilesB);
        if (uCurtain >= 0.0 && gl_FragCoord.x > uCurtain) { base = baseB; baseAmt = 1.0; }
        #endif
        diffuseColor.rgb = mix(tint, base.rgb, base.a * baseAmt);
        if (uContours > 0.0) {
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, contourLine(vHM, dH, 100.0, 1.0) * 0.55 * uContours);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.035, 0.03), contourLine(vHM, dH, 500.0, 1.4) * 0.8 * uContours);
        }
        // ríos, presas y límites desde sus campos de distancia: grosor fijo en pantalla y ancho real al acercarse
        float bline = 0.0, deep = 0.0;
        rhWater = 0.0;
        if (uLines > 0.0) {
          vec4 lf = texture2D(tLines, vWUv);
          float tpp = max(max(dUv.x, dUv.y) * uLinesSize, 1e-4);   // texeles por píxel
          float mpp = tpp * uLinesTexelM;                           // metros por píxel
          float acc = lf.a;
          float halfPx = 0.5 * max(mix(0.8, 2.6, pow(acc, 1.2)), mix(8.0, 90.0, pow(acc, 1.5)) / mpp);
          float river = (1.0 - smoothstep(halfPx - 0.6, halfPx + 0.6, lf.r * uLinesRange / tpp)) * step(lf.r, 0.996);
          // los arroyos se atenúan al alejarse; los ríos grandes no
          river *= mix(clamp(1.2 / tpp, 0.25, 1.0), 1.0, smoothstep(0.05, 0.4, acc));
          float dLake = (lf.b * 255.0 - 128.0) / 127.0 * uLinesRange;   // texeles, negativo dentro
          float lake = 1.0 - smoothstep(-0.6, 0.6, dLake / tpp);
          rhWater = max(river, lake) * uWater;
          deep = max(smoothstep(0.5, 7.0, -dLake), smoothstep(0.3, 1.0, acc) * 0.75 * river);
          bline = 1.0 - smoothstep(0.15, 1.3, lf.g * uLinesRange / tpp);
        }
        if (uChoroAmt > 0.0) {
          vec4 ch = rhChoro(ids.x) * tw.x + rhChoro(ids.y) * tw.y + rhChoro(ids.z) * tw.z + rhChoro(ids.w) * tw.w;
          float l = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          diffuseColor.rgb = mix(diffuseColor.rgb, ch.rgb / max(ch.a, 1e-3) * (0.55 + 1.6 * l), ch.a * uChoroAmt);
        }
        #if RH_RASTERS > 0
        { vec4 r = rhRaster(tR0, uR0Map, uR0Par, uR0Size, 4.0); diffuseColor.rgb = mix(diffuseColor.rgb, r.rgb, r.a); }
        #endif
        #if RH_RASTERS > 1
        { vec4 r = rhRaster(tR1, uR1Map, uR1Par, uR1Size, 5.0); diffuseColor.rgb = mix(diffuseColor.rgb, r.rgb, r.a); }
        #endif
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.9, 0.82), bline * uBorders * 0.45);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(uWaterShallow, uWaterDeep, deep), rhWater);
        float hov = step(0.5, uHover) * smoothstep(0.5 - hovAA, 0.5 + hovAA, hovS);
        float sel = step(0.5, uSel) * smoothstep(0.5 - selAA, 0.5 + selAA, selS);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.45 + vec3(0.07, 0.05, 0.0), max(hov, sel * 0.7));
        rhDim = step(0.5, uSel) * (1.0 - sel);
        diffuseColor.a = clamp(0.5 - sd / sdAA, 0.0, 1.0);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.14, rhWater);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // normal de la superficie (270 → 90 → 30 m, en escala real); normalMatrix le aplica la exageración vertical
        normal = normalize(normalMatrix * rhNm);
        if (rhWater > 0.0) {
          vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          vec2 q = vXZ * 2.2;
          vec3 rip = vec3(rhNoise(q + uTime * vec2(0.35, 0.1)) - 0.5, 0.0, rhNoise(q * 1.37 - uTime * vec2(0.12, 0.3) + 7.0) - 0.5);
          vec3 wn = normalize(upView + (viewMatrix * vec4(rip * 0.22, 0.0)).xyz);
          normal = normalize(mix(normal, wn, rhWater * 0.9));
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uCityLight * rhGlow * rhGlow * uNight * (1.0 - rhWater);
        float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 4.0);
        totalEmissiveRadiance += uSkyRefl * (0.06 + 0.5 * fres) * rhWater * (1.0 - 0.85 * uNight);`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        // oclusión: apertura del cielo del relieve de 90 m si ya llegó, si no la aproximación de 270 m
        reflectedLight.indirectDiffuse *= rhAOv;
        reflectedLight.directDiffuse *= mix(1.0, rhAOv, 0.35);
        if (uClouds > 0.0) {
          float cl = smoothstep(0.54, 0.82, rhFbm(vXZ / 24.0 + uWind * uTime));
          float cs = 1.0 - 0.45 * cl * uClouds;
          reflectedLight.directDiffuse *= cs; reflectedLight.directSpecular *= cs;
        }
        reflectedLight.directDiffuse *= 1.0 - 0.32 * rhDim;
        reflectedLight.indirectDiffuse *= 1.0 - 0.32 * rhDim;`)
      .replace('#include <premultiplied_alpha_fragment>', `${HAZE}
        #include <premultiplied_alpha_fragment>`);
  };
  return mat;
}

/**
 * Profundidad para la sombra estática: parches de 270 m sin fundido, recortados por el contorno del estado (sin eso, las
 * orillas cuadradas de los parches de fuera proyectarían sombra).
 */
export function createCasterDepthMaterial(hu: HeightUniforms, u: TerrainUniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.customProgramCacheKey = () => 'rh-caster';
  mat.onBeforeCompile = sh => {
    withHeights(sh, hu);
    Object.assign(sh.uniforms, { tMuni: u.tMuni, uGrid: u.uGrid, uGridMax: u.uGridMax });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aPatch; uniform vec2 uGridMax; varying vec2 vWUvS;`)
      .replace('#include <begin_vertex>', `
        vec2 g = aPatch.xy + position.xz * aPatch.z;
        vec2 xz = rhXZ(g);
        vec3 transformed = vec3(xz.x, rhH0(g) * 0.001, xz.y);
        vWUvS = g / uGridMax;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tMuni; uniform vec2 uGrid; varying vec2 vWUvS;`)
      .replace('void main() {', `void main() {
        {
          vec2 tc = vWUvS * uGrid, f = fract(tc);
          ivec2 b = ivec2(floor(tc)), mx = ivec2(uGrid);
          float a = texelFetch(tMuni, clamp(b, ivec2(0), mx), 0).g, c = texelFetch(tMuni, clamp(b + ivec2(1, 0), ivec2(0), mx), 0).g;
          float d = texelFetch(tMuni, clamp(b + ivec2(0, 1), ivec2(0), mx), 0).g, e = texelFetch(tMuni, clamp(b + ivec2(1, 1), ivec2(0), mx), 0).g;
          if (mix(mix(a, c, f.x), mix(d, e, f.x), f.y) > 128.0 / 255.0) discard;
        }`);
  };
  return mat;
}

/** Profundidad de las paredes para la sombra del bloque sobre el suelo: borde superior en el relieve de 270 m. */
export function createWallDepthMaterial(hu: HeightUniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.customProgramCacheKey = () => 'rh-walls-depth';
  mat.onBeforeCompile = sh => {
    withHeights(sh, hu);
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', `
      vec3 transformed = vec3(position.x, position.y > 0.5 ? rhH0(rhGridOf(position.xz)) * 0.001 : ${BASE_KM.toFixed(3)}, position.z);`);
  };
  return mat;
}

/** Paredes del zócalo: corte con estratos, suelo arriba y oscuridad hacia la base. El borde superior sigue al relieve. */
export function createWallMaterial(shared: SharedUniforms, hu: HeightUniforms, defines: Record<string, string>) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.97, metalness: 0, side: THREE.DoubleSide });
  mat.defines = { ...defines };
  const u = {
    ...shared,
    uSoil: { value: new THREE.Color('#3a2b20') },
    uStrata: { value: ['#8f7458', '#6b5646', '#b0a088', '#87553f', '#57483d', '#a3865f'].map(h => new THREE.Color(h)) },
  };
  mat.customProgramCacheKey = () => 'rh-walls';
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    withHeights(sh, hu);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        varying float vY; varying float vTop; varying vec2 vXZ;`)
      .replace('#include <begin_vertex>', `
        float hTop = rhSurface(rhGridOf(position.xz)) * 0.001;
        vec3 transformed = vec3(position.x, position.y > 0.5 ? hTop : ${BASE_KM.toFixed(3)}, position.z);
        vY = transformed.y; vTop = hTop; vXZ = position.xz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uSoil; uniform vec3 uStrata[6];
        ${HAZE_PARS}
        varying float vY; varying float vTop; varying vec2 vXZ;
        ${NOISE}`)
      .replace('#include <color_fragment>', `
        float along = vXZ.x * 0.71 + vXZ.y * 0.43;
        float band = vY * 4.2 + (rhFbm(vec2(along * 0.035, vY * 0.6)) - 0.5) * 2.6 + sin(along * 0.021) * 0.5;
        float id = floor(band), f = fract(band);
        float h = rhHash(vec2(id, 3.7));
        int k = int(floor(h * 5.999));
        vec3 c = uStrata[0];
        for (int j = 1; j < 6; j++) if (j == k) c = uStrata[j];
        c *= 0.86 + 0.14 * rhNoise(vec2(along * 1.4, vY * 30.0));
        c *= 0.8 + 0.2 * smoothstep(0.0, 0.06, f) * smoothstep(1.0, 0.94, f);
        c = mix(uSoil, c, smoothstep(0.015, 0.06, vTop - vY));
        c *= mix(0.22, 1.0, smoothstep(-1.4, 0.9, vY));
        diffuseColor.rgb = c;`)
      .replace('#include <premultiplied_alpha_fragment>', `${HAZE}
        #include <premultiplied_alpha_fragment>`);
  };
  return mat;
}

/** Luces de las localidades de noche: puntos suaves con mezcla aditiva, apoyados en la superficie. */
export function createNightPointsMaterial(shared: SharedUniforms, hu: HeightUniforms, defines: Record<string, string>, pixelRatio: number) {
  return new THREE.ShaderMaterial({
    defines: { ...defines },
    uniforms: { ...hu, uNight: shared.uNight, uScale: { value: pixelRatio }, uColor: { value: new THREE.Color('#ffd08a') } },
    vertexShader: /* glsl */ `
      ${HEIGHT_GLSL}
      attribute float aSize; uniform float uScale; varying float vA;
      void main() {
        vec3 p = vec3(position.x, rhSurface(rhGridOf(position.xz)) * 0.001 + 0.004, position.z);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uScale * clamp(2.2 / -mv.z, 0.6, 3.0);
        vA = aSize;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight; uniform vec3 uColor; varying float vA;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d) * 4.0;
        float a = exp(-r2 * 5.0) + 0.6 * exp(-r2 * 40.0);
        gl_FragColor = vec4(uColor * a * uNight, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
