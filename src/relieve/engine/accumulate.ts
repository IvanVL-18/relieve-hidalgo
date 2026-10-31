import * as THREE from 'three';

/** k-ésimo número de la secuencia de Halton en la base b (0–1). */
function halton(k: number, b: number) {
  let f = 1, r = 0;
  for (let i = k; i > 0; i = Math.floor(i / b)) { f /= b; r += f * (i % b); }
  return r;
}

const FULLSCREEN = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/**
 * Antialias progresivo en reposo (calidad Alta y Máxima): cada cuadro se dibuja con la cámara desplazada menos de un píxel
 * (Halton 2, 3), se copia del lienzo y se promedia con los anteriores; el promedio vuelve al lienzo. Con la cámara quieta
 * converge en unos cuantos cuadros: bordes y líneas sin dientes, y el grano de las nubes y de las sombras trazadas
 * promediado. Se promedia lo que ya está en el lienzo (tono y color de salida), así la imagen es la misma que sin promedio.
 */
export class Accumulator {
  private frame: THREE.FramebufferTexture | null = null;
  private rts: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private cur = 0;
  private size = new THREE.Vector2();
  private tmp = new THREE.Vector2();
  private mixMat: THREE.ShaderMaterial;
  private showMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera();
  private half: boolean;
  /** cuadros promediados (0 = nada todavía) */
  k = 0;

  constructor(private renderer: THREE.WebGLRenderer) {
    const ext = renderer.extensions;
    this.half = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    const pass = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    this.mixMat = pass(/* glsl */ `
      uniform sampler2D tPrev; uniform sampler2D tFrame; uniform float uW;
      void main() { ivec2 p = ivec2(gl_FragCoord.xy); gl_FragColor = mix(texelFetch(tPrev, p, 0), texelFetch(tFrame, p, 0), uW); }`,
    { tPrev: { value: null }, tFrame: { value: null }, uW: { value: 1 } });
    this.showMat = pass(/* glsl */ `
      uniform sampler2D tAcc;
      void main() { gl_FragColor = texelFetch(tAcc, ivec2(gl_FragCoord.xy), 0); }`,
    { tAcc: { value: null } });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(g, this.mixMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** Desplazamiento (px del lienzo, ±0.5) del cuadro k ≥ 1. */
  static jitter(k: number): [number, number] { return [halton(k, 2) - 0.5, halton(k, 3) - 0.5]; }

  /** Destinos del tamaño del lienzo (se rehacen si cambió). */
  private ensure() {
    const s = this.renderer.getDrawingBufferSize(this.tmp);
    if (this.frame && s.equals(this.size)) return;
    this.size.copy(s);
    this.frame?.dispose();
    this.rts?.forEach(rt => rt.dispose());
    this.frame = new THREE.FramebufferTexture(s.x, s.y);
    this.frame.minFilter = this.frame.magFilter = THREE.NearestFilter;
    const opts = { depthBuffer: false, type: this.half ? THREE.HalfFloatType : THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    this.rts = [new THREE.WebGLRenderTarget(s.x, s.y, opts), new THREE.WebGLRenderTarget(s.x, s.y, opts)];
    this.k = 0;
  }

  private pass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    const r = this.renderer;
    this.quad.material = mat;
    r.setRenderTarget(target);
    r.render(this.scene, this.cam);
  }

  /** Suma lo que hay en el lienzo (recién dibujado) con peso max(1/(k+1), minW) y pone el promedio en el lienzo. */
  add(minW = 0) {
    const r = this.renderer, prev = r.getRenderTarget();
    this.ensure();
    r.setRenderTarget(null);
    r.copyFramebufferToTexture(this.frame!);
    const [a, b] = this.cur ? [this.rts![1], this.rts![0]] : [this.rts![0], this.rts![1]];
    const u = this.mixMat.uniforms;
    u.tPrev.value = a.texture;
    u.tFrame.value = this.frame;
    u.uW.value = this.k === 0 ? 1 : Math.max(1 / (this.k + 1), minW);
    this.pass(this.mixMat, b);
    this.cur = 1 - this.cur;
    this.k++;
    // el primer cuadro ya está en el lienzo tal cual
    if (this.k > 1) { this.showMat.uniforms.tAcc.value = b.texture; this.pass(this.showMat, null); }
    r.setRenderTarget(prev);
  }

  reset() { this.k = 0; }

  dispose() {
    this.frame?.dispose();
    this.rts?.forEach(rt => rt.dispose());
    this.mixMat.dispose();
    this.showMat.dispose();
    this.quad.geometry.dispose();
  }
}
