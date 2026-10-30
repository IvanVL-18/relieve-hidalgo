import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Heightfield } from './heightfield';
import { HEIGHT_GLSL, withHeights, type HeightUniforms } from './heights';

/** Contenido de la ficha al pasar el cursor sobre un punto. */
export interface Tooltip { title: string; lines?: string[] }

export interface PointsSpec {
  lon: Float32Array;
  lat: Float32Array;
  /** RGBA sRGB por punto (alfa 0 = oculto) */
  color: Uint8Array;
  /** 'dot': círculo en pantalla (size = px) · 'column': columna 3D (size = radio en km, height = km) */
  shape: 'dot' | 'column';
  size: Float32Array | number;
  height?: Float32Array;
  pickable?: boolean;
  tooltip?: (i: number) => Tooltip | null;
}

export interface PointsHandle {
  readonly kind: 'points';
  readonly spec: PointsSpec;
  /** reemplaza colores (RGBA sRGB); alfa 0 oculta el punto */
  setColors(rgba: Uint8Array): void;
  setHeights(h: Float32Array): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

export interface LinesSpec {
  /** polilíneas: vértices en lon/lat y, por línea, inicio y número de vértices */
  lon: Float32Array;
  lat: Float32Array;
  start: Uint32Array;
  len: Uint32Array;
  /** RGBA sRGB por línea */
  color: Uint8Array;
  /** sobre todo lo demás (rutas) o integrada al relieve (red vial) */
  onTop?: boolean;
  opacity?: number;
  /** grosor en px; > 1 usa líneas de pantalla (más costosas: solo para pocas líneas, como una ruta) */
  width?: number;
}

export interface LinesHandle {
  readonly kind: 'lines';
  setColors(rgbaPerLine: Uint8Array): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

/** Arcos 3D de un punto a otro (flujos): parten del relieve, suben y bajan en el destino. */
export interface ArcsSpec {
  lon0: Float32Array; lat0: Float32Array;
  lon1: Float32Array; lat1: Float32Array;
  /** RGBA sRGB por arco (alfa 0 = oculto); el arco se desvanece hacia el origen para que se lea la dirección */
  color: Uint8Array;
  /** grosor en px por arco (o uno para todos) */
  width: Float32Array | number;
  /** altura de la cima sobre la cuerda: fracción del largo del arco (0.2 por omisión) más 1.2 km, en km reales (no cambia con la exageración) */
  lift?: number;
}

export interface ArcsHandle {
  readonly kind: 'arcs';
  setColors(rgba: Uint8Array): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

const s2l = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

/** Superficie compartida (heights.ts): las capas se apoyan en el mismo relieve que se dibuja. */
export interface SurfaceShaders { uniforms: HeightUniforms; defines: Record<string, string> }

/** Puntos en pantalla: círculo con borde oscuro, tamaño en px que crece un poco al acercarse. */
function dotMaterial(pixelRatio: number, sf: SurfaceShaders) {
  return new THREE.ShaderMaterial({
    defines: { ...sf.defines },
    uniforms: { ...sf.uniforms, uScale: { value: pixelRatio } },
    vertexShader: /* glsl */ `
      ${HEIGHT_GLSL}
      attribute float aSize; attribute vec4 aColor; uniform float uScale;
      varying vec4 vColor;
      vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
      void main() {
        vec3 p = vec3(position.x, rhSurface(rhGridOf(position.xz)) * 0.001 + 0.01, position.z);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_Position.z -= 0.0004 * gl_Position.w;
        gl_PointSize = aColor.a > 0.0 ? aSize * uScale * clamp(2.6 / -mv.z, 0.75, 2.4) : 0.0;
        vColor = vec4(toLin(aColor.rgb), aColor.a);
      }`,
    fragmentShader: /* glsl */ `
      varying vec4 vColor;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        if (r > 1.0) discard;
        float aa = fwidth(r);
        vec3 c = mix(vColor.rgb, vec3(0.02, 0.025, 0.035), smoothstep(0.62 - aa, 0.62, r));
        gl_FragColor = vec4(c, vColor.a * (1.0 - smoothstep(1.0 - aa, 1.0, r)));
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
}

/** Líneas sobre el relieve: se adelantan un poco en profundidad para no hundirse entre vértices. */
function lineMaterial(onTop: boolean, opacity: number, lift: number, sf: SurfaceShaders) {
  return new THREE.ShaderMaterial({
    defines: { ...sf.defines },
    uniforms: { ...sf.uniforms, uOpacity: { value: opacity }, uLift: { value: lift } },
    vertexShader: /* glsl */ `
      ${HEIGHT_GLSL}
      attribute vec4 aColor; varying vec4 vColor; uniform float uLift;
      vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
      void main() {
        vec3 p = vec3(position.x, rhSurface(rhGridOf(position.xz)) * 0.001 + uLift, position.z);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        gl_Position.z -= 0.0006 * gl_Position.w;
        vColor = vec4(toLin(aColor.rgb), aColor.a);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity; varying vec4 vColor;
      void main() {
        if (vColor.a < 0.01) discard;
        gl_FragColor = vec4(vColor.rgb, vColor.a * uOpacity);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: !onTop,
  });
}

/** Línea de pantalla (rutas) sobre la superficie: la altura de cada extremo la pone el sombreador. */
function screenLineMaterial(spec: LinesSpec, lift: number, sf: SurfaceShaders) {
  const mat = new LineMaterial({ linewidth: spec.width, vertexColors: true, transparent: (spec.opacity ?? 1) < 1, opacity: spec.opacity ?? 1, depthTest: !spec.onTop, depthWrite: false });
  mat.defines = { ...mat.defines, ...sf.defines };
  mat.customProgramCacheKey = () => 'rh-screen-line';
  mat.onBeforeCompile = sh => {
    withHeights(sh, sf.uniforms);
    sh.uniforms.uLift = { value: lift };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uLift;')
      .replace('vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );', `
        vec3 rhS = vec3(instanceStart.x, rhSurface(rhGridOf(instanceStart.xz)) * 0.001 + uLift, instanceStart.z);
        vec4 start = modelViewMatrix * vec4( rhS, 1.0 );`)
      .replace('vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );', `
        vec3 rhE = vec3(instanceEnd.x, rhSurface(rhGridOf(instanceEnd.xz)) * 0.001 + uLift, instanceEnd.z);
        vec4 end = modelViewMatrix * vec4( rhE, 1.0 );`);
  };
  return mat;
}

/**
 * Arcos: cinta de pantalla a lo largo de una parábola entre dos puntos de la superficie. Cada vértice calcula su punto
 * del arco y el de sus vecinos, y se separa del eje perpendicularmente en pantalla (grosor en px fijo).
 */
function arcMaterial(lift: number, resolution: THREE.Vector2, sf: SurfaceShaders) {
  return new THREE.ShaderMaterial({
    defines: { ...sf.defines },
    uniforms: { ...sf.uniforms, uLift: { value: lift }, uRes: { value: resolution } },
    vertexShader: /* glsl */ `
      ${HEIGHT_GLSL}
      attribute vec2 aA; attribute vec2 aB; attribute float aT; attribute float aSide; attribute float aWidth; attribute vec4 aColor;
      uniform float uLift; uniform vec2 uRes;
      varying vec4 vColor; varying float vSide;
      vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
      float hA, hB, len;
      vec4 clipAt(float t) {
        // cima a uLift · largo + 1.2 km sobre la cuerda, en km reales (el grupo del modelo multiplica y por la exageración):
        // los arcos cortos libran el relieve exagerado y los largos no se disparan al exagerar
        vec3 p = vec3(mix(aA.x, aB.x, t), mix(hA, hB, t) + (uLift * len + 1.2) * 4.0 * t * (1.0 - t) / uEx, mix(aA.y, aB.y, t));
        return projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
      void main() {
        hA = rhSurface(rhGridOf(aA)) * 0.001 + 0.004;
        hB = rhSurface(rhGridOf(aB)) * 0.001 + 0.004;
        len = length(aB - aA);
        vec4 c = clipAt(aT), n = clipAt(min(1.0, aT + 0.02)), b = clipAt(max(0.0, aT - 0.02));
        vColor = vec4(toLin(aColor.rgb), aColor.a * mix(0.3, 1.0, aT));
        vSide = aSide;
        if (aColor.a <= 0.0 || c.w <= 0.0 || n.w <= 0.0 || b.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        vec2 dir = (n.xy / n.w - b.xy / b.w) * uRes;
        dir = length(dir) > 1e-6 ? normalize(dir) : vec2(1.0, 0.0);
        c.xy += vec2(-dir.y, dir.x) * aSide * aWidth / uRes * c.w;
        gl_Position = c;
      }`,
    fragmentShader: /* glsl */ `
      varying vec4 vColor; varying float vSide;
      void main() {
        float aa = fwidth(vSide);
        gl_FragColor = vec4(vColor.rgb, vColor.a * (1.0 - smoothstep(1.0 - aa * 1.5, 1.0, abs(vSide))));
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    // la cinta se arma en pantalla: según hacia dónde va el arco, sus triángulos quedan de frente o de espaldas
    side: THREE.DoubleSide,
  });
}

/** Columnas 3D: la base de cada instancia se apoya en la superficie (la matriz trae x, z y la escala). */
function columnMaterial(sf: SurfaceShaders) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0, emissive: 0x000000 });
  mat.defines = { ...sf.defines };
  mat.customProgramCacheKey = () => 'rh-column';
  mat.onBeforeCompile = sh => {
    withHeights(sh, sf.uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `
      vec4 mvPosition = vec4( transformed, 1.0 );
      #ifdef USE_INSTANCING
      mvPosition = instanceMatrix * mvPosition;
      mvPosition.y += rhSurface(rhGridOf(instanceMatrix[3].xz)) * 0.001;
      #endif
      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;`);
  };
  return mat;
}

/**
 * Capas de puntos y líneas de los análisis. Viven dentro del grupo del modelo, así que siguen la exageración
 * vertical. Las coordenadas se pasan a km locales; la altura la pone el sombreador con la misma superficie que el
 * relieve (no se hunden ni flotan al cambiar el detalle). Las anclas en CPU (para señalar con el cursor) usan la mejor
 * altura disponible al crearlas.
 */
export class Overlays {
  private points = new Set<PointsLayer>();
  private lines = new Set<LinesLayer>();
  private arcs = new Set<ArcsLayer>();
  private proj = new THREE.Vector3();
  private proj2 = new THREE.Vector3();
  /** tamaño del lienzo en px CSS, para el grosor de las líneas de pantalla */
  readonly resolution = new THREE.Vector2(1, 1);

  constructor(private model: THREE.Group, private hf: Heightfield, private pixelRatio: number, private sf: SurfaceShaders, private onChange: () => void) {}

  addPoints(spec: PointsSpec): PointsHandle {
    const layer = new PointsLayer(spec, this.hf, this.pixelRatio, this.sf, this.onChange, () => { this.points.delete(layer); this.onChange(); });
    this.points.add(layer);
    this.model.add(layer.object);
    this.onChange();
    return layer;
  }

  addLines(spec: LinesSpec): LinesHandle {
    const layer = new LinesLayer(spec, this.hf, this.resolution, this.sf, this.onChange, () => { this.lines.delete(layer); this.onChange(); });
    this.lines.add(layer);
    this.model.add(layer.object);
    this.onChange();
    return layer;
  }

  addArcs(spec: ArcsSpec): ArcsHandle {
    const layer = new ArcsLayer(spec, this.hf, this.resolution, this.sf, this.onChange, () => { this.arcs.delete(layer); this.onChange(); });
    this.arcs.add(layer);
    this.model.add(layer.object);
    this.onChange();
    return layer;
  }

  /** Punto más cercano al cursor (px), entre las capas visibles que se pueden señalar. */
  pick(camera: THREE.Camera, model: THREE.Matrix4, sx: number, sy: number, w: number, h: number) {
    let best: { layer: PointsLayer; index: number } | null = null, bd = Infinity;
    const p = this.proj, q = this.proj2;
    for (const L of this.points) {
      if (!L.object.visible || !L.spec.pickable) continue;
      const { anchors, top } = L, n = L.count, col = L.spec.color;
      const r = L.spec.shape === 'dot' ? 9 : 7;
      for (let i = 0; i < n; i++) {
        if (!col[i * 4 + 3]) continue;
        p.set(anchors[i * 3], anchors[i * 3 + 1], anchors[i * 3 + 2]).applyMatrix4(model).project(camera);
        if (p.z > 1) continue;
        const ax = (p.x * 0.5 + 0.5) * w, ay = (-p.y * 0.5 + 0.5) * h;
        let d: number;
        if (top) {
          // columna: distancia al segmento base–tope en pantalla
          q.set(anchors[i * 3], anchors[i * 3 + 1] + top[i], anchors[i * 3 + 2]).applyMatrix4(model).project(camera);
          const bx = (q.x * 0.5 + 0.5) * w, by = (-q.y * 0.5 + 0.5) * h;
          const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
          const t = l2 ? Math.max(0, Math.min(1, ((sx - ax) * vx + (sy - ay) * vy) / l2)) : 0;
          d = Math.hypot(sx - ax - vx * t, sy - ay - vy * t);
        } else d = Math.hypot(sx - ax, sy - ay);
        if (d < r && d < bd) { bd = d; best = { layer: L, index: i }; }
      }
    }
    return best;
  }

  dispose() {
    for (const L of [...this.points]) L.dispose();
    for (const L of [...this.lines]) L.dispose();
    for (const L of [...this.arcs]) L.dispose();
  }
}

/** Segmentos por arco: suficientes para que la parábola se vea curva de cerca. */
const ARC_SEG = 40;

class ArcsLayer implements ArcsHandle {
  readonly kind = 'arcs';
  readonly object: THREE.Mesh;
  private colorAttr: THREE.BufferAttribute;

  constructor(spec: ArcsSpec, hf: Heightfield, resolution: THREE.Vector2, sf: SurfaceShaders, private changed: () => void, private onDispose: () => void) {
    const g = hf.geo, n = spec.lon0.length, nv = n * (ARC_SEG + 1) * 2;
    const a = new Float32Array(nv * 2), b = new Float32Array(nv * 2), t = new Float32Array(nv), side = new Float32Array(nv), width = new Float32Array(nv);
    const index = new Uint32Array(n * ARC_SEG * 6);
    for (let i = 0, v = 0, o = 0; i < n; i++) {
      const ax = g.toX(spec.lon0[i]), az = g.toZ(spec.lat0[i]), bx = g.toX(spec.lon1[i]), bz = g.toZ(spec.lat1[i]);
      // grosor completo en px: el sombreador separa cada orilla w / 2 px del eje (w / resolución en coordenadas de recorte)
      const w = typeof spec.width === 'number' ? spec.width : spec.width[i];
      for (let s = 0; s <= ARC_SEG; s++) for (let e = 0; e < 2; e++, v++) {
        a[v * 2] = ax; a[v * 2 + 1] = az; b[v * 2] = bx; b[v * 2 + 1] = bz;
        t[v] = s / ARC_SEG; side[v] = e ? 1 : -1; width[v] = w;
      }
      const base = i * (ARC_SEG + 1) * 2;
      for (let s = 0; s < ARC_SEG; s++, o += 6) {
        const p = base + s * 2;
        index.set([p, p + 1, p + 2, p + 1, p + 3, p + 2], o);
      }
    }
    const geo = new THREE.BufferGeometry();
    // posición sin uso (el sombreador calcula todo), pero three la necesita para dibujar
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    geo.setAttribute('aA', new THREE.BufferAttribute(a, 2));
    geo.setAttribute('aB', new THREE.BufferAttribute(b, 2));
    geo.setAttribute('aT', new THREE.BufferAttribute(t, 1));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setAttribute('aWidth', new THREE.BufferAttribute(width, 1));
    this.colorAttr = new THREE.BufferAttribute(new Uint8Array(nv * 4), 4, true);
    geo.setAttribute('aColor', this.colorAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.object = new THREE.Mesh(geo, arcMaterial(spec.lift ?? 0.2, resolution, sf));
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
    this.setColors(spec.color);
  }

  setColors(rgba: Uint8Array) {
    const out = this.colorAttr.array as Uint8Array, per = (ARC_SEG + 1) * 2;
    for (let v = 0; v < out.length / 4; v++) out.set(rgba.subarray(Math.floor(v / per) * 4, Math.floor(v / per) * 4 + 4), v * 4);
    this.colorAttr.needsUpdate = true;
    this.changed();
  }

  setVisible(v: boolean) { this.object.visible = v; this.changed(); }

  dispose() {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
    this.onDispose();
  }
}

class PointsLayer implements PointsHandle {
  readonly kind = 'points';
  readonly object: THREE.Object3D;
  readonly count: number;
  /** base de cada punto en km locales */
  readonly anchors: Float32Array;
  /** altura de cada columna en km (null para círculos) */
  top: Float32Array | null = null;
  private mesh?: THREE.InstancedMesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.Material;

  constructor(readonly spec: PointsSpec, hf: Heightfield, pixelRatio: number, sf: SurfaceShaders, private changed: () => void, private onDispose: () => void) {
    const n = (this.count = spec.lon.length), g = hf.geo;
    const a = (this.anchors = new Float32Array(n * 3));
    for (let i = 0; i < n; i++) {
      a[i * 3] = g.toX(spec.lon[i]);
      a[i * 3 + 1] = hf.surfaceLL(spec.lat[i], spec.lon[i]) / 1000;
      a[i * 3 + 2] = g.toZ(spec.lat[i]);
    }
    if (spec.shape === 'dot') {
      const geo = (this.geo = new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(a), 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(Uint8Array.from(spec.color), 4, true));
      geo.setAttribute('aSize', new THREE.BufferAttribute(typeof spec.size === 'number' ? new Float32Array(n).fill(spec.size) : spec.size, 1));
      this.mat = dotMaterial(pixelRatio, sf);
      const pts = new THREE.Points(geo, this.mat);
      pts.frustumCulled = false;
      pts.renderOrder = 3;
      this.object = pts;
    } else {
      this.geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1).translate(0, 0.5, 0);
      this.mat = columnMaterial(sf);
      const mesh = (this.mesh = new THREE.InstancedMesh(this.geo, this.mat, n));
      mesh.frustumCulled = false;
      this.object = mesh;
      this.setHeights(spec.height ?? new Float32Array(n).fill(0.1));
      this.setColors(spec.color);
    }
  }

  setColors(rgba: Uint8Array) {
    this.spec.color = rgba;
    if (this.mesh) {
      const c = new THREE.Color();
      for (let i = 0; i < this.count; i++) {
        c.setRGB(s2l(rgba[i * 4]), s2l(rgba[i * 4 + 1]), s2l(rgba[i * 4 + 2]));
        this.mesh.setColorAt(i, c);
      }
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      if (this.top) this.setHeights(this.top);   // alfa 0 → escala 0
    } else {
      const attr = this.geo.getAttribute('aColor') as THREE.BufferAttribute;
      (attr.array as Uint8Array).set(rgba);
      attr.needsUpdate = true;
    }
    this.changed();
  }

  setHeights(h: Float32Array) {
    if (!this.mesh) return;
    this.top = h;
    const m = new THREE.Matrix4(), a = this.anchors, size = this.spec.size, col = this.spec.color;
    for (let i = 0; i < this.count; i++) {
      const r = col[i * 4 + 3] ? (typeof size === 'number' ? size : size[i]) : 0;
      // la altura del suelo la suma el sombreador; aquí solo se hunde un poco la base
      m.makeScale(r, col[i * 4 + 3] ? Math.max(1e-4, h[i]) : 0, r).setPosition(a[i * 3], -0.005, a[i * 3 + 2]);
      this.mesh.setMatrixAt(i, m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.changed();
  }

  setVisible(v: boolean) { this.object.visible = v; this.changed(); }

  dispose() {
    this.object.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.mesh?.dispose();
    this.onDispose();
  }
}

class LinesLayer implements LinesHandle {
  readonly kind = 'lines';
  readonly object: THREE.LineSegments | LineSegments2;
  private segLine: Uint32Array;
  private colorAttr: THREE.BufferAttribute | null = null;

  constructor(spec: LinesSpec, hf: Heightfield, resolution: THREE.Vector2, sf: SurfaceShaders, private changed: () => void, private onDispose: () => void) {
    const g = hf.geo, nl = spec.len.length;
    let nseg = 0;
    for (let l = 0; l < nl; l++) nseg += Math.max(0, spec.len[l] - 1);
    const pos = new Float32Array(nseg * 6), lineOf = (this.segLine = new Uint32Array(nseg));
    const lift = spec.onTop ? 0.02 : 0.012;
    let s = 0;
    for (let l = 0; l < nl; l++) {
      const st = spec.start[l];
      for (let k = st; k + 1 < st + spec.len[l]; k++, s++) {
        for (let e = 0; e < 2; e++) {
          const lon = spec.lon[k + e], lat = spec.lat[k + e], o = s * 6 + e * 3;
          pos[o] = g.toX(lon); pos[o + 1] = 0; pos[o + 2] = g.toZ(lat);
        }
        lineOf[s] = l;
      }
    }
    if ((spec.width ?? 1) > 1) {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(pos);
      const mat = screenLineMaterial(spec, lift, sf);
      mat.resolution = resolution;
      this.object = new LineSegments2(geo, mat);
    } else {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.colorAttr = new THREE.BufferAttribute(new Uint8Array(nseg * 8), 4, true);
      geo.setAttribute('aColor', this.colorAttr);
      geo.computeBoundingSphere();
      this.object = new THREE.LineSegments(geo, lineMaterial(!!spec.onTop, spec.opacity ?? 1, lift, sf));
    }
    this.object.renderOrder = spec.onTop ? 6 : 2;
    this.object.frustumCulled = false;
    this.setColors(spec.color);
  }

  setColors(rgba: Uint8Array) {
    const lineOf = this.segLine;
    if (!this.colorAttr) {
      // líneas de pantalla: color lineal por extremo de segmento
      const c = new Float32Array(lineOf.length * 6);
      for (let s = 0; s < lineOf.length; s++) {
        const l = lineOf[s] * 4;
        for (let e = 0; e < 2; e++) for (let k = 0; k < 3; k++) c[s * 6 + e * 3 + k] = s2l(rgba[l + k]);
      }
      (this.object.geometry as LineSegmentsGeometry).setColors(c);
      this.changed();
      return;
    }
    const out = this.colorAttr.array as Uint8Array;
    for (let s = 0; s < lineOf.length; s++) {
      const l = lineOf[s] * 4;
      for (let e = 0; e < 2; e++) out.set(rgba.subarray(l, l + 4), s * 8 + e * 4);
    }
    this.colorAttr.needsUpdate = true;
    this.changed();
  }

  setVisible(v: boolean) { this.object.visible = v; this.changed(); }

  dispose() {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
    this.onDispose();
  }
}
