import * as THREE from 'three';

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

export function makeTerrainUniforms(
  shared: SharedUniforms, water: THREE.Texture, muni: THREE.Texture, choro: THREE.Texture, bounds: THREE.Vector4,
) {
  const mi = muni.image as { width: number; height: number };
  return {
    ...shared,
    tMuni: { value: muni },
    uGrid: { value: new THREE.Vector2(mi.width - 1, mi.height - 1) },
    /** mapa base: 0 = color por altitud (vértices), 1 = textura tBase (uso de suelo, satélite…) */
    tBase: { value: blankTexture() as THREE.Texture },
    uBaseTex: { value: 0 },
    /** capa de análisis alineada a la rejilla (RGBA, alfa = cobertura) */
    tOverlay: { value: blankTexture([0, 0, 0, 0]) as THREE.Texture },
    uOverlay: { value: 0 },
    uOverlaySize: { value: new THREE.Vector2(1, 1) },
    uHover: { value: 0 },
    uSel: { value: 0 },
    uContours: { value: 0 },
    uBorders: { value: 1 },
    uWater: { value: 1 },
    uChoroAmt: { value: 0 },
    tWater: { value: water },
    uTexSize: { value: (water.image as { width: number }).width },
    tChoro: { value: choro },
    uBounds: { value: bounds },
    uWaterShallow: { value: new THREE.Color('#3b7f8c') },
    uWaterDeep: { value: new THREE.Color('#1b4a63') },
    uSkyRefl: { value: new THREE.Color('#9fc3dc') },
    uCityLight: { value: new THREE.Color('#ffb35c').multiplyScalar(2.6) },
  };
}
export type TerrainUniforms = ReturnType<typeof makeTerrainUniforms>;

