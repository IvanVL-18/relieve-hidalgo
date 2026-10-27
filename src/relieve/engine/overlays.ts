import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Heightfield } from './heightfield';

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

const s2l = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };

/** Puntos en pantalla: círculo con borde oscuro, tamaño en px que crece un poco al acercarse. */
function dotMaterial(pixelRatio: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: pixelRatio } },
    vertexShader: /* glsl */ `
      attribute float aSize; attribute vec4 aColor; uniform float uScale;
      varying vec4 vColor;
      vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
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
function lineMaterial(onTop: boolean, opacity: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: opacity } },
    vertexShader: /* glsl */ `
      attribute vec4 aColor; varying vec4 vColor;
      vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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

/**
 * Capas de puntos y líneas de los análisis. Viven dentro del grupo del modelo, así que siguen la exageración
 * vertical. Las coordenadas se pasan a km locales y se apoyan en el relieve una sola vez, al crearlas.
 */
export class Overlays {
  private points = new Set<PointsLayer>();
  private lines = new Set<LinesLayer>();
  private proj = new THREE.Vector3();
  private proj2 = new THREE.Vector3();
  /** tamaño del lienzo en px CSS, para el grosor de las líneas de pantalla */
  readonly resolution = new THREE.Vector2(1, 1);

  constructor(private model: THREE.Group, private hf: Heightfield, private pixelRatio: number, private onChange: () => void) {}

  addPoints(spec: PointsSpec): PointsHandle {
    const layer = new PointsLayer(spec, this.hf, this.pixelRatio, this.onChange, () => { this.points.delete(layer); this.onChange(); });
    this.points.add(layer);
    this.model.add(layer.object);
    this.onChange();
    return layer;
  }

  addLines(spec: LinesSpec): LinesHandle {
    const layer = new LinesLayer(spec, this.hf, this.resolution, this.onChange, () => { this.lines.delete(layer); this.onChange(); });
    this.lines.add(layer);
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

  constructor(readonly spec: PointsSpec, hf: Heightfield, pixelRatio: number, private changed: () => void, private onDispose: () => void) {
    const n = (this.count = spec.lon.length), g = hf.geo;
    const a = (this.anchors = new Float32Array(n * 3));
    for (let i = 0; i < n; i++) {
      a[i * 3] = g.toX(spec.lon[i]);
      a[i * 3 + 1] = hf.elevLL(spec.lat[i], spec.lon[i]) / 1000;
      a[i * 3 + 2] = g.toZ(spec.lat[i]);
    }
    if (spec.shape === 'dot') {
      const geo = (this.geo = new THREE.BufferGeometry());
      const pos = Float32Array.from(a);
      for (let i = 0; i < n; i++) pos[i * 3 + 1] += 0.01;
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(Uint8Array.from(spec.color), 4, true));
      geo.setAttribute('aSize', new THREE.BufferAttribute(typeof spec.size === 'number' ? new Float32Array(n).fill(spec.size) : spec.size, 1));
      this.mat = dotMaterial(pixelRatio);
      const pts = new THREE.Points(geo, this.mat);
      pts.frustumCulled = false;
      pts.renderOrder = 3;
      this.object = pts;
    } else {
      this.geo = new THREE.CylinderGeometry(1, 1, 1, 8, 1).translate(0, 0.5, 0);
      this.mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0, emissive: 0x000000 });
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
      m.makeScale(r, col[i * 4 + 3] ? Math.max(1e-4, h[i]) : 0, r).setPosition(a[i * 3], a[i * 3 + 1] - 0.005, a[i * 3 + 2]);
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

  constructor(spec: LinesSpec, hf: Heightfield, resolution: THREE.Vector2, private changed: () => void, private onDispose: () => void) {
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
          pos[o] = g.toX(lon); pos[o + 1] = hf.elevLL(lat, lon) / 1000 + lift; pos[o + 2] = g.toZ(lat);
        }
        lineOf[s] = l;
      }
    }
    if ((spec.width ?? 1) > 1) {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(pos);
      const mat = new LineMaterial({ linewidth: spec.width, vertexColors: true, transparent: (spec.opacity ?? 1) < 1, opacity: spec.opacity ?? 1, depthTest: !spec.onTop, depthWrite: false });
      mat.resolution = resolution;
      this.object = new LineSegments2(geo, mat);
    } else {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.colorAttr = new THREE.BufferAttribute(new Uint8Array(nseg * 8), 4, true);
      geo.setAttribute('aColor', this.colorAttr);
      geo.computeBoundingSphere();
      this.object = new THREE.LineSegments(geo, lineMaterial(!!spec.onTop, spec.opacity ?? 1));
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
