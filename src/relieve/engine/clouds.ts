import * as THREE from 'three';
import { CLOUD_DEFAULTS, buildWeather, skyFor, windVector, withAmount, type CloudSettings, type SkyParams, type WeatherGrid } from '../shared/clouds';
import type { CloudWeatherRequest, CloudWeatherResult } from '../worker/clouds.worker';
import type { HeightUniforms } from './heights';

/**
 * Nubes volumétricas. Viven en el espacio de la escena en km (x, z del modelo; y = altura exagerada), así que se apoyan
 * en el relieve con cualquier exageración y conservan su forma (los espesores no se exageran).
 *
 *   1. Ruido (una vez, en la GPU): 64³ de Perlin-Worley y Worley para la forma, y 256² para el tiempo (variación
 *      regional, celdas de tormenta) que el viento arrastra.
 *   2. Clima (CPU, rejilla de ≈ 1 km): estado, humedad por la lluvia media anual de INEGI, relieve suavizado (base de
 *      los cúmulos) y fondo de los valles (niebla).
 *   3. Sombra: por cada punto de un plano de referencia, transmitancia a lo largo de la recta hacia el Sol; el relieve
 *      la consulta según su altura (sombras desplazadas como las del Sol).
 *   4. Volumen a media resolución (ray marching con saltos por capas): color premultiplicado y profundidad del frente.
 *   5. Composición en la pasada principal con gl_FragDepth: el relieve que está delante tapa a la nube a resolución
 *      completa; el que está dentro de la capa (picos, niebla) lo detiene el propio recorrido.
 */

const UNIT = 0.01;            // unidades de escena por km (como en Engine)
const NOISE = 64;             // texeles por lado del ruido 3D
const WN = 256;               // ruido del tiempo
const NOISE_KM = 18;          // periodo del ruido 3D: celdas de ≈ 4.5 km
const WEATHER_KM = 300;       // periodo del ruido del tiempo: variación de ~75 km, celdas de tormenta cada ~50 km
const DRIFT_KMS = 1.2;        // km por segundo en el lapso de tiempo (≈ 3 min por segundo con viento de 25 km/h)
const EVOLVE_KMS = 0.22;      // cambio de forma (km del ruido por segundo)
const DENSITY = 7;            // extinción por km con densidad 1

const FULLSCREEN = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** Ruido periódico (se repite en el lado de la textura): gradiente, Worley y sus sumas. */
const NOISE_GEN = /* glsl */ `
precision highp float;
uniform float uZ; uniform float uMode; uniform vec2 uRes;
layout(location = 0) out highp vec4 oColor;
vec3 h33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float gnoise(vec3 p, vec3 per) {
  vec3 i = floor(p), f = fract(p), u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float v[8];
  for (int k = 0; k < 8; k++) {
    vec3 o = vec3(float(k & 1), float((k >> 1) & 1), float(k >> 2));
    vec3 g = normalize(h33(mod(i + o, per)) * 2.0 - 1.0 + 1e-4);
    v[k] = dot(g, f - o);
  }
  return mix(mix(mix(v[0], v[1], u.x), mix(v[2], v[3], u.x), u.y), mix(mix(v[4], v[5], u.x), mix(v[6], v[7], u.x), u.y), u.z);
}
// distancia al punto más cercano (0 en el punto) y un número al azar de su celda
float worley(vec3 p, vec3 per, out float id) {
  vec3 i = floor(p), f = fract(p);
  float d = 9.0; id = 0.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(float(x), float(y), float(z)), h = h33(mod(i + o, per)), r = o + h - f;
    float dd = dot(r, r);
    if (dd < d) { d = dd; id = fract(h.x * 13.17 + h.y * 7.31 + h.z * 3.77); }
  }
  return sqrt(d);
}
float pfbm(vec3 p, float F, int oct) {
  float s = 0.0, a = 1.0, n = 0.0;
  for (int k = 0; k < 5; k++) {
    if (k >= oct) break;
    s += a * gnoise(p * F, vec3(F)); n += a; F *= 2.0; a *= 0.5;
  }
  return clamp(s / n * 1.5 + 0.5, 0.0, 1.0);
}
float w1(vec3 p, float F) { float id; return clamp(1.0 - worley(p * F, vec3(F), id), 0.0, 1.0); }
// celdas en el plano (tormentas): 1 en el centro de cada una
float worley2(vec2 p, vec2 per, out float id) {
  vec2 i = floor(p), f = fract(p);
  float d = 9.0; id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec3 h = h33(vec3(mod(i + o, per), 7.0));
    vec2 r = o + h.xy - f;
    float dd = dot(r, r);
    if (dd < d) { d = dd; id = h.z; }
  }
  return sqrt(d);
}
void main() {
  vec3 p = vec3(gl_FragCoord.xy / uRes, uZ);
  if (uMode < 0.5) {
    float a = w1(p, 4.0), b = w1(p, 8.0), c = w1(p, 16.0), wf = a * 0.625 + b * 0.25 + c * 0.125;
    float pw = clamp((pfbm(p, 4.0, 4) - (wf - 1.0)) / (2.0 - wf), 0.0, 1.0);
    oColor = vec4(pw, a, b, c);
  } else {
    float id;
    float cell = clamp(1.0 - worley2(p.xy * 6.0, vec2(6.0), id), 0.0, 1.0);
    oColor = vec4(pfbm(vec3(p.xy, 0.25), 4.0, 5), cell, id, pfbm(vec3(p.xy + 0.37, 0.75), 16.0, 3));
  }
}`;