export function createTerrainMaterial(u: TerrainUniforms) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0 });
  mat.customProgramCacheKey = () => 'rh-terrain';
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aAlt; attribute float aGlow;
        uniform vec4 uBounds;
        varying vec3 vTint; varying float vAO; varying float vGlow;
        varying vec2 vWUv; varying float vElevKm; varying vec2 vXZ;
        vec3 rhToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTint = rhToLinear(aAlt.rgb);
        vAO = aAlt.a; vGlow = aGlow; vElevKm = position.y; vXZ = position.xz;
        vWUv = vec2((position.x - uBounds.x) / uBounds.z, (position.z - uBounds.y) / uBounds.w);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uHover; uniform float uSel; uniform float uContours; uniform float uBorders; uniform float uWater;
        uniform float uClouds; uniform float uNight; uniform float uTime; uniform float uChoroAmt; uniform float uTexSize; uniform vec2 uWind;
        uniform sampler2D tWater; uniform sampler2D tChoro; uniform sampler2D tMuni; uniform vec2 uGrid;
        uniform sampler2D tBase; uniform float uBaseTex; uniform sampler2D tOverlay; uniform float uOverlay; uniform vec2 uOverlaySize;
        uniform vec3 uWaterShallow; uniform vec3 uWaterDeep; uniform vec3 uSkyRefl; uniform vec3 uCityLight;
        ${HAZE_PARS}
        varying vec3 vTint; varying float vAO; varying float vGlow;
        varying vec2 vWUv; varying float vElevKm; varying vec2 vXZ;
        float rhWater; float rhDim;
        ${NOISE}
        float rhMuni(ivec2 p) { return floor(texelFetch(tMuni, clamp(p, ivec2(0), ivec2(uGrid)), 0).r * 255.0 + 0.5); }
        vec4 rhChoro(float m) { vec4 c = texture2D(tChoro, vec2((m + 0.5) / 256.0, 0.5)); return vec4(c.rgb * c.a, c.a); }
        // borde suave: fracción bilineal de las 4 celdas vecinas que pertenecen al municipio m
        float rhShare(float m, vec4 ids, vec4 w) { return dot(vec4(equal(ids, vec4(m))), w); }
        float rhEdge(float s) { float aa = max(fwidth(s), 1e-3) * 0.75; return smoothstep(0.5 - aa, 0.5 + aa, s); }
        float contourLine(float h, float interval, float width) {
          float f = h / interval;
          float d = abs(fract(f - 0.5) - 0.5) / max(fwidth(f), 1e-4);
          return 1.0 - clamp(d / width, 0.0, 1.0);
        }`)
      .replace('#include <color_fragment>', `
        diffuseColor.rgb = uBaseTex > 0.0 ? mix(vTint, texture2D(tBase, vWUv).rgb, uBaseTex) : vTint;
        float hm = vElevKm * 1000.0;
        vec4 wt = texture2D(tWater, vWUv);
        rhWater = smoothstep(0.15, 0.75, wt.r) * uWater;
        float deep = smoothstep(0.55, 1.0, textureLod(tWater, vWUv, 4.0).r);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55, contourLine(hm, 100.0, 1.0) * 0.55 * uContours);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.035, 0.03), contourLine(hm, 500.0, 1.4) * 0.8 * uContours);
        vec2 tc = vWUv * uGrid, tf = fract(tc);
        ivec2 tb = ivec2(floor(tc));
        vec4 ids = vec4(rhMuni(tb), rhMuni(tb + ivec2(1, 0)), rhMuni(tb + ivec2(0, 1)), rhMuni(tb + ivec2(1, 1)));
        vec4 tw = vec4((1.0 - tf.x) * (1.0 - tf.y), tf.x * (1.0 - tf.y), (1.0 - tf.x) * tf.y, tf.x * tf.y);
        if (uChoroAmt > 0.0) {
          vec4 ch = rhChoro(ids.x) * tw.x + rhChoro(ids.y) * tw.y + rhChoro(ids.z) * tw.z + rhChoro(ids.w) * tw.w;
          float l = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          diffuseColor.rgb = mix(diffuseColor.rgb, ch.rgb / max(ch.a, 1e-3) * (0.55 + 1.6 * l), ch.a * uChoroAmt);
        }
        if (uOverlay > 0.0) {
          // texeles centrados en las celdas de la rejilla, sin importar el tamaño de la capa
          vec4 ov = texture2D(tOverlay, (vWUv * (uOverlaySize - 1.0) + 0.5) / uOverlaySize);
          diffuseColor.rgb = mix(diffuseColor.rgb, ov.rgb, ov.a * uOverlay);
        }
        // las líneas finas se diluyen al alejarse (mipmaps): se refuerzan según los texeles que caben en un píxel
        float tpp = max(fwidth(vWUv.x), fwidth(vWUv.y)) * uTexSize;
        float bline = clamp(wt.g * max(1.0, tpp * 0.45), 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.9, 0.82), bline * uBorders * 0.45);
        diffuseColor.rgb = mix(diffuseColor.rgb, mix(uWaterShallow, uWaterDeep, deep), rhWater);
        float hov = step(0.5, uHover) * rhEdge(rhShare(uHover, ids, tw));
        float sel = step(0.5, uSel) * rhEdge(rhShare(uSel, ids, tw));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.45 + vec3(0.07, 0.05, 0.0), max(hov, sel * 0.7));
        rhDim = step(0.5, uSel) * (1.0 - sel);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.14, rhWater);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (rhWater > 0.0) {
          vec3 upView = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          vec2 q = vXZ * 2.2;
          vec3 rip = vec3(rhNoise(q + uTime * vec2(0.35, 0.1)) - 0.5, 0.0, rhNoise(q * 1.37 - uTime * vec2(0.12, 0.3) + 7.0) - 0.5);
          vec3 wn = normalize(upView + (viewMatrix * vec4(rip * 0.22, 0.0)).xyz);
          normal = normalize(mix(normal, wn, rhWater * 0.9));
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += uCityLight * vGlow * vGlow * uNight * (1.0 - rhWater);
        float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 4.0);
        totalEmissiveRadiance += uSkyRefl * (0.06 + 0.5 * fres) * rhWater * (1.0 - 0.85 * uNight);`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= vAO;
        reflectedLight.directDiffuse *= mix(1.0, vAO, 0.35);
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

/** Paredes del zócalo: corte con estratos, suelo arriba y oscuridad hacia la base. */
export function createWallMaterial(shared: SharedUniforms) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.97, metalness: 0, side: THREE.DoubleSide });
  const u = {
    ...shared,
    uSoil: { value: new THREE.Color('#3a2b20') },
    uStrata: { value: ['#8f7458', '#6b5646', '#b0a088', '#87553f', '#57483d', '#a3865f'].map(h => new THREE.Color(h)) },
  };
  mat.customProgramCacheKey = () => 'rh-walls';
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aTop; varying float vY; varying float vTop; varying vec2 vXZ;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vY = position.y; vTop = aTop; vXZ = position.xz;`);
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

/** Luces de las localidades de noche: puntos suaves con mezcla aditiva. */
export function createNightPointsMaterial(shared: SharedUniforms, pixelRatio: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uNight: shared.uNight, uScale: { value: pixelRatio }, uColor: { value: new THREE.Color('#ffd08a') } },
    vertexShader: /* glsl */ `
      attribute float aSize; uniform float uScale; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
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
        gl_FragColor = vec4(uColor * a * uNight * 1.4, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
