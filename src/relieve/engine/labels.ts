import * as THREE from 'three';
import type { Heightfield } from './heightfield';

export type LabelKind = 'peak' | 'region' | 'city' | 'town' | 'village' | 'river' | 'lake';

export interface LabelItem {
  t: string;
  s?: string;
  k: LabelKind;
  lat: number;
  lon: number;
  /** menor = más importante; decide quién gana cuando dos etiquetas chocan */
  pri: number;
  lift?: number;
  pop?: number;
  /** se crea la primera vez que la etiqueta se muestra */
  el: HTMLDivElement | null;
  p: THREE.Vector3;
  w: number;
  on: boolean;
  /** última posición en pantalla (px), para la imagen descargable */
  x?: number;
  y?: number;
}

export interface LabelLayers { places: boolean; water: boolean }

/** Etiquetas HTML ancladas al relieve, con detección de choques en pantalla. */
export class Labels {
  readonly items: LabelItem[] = [];
  private placed: number[][] = [];
  private proj = new THREE.Vector3();
  private pinEl: HTMLDivElement;
  private pin: THREE.Vector3 | null = null;

  constructor(private layer: HTMLElement, private hf: Heightfield) {
    this.pinEl = document.createElement('div');
    this.pinEl.className = 'rh-lbl rh-pin';
    this.pinEl.innerHTML = '<b></b><em></em>';
    layer.appendChild(this.pinEl);
  }

  add(o: Omit<LabelItem, 'el' | 'p' | 'w' | 'on'>) {
    const g = this.hf.geo;
    const p = new THREE.Vector3(g.toX(o.lon), this.hf.elevLL(o.lat, o.lon) / 1000 + (o.lift ?? 0.02), g.toZ(o.lat));
    const w = (o.t.length + (o.s ? o.s.length + 1 : 0)) * (o.k === 'region' ? 7.6 : o.k === 'village' ? 6.2 : 7) + 14;
    const item: LabelItem = { ...o, el: null, p, w, on: false };
    this.items.push(item);
    return item;
  }

  private element(o: LabelItem) {
    const el = (o.el = document.createElement('div'));
    el.className = 'rh-lbl rh-' + o.k;
    const span = document.createElement('span');
    span.textContent = o.t;
    if (o.s) { const sm = document.createElement('small'); sm.textContent = o.s; span.append(' ', sm); }
    el.append(document.createElement('i'), span);
    this.layer.appendChild(el);
    return el;
  }

  sort() { this.items.sort((a, b) => a.pri - b.pri || (b.pop || 0) - (a.pop || 0)); }

  setPin(name: string | null, lat = 0, lon = 0) {
    if (name === null) { this.pin = null; this.pinEl.classList.remove('on'); return; }
    this.pin = new THREE.Vector3(this.hf.geo.toX(lon), this.hf.elevLL(lat, lon) / 1000 + 0.02, this.hf.geo.toZ(lat));
    this.pinEl.querySelector('b')!.textContent = name;
  }
  get pinPoint() { return this.pin; }

  layout(camera: THREE.Camera, model: THREE.Matrix4, dist: number, layers: LabelLayers, w: number, h: number) {
    const placed = this.placed, proj = this.proj;
    placed.length = 0;
    for (const o of this.items) {
      let want = true;
      if (o.k === 'region') want = dist > 1.2;
      else if (o.k === 'town') want = layers.places && dist < 3.2;
      else if (o.k === 'village') want = layers.places && dist < 1.0;
      else if (o.k === 'city') want = layers.places || o.t === 'Pachuca';
      else if (o.k === 'river' || o.k === 'lake') want = layers.water && dist < 3.6;
      let x = 0, y = 0;
      if (want) {
        proj.copy(o.p).applyMatrix4(model);
        const far = proj.distanceTo(camera.position);
        if (o.k === 'village' && far > 1.1) want = false;
        if (o.k === 'town' && far > 3.6) want = false;
        proj.project(camera);
        if (proj.z > 1 || proj.x < -1.1 || proj.x > 1.1 || proj.y < -1.1 || proj.y > 1.1) want = false;
        x = (proj.x * 0.5 + 0.5) * w; y = (-proj.y * 0.5 + 0.5) * h;
      }
      if (want) {
        const centered = o.k === 'region' || o.k === 'river' || o.k === 'lake';
        const x0 = centered ? x - o.w / 2 : x - 4, y0 = y - 9;
        const box = [x0 - 3, y0 - 2, x0 + o.w + 3, y0 + 20];
        for (const b of placed) if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) { want = false; break; }
        if (want) {
          placed.push(box);
          o.x = x0; o.y = y0;
          (o.el ?? this.element(o)).style.transform = `translate3d(${x0.toFixed(1)}px, ${y0.toFixed(1)}px, 0)`;
        }
      }
      if (want !== o.on) { o.on = want; o.el?.classList.toggle('on', want); }
    }
    if (this.pin) {
      proj.copy(this.pin).applyMatrix4(model).project(camera);
      const vis = proj.z < 1;
      this.pinEl.classList.toggle('on', vis);
      if (vis) this.pinEl.style.transform = `translate3d(${((proj.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-proj.y * 0.5 + 0.5) * h).toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }

  dispose() { this.layer.replaceChildren(); }
}