/** Lo que comparten el volumen y la sombra: clima, tiempo y densidad de las dos capas. */
const COMMON = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform highp sampler3D tNoise;
uniform sampler2D tWNoise;
uniform sampler2D tWeather;
uniform vec4 uGridMap;
uniform vec4 uWMap;
uniform float uEx;
uniform vec4 uC0;
uniform vec4 uC1;
uniform vec4 uC2;
uniform vec3 uDrift;
#define uCover uC0.x
#define uBase uC0.y
#define uThick uC0.z
#define uStratus uC0.w
#define uStorm uC1.x
#define uStormTop uC1.y
#define uFog uC1.z
#define uFogTop uC1.w
#define uFogValley uC2.x
#define uFade uC2.y
#define uNoiseKm uC2.z
#define uWeatherKm uC2.w
float cRemap(float v, float a, float b) { return clamp((v - a) / max(b - a, 1e-4), 0.0, 1.0); }
// lo que solo depende de (x, z)
struct Column { float mask; float hum; float baseV; float topV; float cov; float tower; float anvil; float rain; float fogTopV; float fogAmt; };
Column cColumn(vec2 xz) {
  Column c;
  vec2 g = (xz - uGridMap.xy) / uGridMap.zw;
  // clima: r estado, g humedad, b relieve suavizado, a fondo de los valles (km / 3.5)
  vec4 wx = texture(tWeather, (g / uWMap.x + uWMap.y + 0.5) / uWMap.zw);
  c.mask = smoothstep(0.15, 0.75, wx.r);
  c.hum = wx.g;
  c.baseV = (wx.b * 3.5 + uBase) * uEx;
  // tiempo: r variación regional, g celdas de tormenta (1 en el centro), b azar de la celda, a racimos de ~20 km
  vec2 wuv = (xz - uDrift.xy) / uWeatherKm;
  vec4 wn = texture(tWNoise, wuv);
  float v = (wn.r - 0.5) * 0.7 + (wn.a - 0.5) * 0.55;
  // los cúmulos dependen mucho de la humedad; una capa de estratos cubre casi parejo
  float wet = mix(mix(0.35, 1.0, c.hum), mix(0.78, 1.05, c.hum), uStratus);
  c.cov = clamp(uCover * wet + v * mix(0.45, 0.2, uStratus), 0.0, 1.0) * c.mask;
  c.tower = 0.0; c.anvil = 0.0; c.rain = 0.0;
  if (uStorm > 0.0) {
    // celdas activas al azar, más donde es húmedo; aparecen y se apagan poco a poco
    float id = texelFetch(tWNoise, ivec2(fract(wuv) * ${WN}.0) & ${WN - 1}, 0).b;
    float on = clamp((uStorm * mix(0.45, 1.5, c.hum) - id) / 0.08 + 0.5, 0.0, 1.0) * smoothstep(0.55, 0.9, wx.r);
    c.tower = on * smoothstep(0.8, 0.94, wn.g);
    c.anvil = on * smoothstep(0.58, 0.86, wn.g);
    c.rain = on * smoothstep(0.86, 0.97, wn.g);
  }
  c.topV = c.baseV + (c.tower + c.anvil > 0.0 ? uStormTop : uThick);
  // niebla: mar de nubes con cima a altura fija donde es húmedo; en los valles hondos (más bajos que la región), una capa
  // sobre el fondo. Baja hasta el fondo del valle en el borde del estado: no queda una losa flotando sobre el vacío
  float edge = smoothstep(0.5, 0.85, wx.r), floorKm = wx.a * 3.5, valley = smoothstep(0.04, 0.22, (wx.b - wx.a) * 3.5);
  c.fogTopV = mix(floorKm, max(floorKm + uFogValley * valley, uFogTop * smoothstep(0.3, 0.75, c.hum)), edge) * uEx;
  c.fogAmt = uFog * edge;
  return c;
}
// cúmulos, estratos y tormentas; hf = altura relativa en la nube (0 base, 1 cima)
float cDensC(vec3 p, Column c, bool detail, out float hf) {
  float y = p.y - c.baseV, h = y / uThick, hs = y / uStormTop;
  // los cúmulos se angostan hacia la cima; los estratos son una capa
  float pc = smoothstep(0.0, 0.07, h) * (1.0 - smoothstep(mix(0.25, 0.7, uStratus), 1.0, h));
  // tormenta: torre que se angosta y asoma sobre el yunque, ancho y delgado
  float tw = c.tower * smoothstep(0.0, 0.03, hs) * (1.0 - smoothstep(0.8, 1.0, hs));
  float st = max(tw, c.anvil * smoothstep(0.74, 0.82, hs) * (1.0 - smoothstep(0.86, 0.92, hs)));
  float cu = c.cov * pc, cov = max(cu, st);
  hf = clamp(st > cu ? hs : h, 0.0, 1.0);
  if (cov < 0.01) return 0.0;
  vec3 q = vec3(p.x - uDrift.x, p.y + uDrift.z, p.z - uDrift.y) / uNoiseKm;
  vec4 n = texture(tNoise, q);
  float shape = cRemap(n.r, n.g * 0.625 + n.b * 0.25 + n.a * 0.125 - 1.0, 1.0);
  // los estratocúmulos forman celdas (Worley) con bordes marcados
  shape = mix(shape, shape * 0.45 + n.g * 0.55, uStratus);
  // borde definido: la densidad sube en una franja angosta del ruido (cúmulos de algodón, no manchas difusas)
  float d = cRemap(shape, 1.0 - cov, 1.0 - cov + mix(min(cov, 0.24), 0.2, uStratus));
  if (detail && d > 0.0) {
    vec4 m = texture(tNoise, q * 5.3 + vec3(0.31, 0.0, 0.57));
    float e = m.g * 0.625 + m.b * 0.25 + m.a * 0.125;
    // abajo y en los bordes, bordes redondos; arriba, deshilachados
    e = mix(e, 1.0 - e, clamp(hf * 2.0 - 0.6, 0.0, 1.0));
    d = cRemap(d, e * 0.34, 1.0);
  }
  // los estratos, más delgados: dejan ver algo del relieve
  return d * mix(1.0, 0.55, uStratus);
}
// cortina de lluvia bajo las torres: tenue y en franjas verticales
float cDensR(vec3 p, Column c) {
  if (c.rain <= 0.0 || p.y > c.baseV) return 0.0;
  float n = texture(tNoise, vec3((p.x - uDrift.x) * 3.0, p.y * 0.12, (p.z - uDrift.y) * 3.0) / uNoiseKm).g;
  return c.rain * 0.16 * (0.55 + 0.45 * n);
}
// niebla: densa y con la cima ondulada (± 60 m)
float cDensF(vec3 p, Column c, out float hf) {
  float depth = c.fogTopV - p.y;
  hf = 1.0;
  if (depth < -0.12 * uEx || c.fogAmt <= 0.0) return 0.0;
  float n = texture(tNoise, vec3(p.x - uDrift.x * 0.4, p.y * 1.6, p.z - uDrift.y * 0.4) / (uNoiseKm * 0.7)).r;
  hf = clamp(1.0 - depth / (0.5 * uEx), 0.0, 1.0);
  return c.fogAmt * smoothstep(0.0, 1.0, depth / (0.07 * uEx) + (n - 0.5) * 2.2) * (0.6 + 0.4 * n);
}`;

const VOLUME = /* glsl */ `${COMMON}
uniform highp sampler2D tH0;
uniform sampler2D tFields;
uniform vec2 uGridMax;
uniform mat4 uInvVP;
uniform vec3 uCam; uniform vec3 uTarget; uniform vec3 uFwd;
uniform vec2 uSize;
uniform vec4 uBox;
uniform vec3 uY;
uniform float uSlope;
uniform vec3 uLightDir; uniform vec3 uLightColor; uniform vec3 uAmbTop; uniform vec3 uAmbBottom; uniform vec3 uGlow;
uniform float uDensity;
uniform vec2 uHole;
// desvanecimiento de las nubes bajo la cámara (km): de nada en x a completo en y
uniform vec2 uNear;
uniform float uQuality;
// relámpago: posición (km) e intensidad
uniform vec4 uFlash;
layout(location = 0) out highp vec4 oColor;
layout(location = 1) out highp vec4 oDepth;
float cTerrainV(vec2 xz) {
  vec2 g = clamp((xz - uGridMap.xy) / uGridMap.zw, vec2(0.0), uGridMax - 0.001);
  ivec2 b = ivec2(g); vec2 f = g - vec2(b);
  float a = texelFetch(tH0, b, 0).r, c = texelFetch(tH0, b + ivec2(1, 0), 0).r;
  float d = texelFetch(tH0, b + ivec2(0, 1), 0).r, e = texelFetch(tH0, b + ivec2(1, 1), 0).r;
  return mix(mix(a, c, f.x), mix(d, e, f.x), f.y) * 0.001 * uEx;
}
// Henyey-Greenstein, normalizada para que la isótropa valga 1
float cHG(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5); }
void main() {
  oColor = vec4(0.0); oDepth = vec4(0.0);
  vec2 ndc = gl_FragCoord.xy / uSize * 2.0 - 1.0;
  vec4 wp = uInvVP * vec4(ndc, 1.0, 1.0);
  vec3 dir = normalize(wp.xyz / wp.w * ${(1 / UNIT).toFixed(1)} - uCam);
  // caja de las nubes
  vec3 inv = 1.0 / (dir + vec3(equal(dir, vec3(0.0))) * 1e-6);
  vec3 b0 = (vec3(uBox.x, uY.x, uBox.y) - uCam) * inv, b1 = (vec3(uBox.z, uY.y, uBox.w) - uCam) * inv;
  vec3 lo = min(b0, b1), hi = max(b0, b1);
  float t = max(max(lo.x, lo.y), max(lo.z, 0.0)), tEnd = min(min(hi.x, hi.y), hi.z);
  if (t >= tEnd) return;
  float phase = mix(cHG(dot(dir, uLightDir), 0.55), cHG(dot(dir, uLightDir), -0.2), 0.3);
  float pathF = 0.45 * uEx / max(abs(dir.y), 0.1);
  float slopeK = abs(dir.y) + uSlope * length(dir.xz) + 1e-3;
  vec3 ax = uTarget - uCam; float axL = length(ax); ax /= max(axL, 1e-4);
  // inicio desplazado al azar (sin bandas)
  float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  t += jit * min(0.1 + t * 0.0025, 1.0);
  float T = 1.0, tFront = -1.0;
  vec3 col = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    if (t > tEnd || T < 0.04) break;
    vec3 p = uCam + dir * t;
    float far = 0.1 + t * 0.0025;
    Column c = cColumn(p.xz);
    if (c.mask <= 0.0) { t += max(far * 3.0, 1.0); continue; }
    float gC = c.cov + c.tower + c.anvil > 0.0 ? (p.y < c.baseV ? c.baseV - p.y : max(0.0, p.y - c.topV)) : 1e5;
    float gR = c.rain > 0.02 ? max(0.0, p.y - c.baseV) : 1e5;
    float gF = c.fogAmt > 0.0 ? max(0.0, p.y - c.fogTopV - 0.12 * uEx) : 1e5;
    float gap = min(gC, min(gF, gR));
    if (gap > 0.0) {
      // ninguna capa a esta altura: salta lo que seguro no alcanza
      t += gap > 9e4 ? max(far * 3.0, 1.0) : max(gap / slopeK, far * 0.5) + jit * far;
      continue;
    }
    // en la niebla y la lluvia, el suelo detiene el rayo (los picos que entran en los cúmulos los tapa la prueba de profundidad)
    if ((gF <= 0.0 || gR <= 0.0) && p.y < uY.z && p.y < cTerrainV(p.xz)) break;
    float hC = 0.0, hF = 0.0;
    float dC = gC <= 0.0 ? cDensC(p, c, T > 0.3, hC) : 0.0;
    float dF = gF <= 0.0 ? cDensF(p, c, hF) : 0.0;
    float dR = gR <= 0.0 ? cDensR(p, c) : 0.0;
    // junto a la cámara se desvanecen; al acercarse se abre un claro alrededor del punto que se mira
    // (solo las que quedan por debajo de la cámara: las de arriba no tapan el suelo y se ven como bases de nube)
    float keep = smoothstep(0.3, 1.5, t) * (p.y < uCam.y ? smoothstep(uNear.x, uNear.y, t) : 1.0) * uFade;
    if (uHole.x > 0.0) {
      float u = dot(p - uCam, ax);
      if (u > 0.0 && u < axL * 1.02) {
        float r = u * uHole.y;
        keep *= mix(1.0, smoothstep(r * 0.5, r * 1.15, length(p - uCam - ax * u)), uHole.x);
      }
    }
    float sigma = (dC + dF + dR) * keep * uDensity;
    // dentro de la nube, pasos finos; en el aire entre nubes, más largos (sin saltarse un yunque delgado)
    float pathC = (c.topV - c.baseV) / max(abs(dir.y), 0.12);
    float dt = gC <= 0.0 ? min(min(far, pathC / 8.0), c.tower + c.anvil > 0.0 ? 0.6 : 2.0) : gF <= 0.0 ? min(far, pathF / 6.0) : far * 1.5;
    dt = clamp((sigma > 0.003 ? dt * 0.6 : dt * 1.25) * mix(1.3, 1.0, uQuality), 0.03, 2.0);
    // los rayos casi horizontales recorren mucha capa: pasos más largos para no quedarse a medias (vetas)
    dt = max(dt, (tEnd - t) / float(STEPS - i) * 0.6);
    if (sigma > 0.003) {
      float hm = dC >= dF ? hC : dF > dR ? hF : 0.0;
      // luz hacia el Sol (o la Luna): la nube se sombrea a sí misma
      float tau = 0.0, ls = 0.16 * max(1.0, (c.topV - c.baseV) / 2.5), h1, h2;
      vec3 lp = p;
      // lo que queda detrás de mucha nube se ilumina con menos muestras
      int nl = T > 0.4 ? (uQuality > 0.5 ? LSTEPS : LSTEPS - 1) : 2;
      for (int k = 0; k < LSTEPS; k++) {
        if (k >= nl) break;
        lp += uLightDir * ls;
        // la niebla deja pasar más luz que su densidad aparente (se ve iluminada por encima)
        tau += (cDensC(lp, c, false, h1) + (c.fogAmt > 0.0 ? 0.5 * cDensF(lp, c, h2) : 0.0)) * ls;
        ls *= 2.0;
      }
      tau *= uDensity * uFade * 1.4;
      // varias dispersiones: la luz también llega, más tenue, a las partes en sombra
      float beer = exp(-tau) + 0.22 * exp(-tau * 0.25);
      float powder = 1.0 - exp(-sigma * 0.5);
      vec3 S = uLightColor * phase * beer * mix(0.55, 1.0, powder) + mix(uAmbBottom, uAmbTop, sqrt(hm));
      if (uGlow.r > 0.0) {
        // de noche, las ciudades iluminan la base de las nubes
        vec2 g = (p.xz - uGridMap.xy) / uGridMap.zw;
        float gl = textureLod(tFields, (g + 0.5) / (uGridMax + 1.0), 3.5).g;
        S += uGlow * gl * gl * 3.0 * (1.0 - hm) * (1.0 - hm);
      }
      if (uFlash.w > 0.0) {
        // un relámpago ilumina la torre por dentro
        vec3 fd = p - uFlash.xyz;
        S += vec3(0.78, 0.84, 1.0) * uFlash.w * 1.8 * exp(-dot(fd, fd) / 36.0);
      }
      float Ts = exp(-sigma * dt);
      col += T * S * (1.0 - Ts);
      T *= Ts;
      if (tFront < 0.0 && T < 0.985) tFront = t;
    }
    t += dt;
  }
  float a = 1.0 - T;
  if (a < 0.004 || tFront < 0.0) return;
  float z = tFront * dot(dir, uFwd);
  #ifdef CLOUD_LDR
  oColor = vec4(sqrt(col / 4.0), a);
  float zn = clamp(z / 2000.0, 0.0, 1.0) * 65535.0;
  oDepth = vec4(floor(zn / 256.0) / 255.0, mod(floor(zn), 256.0) / 255.0, 1.0, 1.0);
  #else
  oColor = vec4(col, a);
  oDepth = vec4(z, 1.0, 0.0, 1.0);
  #endif
}`;

const SHADOW = /* glsl */ `${COMMON}
uniform vec4 uSM;
uniform float uSMSize;
uniform vec3 uLightDir;
uniform float uYRef;
uniform float uDensity;
layout(location = 0) out highp vec4 oColor;
void main() {
  vec2 q = uSM.xy + gl_FragCoord.xy / uSMSize * uSM.zw, k = uLightDir.xz / uLightDir.y;
  // columna donde la recta hacia el Sol cruza la capa (dos iteraciones de punto fijo)
  Column c = cColumn(q);
  c = cColumn(q + k * (0.5 * (c.baseV + c.topV) - uYRef));
  c = cColumn(q + k * (0.5 * (c.baseV + c.topV) - uYRef));
  float s0 = (c.baseV - uYRef) / uLightDir.y, ds = (c.topV - c.baseV) / uLightDir.y / 16.0, tau = 0.0, hf;
  for (int i = 0; i < 16; i++) {
    vec3 p = vec3(q.x, uYRef, q.y) + uLightDir * (s0 + (float(i) + 0.5) * ds);
    tau += cDensC(p, cColumn(p.xz), false, hf);
  }
  // la luz que se dispersa dentro de la nube aclara un poco la sombra
  float T = exp(-tau * ds * uDensity * 0.6 * uFade);
  oColor = vec4(T, T, T, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tCloud; uniform sampler2D tCloudD; uniform vec2 uScreen; uniform vec2 uProjZ;
// texeles en uso (al moverse se calcula una parte de la textura) y tamaño de la textura
uniform vec2 uCloudSize; uniform vec2 uCloudTex;
uniform vec3 uHazeColor; uniform float uHazeAmt; uniform float uHazeRef;
void main() {
  vec2 tp = gl_FragCoord.xy / uScreen * uCloudSize, uv = tp / uCloudTex, o = 0.5 / uCloudTex;
  vec2 lo = o, hi = (uCloudSize - 0.5) / uCloudTex;
  // carpa de 3 × 3 texeles (cuatro lecturas bilineales): suaviza el grano del recorrido a media resolución
  vec4 c = 0.25 * (texture2D(tCloud, clamp(uv - o, lo, hi)) + texture2D(tCloud, clamp(uv + o, lo, hi))
    + texture2D(tCloud, clamp(uv + vec2(o.x, -o.y), lo, hi)) + texture2D(tCloud, clamp(uv + vec2(-o.x, o.y), lo, hi)));
  #ifdef CLOUD_LDR
  c.rgb = c.rgb * c.rgb * 4.0;
  #endif
  if (c.a < 0.004) discard;
  // profundidad: la más cercana de los cuatro texeles vecinos con nube
  ivec2 b = ivec2(floor(tp - 0.5)), mx = ivec2(uCloudSize) - 1;
  float z = 1e9;
  for (int k = 0; k < 4; k++) {
    vec4 d = texelFetch(tCloudD, clamp(b + ivec2(k & 1, k >> 1), ivec2(0), mx), 0);
    #ifdef CLOUD_LDR
    if (d.b > 0.5) z = min(z, (d.r * 255.0 * 256.0 + d.g * 255.0) / 65535.0 * 2000.0);
    #else
    if (d.g > 0.5) z = min(z, d.r);
    #endif
  }
  if (z > 1e8) discard;
  // el relieve que está delante tapa a la nube (prueba de profundidad a resolución completa)
  float zv = -z * ${UNIT};
  gl_FragDepth = clamp((uProjZ.x * zv + uProjZ.y) / -zv * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(c.rgb / c.a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uHazeColor, smoothstep(0.9, 3.4, z * ${UNIT} / max(uHazeRef, 1e-4)) * uHazeAmt);
  gl_FragColor = vec4(gl_FragColor.rgb * c.a, c.a);
}`;

/** Relieve y rejilla para el clima de las nubes. */
export interface CloudTerrain {
  elev: Float32Array;
  muni: Uint8Array;
  W: number;
  H: number;
  /** km por celda (promedio de x y z) */
  cellKm: number;
  /** caja del rectángulo del mapa (km) */
  xMin: number; xMax: number; zMin: number; zMax: number;
  /** punto más alto (m) */
  maxElev: number;
}

/** Uniformes del relieve para la sombra de las nubes (materials.ts). */
export interface CloudShadowUniforms {
  tCloudSh: { value: THREE.Texture };
  /** (k·yRef − origen del mapa) en km y k·exageración / 1000 por metro de altura, con k = luz.xz / luz.y */
  uCloudSh0: { value: THREE.Vector4 };
  /** 1 / tamaño del mapa (km), fuerza de la sombra y atenuación de la luz del cielo */
  uCloudSh1: { value: THREE.Vector4 };
}

export interface CloudLight {
  /** hacia la luz principal (Sol o Luna), en la escena */
  dir: THREE.Vector3;
  /** radiancia de una superficie blanca de frente a la luz (lineal) */
  color: THREE.Color;
  ambTop: THREE.Color;
  ambBottom: THREE.Color;
  /** luz de las ciudades (de noche) */
  glow: THREE.Color;
  /** fuerza de la sombra sobre el relieve (0 de noche) */
  shadow: number;
  /** 0 de día, 1 de noche (los relámpagos se notan más) */
  night: number;
}

const tri = () => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  return g;
};

export class Clouds {
  /** se agrega a la escena: dibuja las nubes sobre el relieve */
  readonly composite: THREE.Mesh;
  settings: CloudSettings = { ...CLOUD_DEFAULTS };
  /** qué hace el cielo ahora (para la interfaz) */
  description = '';

  private hour = 12;
  private params: SkyParams;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera();
  private quad: THREE.Mesh;
  private noise3: THREE.WebGL3DRenderTarget;
  private wnoise: THREE.WebGLRenderTarget;
  private shadowRT: THREE.WebGLRenderTarget;
  private rt: THREE.WebGLRenderTarget;
  private genMat: THREE.ShaderMaterial;
  private volMat: THREE.ShaderMaterial;
  private shMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private weather: THREE.DataTexture;
  private grid: WeatherGrid | null = null;
  private terrain: CloudTerrain | null = null;
  private generated = false;
  /** capas del ruido 3D ya generadas */
  private layers = 0;
  private compiled = false;
  private worker: Worker | null = null;
  private disposed = false;
  private on = true;
  private suppressed = false;
  /** aparición (0–1) */
  private fade = 0;
  private drift = new THREE.Vector3();
  private shadowDirty = true;
  private lightDir = new THREE.Vector3(0, 1, 0);
  private shadowStrength = 0;
  private ex = 1;
  private size = new THREE.Vector2(1, 1);
  private tmp = new THREE.Matrix4();
  private shadowPx: number;
  private lastFast = false;
  private night = 0;
  /** centros de las celdas de tormenta en el ruido del tiempo (uv) y su número al azar */
  private cells: { u: number; v: number; id: number }[] = [];
  private flashT = 10;
  private flashNext = 1;
  private flashOn = false;
  private gridMap: THREE.Vector4;

  /**
   * sh = uniformes del relieve para la sombra de las nubes; fields = campos de 270 m (brillo nocturno); haze = bruma
   * compartida con el relieve.
   */
  constructor(
    private renderer: THREE.WebGLRenderer, hu: HeightUniforms, private sh: CloudShadowUniforms, fields: { value: THREE.Texture },
    haze: Record<'uHazeColor' | 'uHazeAmt' | 'uHazeRef', THREE.IUniform>, private small: boolean,
  ) {
    const ext = renderer.extensions;
    const half = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    const defines: Record<string, string> = { STEPS: small ? '44' : '72', LSTEPS: small ? '3' : '4', ...(half ? {} : { CLOUD_LDR: '' }) };
    this.params = withAmount(skyFor(this.settings.kind, this.hour).params, this.settings.amount);
    this.shadowPx = small ? 256 : 512;
    this.gridMap = hu.uGridMap.value;

    this.noise3 = new THREE.WebGL3DRenderTarget(NOISE, NOISE, NOISE, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.noise3.texture.wrapS = this.noise3.texture.wrapT = this.noise3.texture.wrapR = THREE.RepeatWrapping;
    this.wnoise = new THREE.WebGLRenderTarget(WN, WN, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping });
    this.shadowRT = new THREE.WebGLRenderTarget(this.shadowPx, this.shadowPx, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rt = new THREE.WebGLRenderTarget(1, 1, { count: 2, depthBuffer: false, type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rt.textures[1].minFilter = this.rt.textures[1].magFilter = THREE.NearestFilter;
    this.weather = new THREE.DataTexture(new Uint8Array([0, 128, 0, 0]), 1, 1, THREE.RGBAFormat);
    this.weather.minFilter = this.weather.magFilter = THREE.LinearFilter;
    this.weather.needsUpdate = true;
    sh.tCloudSh.value = this.shadowRT.texture;

    const common = {
      tNoise: { value: this.noise3.texture }, tWNoise: { value: this.wnoise.texture }, tWeather: { value: this.weather },
      uGridMap: hu.uGridMap, uWMap: { value: new THREE.Vector4(4, 12, 1, 1) }, uEx: hu.uEx,
      uC0: { value: new THREE.Vector4() }, uC1: { value: new THREE.Vector4() }, uC2: { value: new THREE.Vector4(0, 0, NOISE_KM, WEATHER_KM) },
      uDrift: { value: this.drift },
      uDensity: { value: DENSITY }, uLightDir: { value: this.lightDir },
    };
    const pass = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FULLSCREEN, fragmentShader, uniforms, defines, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.genMat = pass(NOISE_GEN, { uZ: { value: 0 }, uMode: { value: 0 }, uRes: { value: new THREE.Vector2(NOISE, NOISE) } });
    this.volMat = pass(VOLUME, {
      ...common, tH0: hu.tH0, tFields: fields, uGridMax: { value: new THREE.Vector2(1, 1) },
      uInvVP: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() }, uTarget: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3() },
      uSize: { value: new THREE.Vector2(1, 1) }, uBox: { value: new THREE.Vector4() }, uY: { value: new THREE.Vector3() }, uSlope: { value: 0.3 },
      uLightColor: { value: new THREE.Color() }, uAmbTop: { value: new THREE.Color() }, uAmbBottom: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
      uHole: { value: new THREE.Vector2() }, uQuality: { value: 1 }, uFlash: { value: new THREE.Vector4() }, uNear: { value: new THREE.Vector2(0.3, 2) },
    });
    this.shMat = pass(SHADOW, { ...common, uSM: { value: new THREE.Vector4() }, uSMSize: { value: this.shadowPx }, uYRef: { value: 0 } });
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN, fragmentShader: COMPOSITE_FRAG, defines: half ? {} : { CLOUD_LDR: '' },
      uniforms: {
        tCloud: { value: this.rt.textures[0] }, tCloudD: { value: this.rt.textures[1] }, uCloudSize: { value: new THREE.Vector2(1, 1) }, uCloudTex: { value: new THREE.Vector2(1, 1) },
        uScreen: { value: new THREE.Vector2(1, 1) }, uProjZ: { value: new THREE.Vector2() },
        uHazeColor: haze.uHazeColor, uHazeAmt: haze.uHazeAmt, uHazeRef: haze.uHazeRef,
      },
      transparent: true, premultipliedAlpha: true, depthWrite: false, depthTest: true,
    });
    this.composite = new THREE.Mesh(tri(), this.compMat);
    this.composite.frustumCulled = false;
    this.composite.renderOrder = 4;
    this.composite.visible = false;
    this.quad = new THREE.Mesh(tri(), this.genMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Compila los sombreadores de las pasadas (con su destino puesto: el programa depende de él). */
  compile(): Promise<unknown> {
    const r = this.renderer, prev = r.getRenderTarget(), jobs: Promise<unknown>[] = [];
    for (const [mat, target] of [[this.genMat, this.wnoise], [this.volMat, this.rt], [this.shMat, this.shadowRT]] as const) {
      const scene = new THREE.Scene().add(new THREE.Mesh(this.quad.geometry, mat));
      r.setRenderTarget(target);
      jobs.push(r.compileAsync(scene, this.quadCam).catch(() => undefined));
    }
    r.setRenderTarget(prev);
    return Promise.all(jobs).then(() => { this.compiled = true; });
  }

  /** Ruido de forma (64³) y del tiempo (256²), una sola vez y en partes: 16 capas por cuadro, sin tirón al aparecer. */
  private generateSome() {
    const r = this.renderer, u = this.genMat.uniforms, prev = r.getRenderTarget();
    this.quad.material = this.genMat;
    u.uMode.value = 0;
    u.uRes.value.set(NOISE, NOISE);
    for (const end = Math.min(NOISE, this.layers + 16); this.layers < end; this.layers++) {
      u.uZ.value = (this.layers + 0.5) / NOISE;
      r.setRenderTarget(this.noise3, this.layers);
      r.render(this.quadScene, this.quadCam);
    }
    if (this.layers >= NOISE) {
      u.uMode.value = 1;
      u.uRes.value.set(WN, WN);
      r.setRenderTarget(this.wnoise);
      r.render(this.quadScene, this.quadCam);
      this.generated = true;
    }
    r.setRenderTarget(prev);
  }

  /** Centros de las celdas de tormenta (máximos locales del canal g) y su número al azar, para los relámpagos. */
  private findCells() {
    const r = this.renderer, buf = new Uint8Array(WN * WN * 4);
    r.readRenderTargetPixels(this.wnoise, 0, 0, WN, WN, buf);
    const at = (x: number, y: number) => buf[((((y % WN) + WN) % WN) * WN + (((x % WN) + WN) % WN)) * 4 + 1];
    for (let y = 0; y < WN; y++) for (let x = 0; x < WN; x++) {
      const g = at(x, y);
      if (g < 225) continue;
      let top = true;
      for (let dy = -3; dy <= 3 && top; dy++) for (let dx = -3; dx <= 3; dx++) if ((dx || dy) && (at(x + dx, y + dy) > g || (at(x + dx, y + dy) === g && dy * WN + dx < 0))) { top = false; break; }
      if (top) this.cells.push({ u: (x + 0.5) / WN, v: (y + 0.5) / WN, id: buf[(y * WN + x) * 4 + 2] / 255 });
    }
  }

  /** Relieve y municipios (al armar la escena). Las nubes aparecen cuando llega la lluvia (setRain). */
  setTerrain(t: CloudTerrain) {
    this.terrain = t;
    this.volMat.uniforms.uGridMax.value.set(t.W - 1, t.H - 1);
  }

  /**
   * Clima de las nubes con la lluvia media anual (url de capas/lluvia.bin), armado en un worker. Si el worker no puede
   * arrancar, se arma aquí sin la lluvia (humedad pareja).
   */
  loadWeather(url: string): Promise<void> {
    const t = this.terrain;
    if (!t) return Promise.resolve();
    return new Promise<void>(resolve => {
      const done = (g: WeatherGrid) => { if (!this.disposed) this.applyWeather(g); resolve(); };
      try {
        const w = (this.worker = new Worker(new URL('../worker/clouds.worker.ts', import.meta.url), { type: 'module' }));
        w.onmessage = (ev: MessageEvent<CloudWeatherResult>) => {
          w.terminate();
          this.worker = null;
          if (ev.data.warning) console.warn('Relieve de Hidalgo:', ev.data.warning);
          done(ev.data.grid);
        };
        w.onerror = () => { w.terminate(); this.worker = null; done(buildWeather(t.elev, t.muni, t.W, t.H, t.cellKm, null)); };
        const req: CloudWeatherRequest = { url, elev: t.elev, muni: t.muni, W: t.W, H: t.H, cellKm: t.cellKm };
        w.postMessage(req);
      } catch {
        done(buildWeather(t.elev, t.muni, t.W, t.H, t.cellKm, null));
      }
    });
  }

  private applyWeather(g: WeatherGrid) {
    this.grid = g;
    this.weather.dispose();
    const tex = new THREE.DataTexture(g.data, g.w, g.h, THREE.RGBAFormat);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.weather = tex;
    this.volMat.uniforms.tWeather.value = this.shMat.uniforms.tWeather.value = tex;
    this.volMat.uniforms.uWMap.value.set(g.f, g.m, g.w, g.h);
    this.shadowDirty = true;
  }

  /** Cambia el cielo (tipo, cantidad, viento, lapso). */
  set(s: Partial<CloudSettings>) {
    Object.assign(this.settings, s);
    this.updateParams();
  }
  setHour(h: number) {
    this.hour = h;
    if (this.settings.kind === 'auto') this.updateParams();
  }
  private updateParams() {
    const sky = skyFor(this.settings.kind, this.hour);
    this.params = withAmount(sky.params, this.settings.amount);
    this.description = sky.text;
    this.shadowDirty = true;
  }
  /** Capa de nubes encendida o apagada (con fundido). */
  setOn(on: boolean) { this.on = on; }
  /** Ocultas mientras hay un análisis abierto (que no tapen los datos). */
  setSuppressed(s: boolean) { this.suppressed = s; }

  setLight(l: CloudLight) {
    const u = this.volMat.uniforms;
    if (!l.dir.equals(this.lightDir)) this.shadowDirty = true;
    this.lightDir.copy(l.dir).normalize();
    u.uLightColor.value.copy(l.color);
    u.uAmbTop.value.copy(l.ambTop);
    u.uAmbBottom.value.copy(l.ambBottom);
    u.uGlow.value.copy(l.glow);
    if (l.shadow !== this.shadowStrength) { this.shadowStrength = l.shadow; this.shadowDirty = true; }
    this.night = l.night;
  }

  get visible() { return this.fade > 0; }
  get playing() { return this.settings.play && this.fade > 0; }

  /**
   * Avanza la aparición y, con rate > 0, el viento y la forma (rate 1 = lapso de tiempo). allowed = false las retiene
   * (durante la entrada del relieve). Devuelve si cambió algo que obliga a dibujar otra vez.
   */
  step(dt: number, rate: number, allowed = true) {
    let changed = false;
    // con cantidad 0 no queda nada que dibujar: se apagan las pasadas
    const some = this.params.cover + this.params.storm + this.params.fog > 0.002;
    const want = this.on && !this.suppressed && some && !!this.grid && this.compiled && allowed;
    if (want && !this.generated) { this.generateSome(); changed = true; }
    const target = want && this.generated ? 1 : 0;
    if (this.fade !== target) {
      this.fade = target > this.fade ? Math.min(target, this.fade + dt / 0.9) : Math.max(target, this.fade - dt / 0.6);
      this.shadowDirty = changed = true;
    }
    if (rate > 0 && this.fade > 0) {
      const [wx, wz] = windVector(this.settings.wind), k = DRIFT_KMS * dt * rate;
      this.drift.x += wx * k;
      this.drift.y += wz * k;
      this.drift.z += EVOLVE_KMS * dt * rate;
      this.shadowDirty = changed = true;
    }
    // relámpagos: solo con el lapso de tiempo, en celdas de tormenta activas
    const fl = this.volMat.uniforms.uFlash.value as THREE.Vector4;
    if (rate >= 1 && this.fade > 0 && this.params.storm > 0.05) {
      this.flashT += dt;
      if (this.flashT > this.flashNext) this.strike();
      const t = this.flashT;
      fl.w = this.flashOn ? (Math.exp(-((t / 0.05) ** 2)) + 0.6 * Math.exp(-(((t - 0.17) / 0.05) ** 2))) * (0.6 + 1.6 * this.night) * this.fade : 0;
    } else fl.w = 0;
    this.composite.visible = this.fade > 0;
    if (!this.fade) this.sh.uCloudSh1.value.z = this.sh.uCloudSh1.value.w = 0;
    return changed;
  }

  /** Elige una celda de tormenta activa dentro del estado (las mismas cuentas que cColumn) y pone ahí el relámpago. */
  private strike() {
    const g = this.grid, gm = this.gridMap, fl = this.volMat.uniforms.uFlash.value as THREE.Vector4;
    this.flashT = 0;
    this.flashNext = 0.5 + Math.random() * 2.8;
    this.flashOn = false;
    // la primera vez se leen las celdas de la GPU (cuando ya terminó de generar el ruido)
    if (!this.cells.length && this.generated) this.findCells();
    if (!g || !this.cells.length) return;
    const p = this.params, box = this.terrain!;
    for (let tries = 0; tries < 12; tries++) {
      const c = this.cells[Math.floor(Math.random() * this.cells.length)];
      // la copia de la celda (el ruido se repite cada WEATHER_KM) que cae en el mapa
      const x = c.u * WEATHER_KM + this.drift.x + Math.round((box.xMin + box.xMax - 2 * (c.u * WEATHER_KM + this.drift.x)) / 2 / WEATHER_KM) * WEATHER_KM;
      const z = c.v * WEATHER_KM + this.drift.y + Math.round((box.zMin + box.zMax - 2 * (c.v * WEATHER_KM + this.drift.y)) / 2 / WEATHER_KM) * WEATHER_KM;
      const tx = Math.round((x - gm.x) / gm.z / g.f) + g.m, ty = Math.round((z - gm.y) / gm.w / g.f) + g.m;
      if (tx < 0 || ty < 0 || tx >= g.w || ty >= g.h) continue;
      const i = (ty * g.w + tx) * 4, mask = g.data[i] / 255, hum = g.data[i + 1] / 255;
      if (mask < 0.7 || p.storm * (0.45 + 1.05 * hum) - c.id < 0.04) continue;
      fl.set(x, ((g.data[i + 2] / 255) * 3.5 + p.base) * this.ex + p.stormTop * 0.35, z, 0);
      this.flashOn = true;
      return;
    }
    this.flashOn = false;
  }

  /** Tamaño del lienzo en px de CSS: el volumen se calcula a la mitad (menos en pantallas muy grandes o celulares). */
  setSize(w: number, h: number) {
    const k = Math.min(this.small ? 0.4 : 0.5, Math.sqrt(560000 / Math.max(1, w * h)));
    const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    if (cw === this.size.x && ch === this.size.y) return;
    this.size.set(cw, ch);
    this.rt.setSize(cw, ch);
    this.compMat.uniforms.uCloudTex.value.set(cw, ch);
  }

  /** El último volumen se calculó con menos resolución (al moverse): falta un cuadro a resolución completa. */
  get coarse() { return this.lastFast && this.fade > 0; }

  /**
   * Pasadas previas al cuadro: sombra (si cambió algo) y volumen. target = punto que mira la cámara (escena); fast = la
   * cámara o las nubes se mueven: el volumen se calcula con la mitad de los píxeles y un poco menos de detalle.
   */
  render(camera: THREE.PerspectiveCamera, target: THREE.Vector3, ex: number, fast = false) {
    const t = this.terrain, g = this.grid;
    if (!t || !g || this.fade <= 0) return;
    if (!this.generated) return;
    const r = this.renderer, prev = r.getRenderTarget();
    const p = this.params, top = Math.max(p.thick, p.storm > 0 ? p.stormTop : 0);
    if (ex !== this.ex) { this.ex = ex; this.shadowDirty = true; }
    for (const m of [this.volMat, this.shMat]) {
      const u = m.uniforms;
      u.uC0.value.set(p.cover, p.base, p.thick, p.stratus);
      u.uC1.value.set(p.storm, p.stormTop, p.fog, p.fogTop);
      u.uC2.value.x = p.fogValley;
      u.uC2.value.y = this.fade;
    }
    const sh = this.sh;
    if (this.shadowDirty) {
      this.shadowDirty = false;
      const L = this.lightDir, strength = this.shadowStrength * this.fade * (p.cover + p.storm > 0.02 ? 1 : 0);
      sh.uCloudSh1.value.z = L.y > 0.04 ? strength : 0;
      sh.uCloudSh1.value.w = 0.25 * this.fade * Math.max(0, p.cover - 0.5) * 2 * Math.min(1, this.shadowStrength * 1.5);
      if (sh.uCloudSh1.value.z > 0) {
        // plano de referencia a media altura del relieve; el mapa cubre todo lo que el relieve puede consultar
        const yRef = (t.maxElev / 2000) * ex, kx = L.x / L.y, kz = L.z / L.y, off = (t.maxElev / 2000) * ex;
        const x0 = t.xMin - Math.abs(kx) * off - 4, x1 = t.xMax + Math.abs(kx) * off + 4;
        const z0 = t.zMin - Math.abs(kz) * off - 4, z1 = t.zMax + Math.abs(kz) * off + 4;
        const u = this.shMat.uniforms;
        u.uSM.value.set(x0, z0, x1 - x0, z1 - z0);
        u.uYRef.value = yRef;
        sh.uCloudSh0.value.set(kx * yRef - x0, kz * yRef - z0, kx * ex * 0.001, kz * ex * 0.001);
        sh.uCloudSh1.value.x = 1 / (x1 - x0);
        sh.uCloudSh1.value.y = 1 / (z1 - z0);
        this.quad.material = this.shMat;
        r.setRenderTarget(this.shadowRT);
        r.render(this.quadScene, this.quadCam);
      }
    }
    // volumen
    const u = this.volMat.uniforms;
    camera.updateMatrixWorld();
    u.uInvVP.value.multiplyMatrices(camera.matrixWorld, this.tmp.copy(camera.projectionMatrixInverse));
    u.uCam.value.copy(camera.position).divideScalar(UNIT);
    u.uTarget.value.copy(target).divideScalar(UNIT);
    u.uFwd.value.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const dist = camera.position.distanceTo(target);
    // claro alrededor del punto que se mira: aparece al bajar de ~120 km y es completo a ~45 km
    const s = Math.min(1, Math.max(0, (1.2 - dist) / 0.75));
    u.uHole.value.set(s * s * (3 - 2 * s), Math.tan((8 * Math.PI) / 180));
    // las nubes muy cerca de la cámara se desvanecen en proporción a lo lejos que mira: al acercarse, no tapan la vista
    const dv = dist / UNIT;
    u.uNear.value.set(Math.max(0.3, dv * 0.16), Math.max(1.5, dv * 0.3));
    u.uBox.value.set(t.xMin - 10, t.zMin - 10, t.xMax + 10, t.zMax + 10);
    u.uY.value.set(0, (g.maxSmooth + p.base) * ex + top + 0.5, (t.maxElev / 1000) * ex);
    u.uSlope.value = g.slope * ex * 1.3;
    const k = fast ? Math.SQRT1_2 : 1, ew = Math.max(1, Math.round(this.size.x * k)), eh = Math.max(1, Math.round(this.size.y * k));
    this.rt.viewport.set(0, 0, ew, eh);
    u.uSize.value.set(ew, eh);
    u.uQuality.value = fast ? 0 : 1;
    this.compMat.uniforms.uCloudSize.value.set(ew, eh);
    this.lastFast = fast;
    this.quad.material = this.volMat;
    r.setRenderTarget(this.rt);
    r.render(this.quadScene, this.quadCam);
    r.setRenderTarget(prev);
    // composición
    const cu = this.compMat.uniforms, pm = camera.projectionMatrix.elements;
    r.getDrawingBufferSize(cu.uScreen.value);
    cu.uProjZ.value.set(pm[10], pm[14]);
  }

  dispose() {
    this.disposed = true;
    this.worker?.terminate();
    for (const d of [this.noise3, this.wnoise, this.shadowRT, this.rt, this.genMat, this.volMat, this.shMat, this.compMat, this.weather, this.quad.geometry, this.composite.geometry]) d.dispose();
  }
}
