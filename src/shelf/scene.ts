// The shelf of record sleeves (MVP doc §3). Built on the "Полка конвертов" sketch, with what the
// product needs on top: any number of sleeves in rows, scrolling, frames drawn only while something
// moves, and small textures on the shelf with a large one only for the sleeve in hand.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { ShelfEntry } from '../data/model';
import { backCanvas, frontCanvas, KRAFT, rng, stickerCanvas, vinylCanvas, type SleeveImages } from './textures';

const SIZE = 2;
const PITCH = 2.5;
const ROW_H = 3.3;
const LOW = 512;
const HIGH = 1024;

export interface ShelfItem {
  entry: ShelfEntry;
  images: SleeveImages;
}

interface Item extends ShelfItem {
  group: THREE.Group;
  front: THREE.MeshStandardMaterial;
  back: THREE.MeshStandardMaterial;
  sticker: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
  vinyl: THREE.Mesh | null;
  vinylMat: THREE.MeshPhysicalMaterial | null;
  home: { pos: THREE.Vector3; quat: THREE.Quaternion };
  hover: number;
  detail: number;
}

export interface ShelfCallbacks {
  onPick(entry: ShelfEntry): void;
  onPutBack(): void;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function tex(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class Shelf {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  private items: Item[] = [];
  private ledges = new THREE.Group();
  private wallMat = new THREE.MeshStandardMaterial({ roughness: 0.95 });
  private ledgeMat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
  private dimMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  private dim = new THREE.Mesh(new THREE.PlaneGeometry(80, 60), this.dimMat);
  private sun = new THREE.DirectionalLight(0xffffff, 1.6);
  private ambient = new THREE.AmbientLight(0xffffff, 0.25);
  private s = { picked: -1, flipped: false, open: false, rotX: 0, rotY: 0, hover: -1, dragging: false };
  private cols = 4;
  private camY = 0;
  private camYMin = 0;
  private camYMax = 0;
  private camZ = 12;
  private pickD = 6;
  private visibleH = 1;
  private raf = 0;
  private last = 0;
  private reduce = matchMedia('(prefers-reduced-motion: reduce)');

  constructor(
    private host: HTMLElement,
    private cb: ShelfCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    // Neutral keeps covers close to their real colours; ACES washed them out on the light wall.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    host.prepend(this.canvas);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const sun = this.sun;
    sun.position.set(3.5, 5, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 6, bottom: -6, near: 1, far: 25 });
    sun.shadow.radius = 6;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun, sun.target, this.ambient);

    const wall = new THREE.Mesh(new THREE.PlaneGeometry(80, 200), this.wallMat);
    wall.position.set(0, -60, -0.12);
    wall.receiveShadow = true;
    this.scene.add(wall, this.ledges, this.dim);

    this.applyTheme();
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(host);
    this.reduce.addEventListener('change', () => this.invalidate());
  }

  get pickedEntry(): ShelfEntry | null {
    return this.s.picked >= 0 ? this.items[this.s.picked].entry : null;
  }
  get flipped() {
    return this.s.flipped;
  }
  get recordOut() {
    return this.s.open;
  }

  setItems(list: ShelfItem[]) {
    const keep = this.pickedEntry?.bottle.id;
    for (const it of this.items) this.disposeItem(it);
    this.items = list.map((d, i) => this.buildItem(d, i));
    this.s.picked = keep ? this.items.findIndex((it) => it.entry.bottle.id === keep) : -1;
    if (this.s.picked >= 0) this.setDetail(this.items[this.s.picked], HIGH);
    this.layout();
    // fresh meshes start where they live, not in the middle of the scene
    for (const it of this.items) {
      it.group.position.copy(it.home.pos);
      it.group.quaternion.copy(it.home.quat);
    }
    this.invalidate();
  }

  applyTheme() {
    const night = document.documentElement.dataset.theme === 'dark';
    this.wallMat.color.set(css('--paper') || '#efeeec');
    this.ledgeMat.color.set(css('--paper-raised') || '#f8f8f7');
    this.dimMat.color.set(css('--paper') || '#efeeec');
    this.sun.intensity = night ? 0.8 : 1.3;
    this.ambient.intensity = night ? 0.06 : 0.15;
    this.renderer.toneMappingExposure = night ? 0.85 : 0.9;
    this.invalidate();
  }

  pick(i: number) {
    if (i < 0 || i >= this.items.length) return;
    if (this.s.picked >= 0 && this.s.picked !== i) this.setDetail(this.items[this.s.picked], LOW);
    Object.assign(this.s, { picked: i, flipped: false, open: false, rotX: 0, rotY: 0, hover: -1 });
    this.setDetail(this.items[i], HIGH);
    this.cb.onPick(this.items[i].entry);
    this.invalidate();
  }

  putBack() {
    if (this.s.picked < 0) return;
    this.setDetail(this.items[this.s.picked], LOW);
    Object.assign(this.s, { picked: -1, open: false, flipped: false, rotX: 0, rotY: 0 });
    this.cb.onPutBack();
    this.invalidate();
  }

  flip() {
    this.s.flipped = !this.s.flipped;
    if (this.s.flipped) this.s.open = false;
    this.s.rotX = this.s.rotY = 0;
    this.invalidate();
  }

  toggleRecord() {
    const it = this.items[this.s.picked];
    if (!it?.vinyl) return;
    this.s.open = !this.s.open;
    if (this.s.open) Object.assign(this.s, { flipped: false, rotX: 0, rotY: 0 });
    this.invalidate();
  }

  // ---------- building ----------

  private buildItem(d: ShelfItem, i: number): Item {
    const g = new THREE.Group();
    const e = d.entry;
    const edge = new THREE.MeshStandardMaterial({ color: e.current ? '#e6e5e2' : KRAFT, roughness: 0.9 });
    const front = new THREE.MeshStandardMaterial({ map: tex(frontCanvas(e, d.images, LOW)), roughness: 0.78 });
    const back = new THREE.MeshStandardMaterial({ map: tex(backCanvas(e, LOW)), roughness: 0.85 });
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(SIZE, SIZE, 0.045), [edge, edge, edge, edge, front, back]);
    sleeve.castShadow = true;
    g.add(sleeve);

    const st = stickerCanvas(e, d.images, LOW);
    const sticker = new THREE.Mesh(
      new THREE.PlaneGeometry(st.w, st.h),
      new THREE.MeshPhysicalMaterial({
        map: tex(st.canvas),
        transparent: true,
        alphaTest: 0.4,
        roughness: 0.28,
        clearcoat: 1,
        clearcoatRoughness: 0.15,
      }),
    );
    const r = rng(e.bottle.id + 's');
    sticker.position.set(0.38, -0.3, 0.026);
    sticker.rotation.z = (r() - 0.5) * 0.28;
    g.add(sticker);

    let vinyl: THREE.Mesh | null = null;
    let vinylMat: THREE.MeshPhysicalMaterial | null = null;
    if (e.current) {
      vinylMat = new THREE.MeshPhysicalMaterial({ map: tex(vinylCanvas(e, LOW)), roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.2 });
      const vg = new THREE.CylinderGeometry(0.94, 0.94, 0.012, 96);
      vg.rotateX(Math.PI / 2);
      vinyl = new THREE.Mesh(vg, [new THREE.MeshStandardMaterial({ color: '#0e0d10', roughness: 0.4 }), vinylMat, vinylMat]);
      vinyl.castShadow = true;
      g.add(vinyl);
    }

    g.userData.item = i;
    this.scene.add(g);
    return {
      ...d,
      group: g,
      front,
      back,
      sticker,
      vinyl,
      vinylMat,
      home: { pos: new THREE.Vector3(), quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.09, 0, 0)) },
      hover: 0,
      detail: LOW,
    };
  }

  /** Redraws the sleeve's textures at another size; the old ones leave video memory. */
  private setDetail(it: Item, size: number) {
    if (it.detail === size) return;
    it.detail = size;
    const swap = (m: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial, c: HTMLCanvasElement) => {
      m.map?.dispose();
      m.map = tex(c);
      m.needsUpdate = true;
    };
    swap(it.front, frontCanvas(it.entry, it.images, size));
    swap(it.back, backCanvas(it.entry, size));
    swap(it.sticker.material, stickerCanvas(it.entry, it.images, size).canvas);
    if (it.vinylMat) swap(it.vinylMat, vinylCanvas(it.entry, size));
  }

  private disposeItem(it: Item) {
    this.scene.remove(it.group);
    it.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.geometry.dispose();
      for (const m of [o.material].flat() as THREE.MeshStandardMaterial[]) {
        m.map?.dispose();
        m.dispose();
      }
    });
  }

  // ---------- layout and camera ----------

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
    this.layout();
  }

  private layout() {
    const w = this.host.clientWidth;
    this.cols = w < 560 ? 2 : w < 960 ? 3 : 4;
    const rows = Math.max(1, Math.ceil(this.items.length / this.cols));
    const t = 2 * Math.tan(THREE.MathUtils.degToRad(this.cam.fov / 2));
    const shelfW = this.cols * PITCH + 0.4;
    this.camZ = Math.max(shelfW / t / this.cam.aspect, (ROW_H * 1.25) / t);
    this.visibleH = this.camZ * t;
    // the sleeve in hand fills ~70% of the short side, with room for the record pulled out
    this.pickD = Math.max((SIZE + 1.3) / 0.86 / t / this.cam.aspect, SIZE / 0.62 / t);

    const rowY = (r: number) => -r * ROW_H;
    this.items.forEach((it, i) => {
      const row = Math.floor(i / this.cols), col = i % this.cols;
      // a row that is not full stands in the middle of its ledge
      const inRow = Math.min(this.cols, this.items.length - row * this.cols);
      it.home.pos.set((col - (inRow - 1) / 2) * PITCH, rowY(row) + SIZE / 2 - 0.02, 0.16);
    });

    for (const l of [...this.ledges.children]) {
      this.ledges.remove(l);
      (l as THREE.Mesh).geometry.dispose();
    }
    for (let r = 0; r < rows; r++) {
      const ledge = new THREE.Mesh(new THREE.BoxGeometry(shelfW, 0.12, 0.55), this.ledgeMat);
      ledge.position.set(0, rowY(r) - 0.06, 0.12);
      ledge.castShadow = ledge.receiveShadow = true;
      const lip = new THREE.Mesh(new THREE.BoxGeometry(shelfW, 0.22, 0.05), this.ledgeMat);
      lip.position.set(0, rowY(r) + 0.02, 0.4);
      lip.castShadow = true;
      this.ledges.add(ledge, lip);
    }

    const top = rowY(0) + SIZE + 0.5, bottom = rowY(rows - 1) - 0.6;
    const pad = 0.1 * this.visibleH;
    if (top - bottom + pad < this.visibleH) this.camYMin = this.camYMax = (top + bottom) / 2 - pad / 2;
    else {
      this.camYMax = top - this.visibleH / 2 + pad;
      this.camYMin = bottom + this.visibleH / 2;
    }
    if (!this.started) this.camY = this.camYMax;
    this.camY = THREE.MathUtils.clamp(this.camY, this.camYMin, this.camYMax);
    this.started = this.items.length > 0;
    this.invalidate();
  }
  private started = false;

  private scrollBy(world: number) {
    const y = THREE.MathUtils.clamp(this.camY + world, this.camYMin, this.camYMax);
    if (y !== this.camY) {
      this.camY = y;
      this.invalidate();
    }
  }

  // ---------- frames on demand ----------

  invalidate() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 1 / 60;
    const moving = this.step(dt);
    this.renderer.render(this.scene, this.cam);
    this.last = moving ? now : 0;
    if (moving) this.invalidate();
  };

  private tp = new THREE.Vector3();
  private tq = new THREE.Quaternion();
  private eu = new THREE.Euler();

  /** Moves everything one step toward where it should be; true while anything is still moving. */
  private step(dt: number): boolean {
    const reduce = this.reduce.matches;
    const k = 1 - Math.exp(-dt * (reduce ? 30 : 7));
    const kv = 1 - Math.exp(-dt * (reduce ? 30 : 5));
    let moving = false;
    const s = this.s;

    this.cam.position.set(0, this.camY, this.camZ);
    this.cam.lookAt(0, this.camY, 0);
    this.sun.target.position.set(0, this.camY - 0.3, 0);
    this.sun.position.set(3.5, this.camY + 5, 8);

    this.items.forEach((it, i) => {
      const held = s.picked === i;
      if (held) {
        this.tp.set(s.open && it.vinyl ? -0.6 : 0, this.camY, this.camZ - this.pickD);
        this.eu.set(s.rotX, s.rotY + (s.flipped ? Math.PI : 0), 0);
        this.tq.setFromEuler(this.eu);
      } else {
        const target = s.hover === i && s.picked < 0 ? 1 : 0;
        it.hover += (target - it.hover) * k;
        if (Math.abs(target - it.hover) > 1e-3) moving = true;
        this.tp.copy(it.home.pos);
        this.tp.z += it.hover * 0.35;
        this.tp.y += it.hover * 0.08;
        this.tq.copy(it.home.quat);
      }
      if (it.group.position.distanceToSquared(this.tp) > 1e-7 || it.group.quaternion.angleTo(this.tq) > 1e-4) moving = true;
      it.group.position.lerp(this.tp, k);
      it.group.quaternion.slerp(this.tq, k);
      if (it.vinyl) {
        const out = held && s.open ? 1.15 : 0;
        it.vinyl.position.x += (out - it.vinyl.position.x) * kv;
        if (Math.abs(out - it.vinyl.position.x) > 1e-3) moving = true;
        // the record turns while it is out: that is "playing"
        if (it.vinyl.position.x > 0.25 && !reduce) {
          it.vinyl.rotation.z -= dt * 3.5;
          moving = true;
        }
      }
    });

    this.dim.position.set(0, this.camY, this.camZ - this.pickD - 1.2);
    const dimTarget = s.picked >= 0 ? 0.7 : 0;
    this.dimMat.opacity += (dimTarget - this.dimMat.opacity) * k;
    this.dim.visible = this.dimMat.opacity > 0.002;
    if (Math.abs(dimTarget - this.dimMat.opacity) > 1e-3) moving = true;
    return moving;
  }

  // ---------- input ----------

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  private hitAt(e: { clientX: number; clientY: number }): number {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.cam);
    const groups = this.s.picked >= 0 ? [this.items[this.s.picked].group] : this.items.map((it) => it.group);
    let o: THREE.Object3D | null = this.ray.intersectObjects(groups, true)[0]?.object ?? null;
    while (o && o.userData.item === undefined) o = o.parent;
    return o ? (o.userData.item as number) : -1;
  }

  private bindInput() {
    const cv = this.canvas;
    cv.style.touchAction = 'none';
    let down: { x: number; y: number } | null = null;
    let last = { x: 0, y: 0 };
    let moved = false;

    cv.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
      last = { ...down };
      moved = false;
      cv.setPointerCapture(e.pointerId);
      if (this.s.picked >= 0 && this.hitAt(e) === this.s.picked) this.s.dragging = true;
    });
    cv.addEventListener('pointermove', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) moved = true;
      if (this.s.dragging) {
        this.s.rotY += (e.clientX - last.x) * 0.009;
        this.s.rotX = THREE.MathUtils.clamp(this.s.rotX + (e.clientY - last.y) * 0.009, -1.1, 1.1);
        this.invalidate();
      } else if (down && this.s.picked < 0) {
        this.scrollBy(((e.clientY - last.y) * this.visibleH) / cv.clientHeight);
      } else if (!down && this.s.picked < 0 && e.pointerType === 'mouse') {
        const h = this.hitAt(e);
        if (h !== this.s.hover) {
          this.s.hover = h;
          cv.style.cursor = h >= 0 ? 'pointer' : 'default';
          this.invalidate();
        }
      }
      last = { x: e.clientX, y: e.clientY };
    });
    cv.addEventListener('pointerup', (e) => {
      this.s.dragging = false;
      down = null;
      if (moved) return;
      const h = this.hitAt(e);
      if (this.s.picked < 0) {
        if (h >= 0) this.pick(h);
      } else if (h < 0) this.putBack();
    });
    cv.addEventListener('pointercancel', () => {
      this.s.dragging = false;
      down = null;
    });
    cv.addEventListener('pointerleave', () => {
      if (this.s.picked < 0 && this.s.hover >= 0) {
        this.s.hover = -1;
        this.invalidate();
      }
    });
    cv.addEventListener(
      'wheel',
      (e) => {
        if (this.s.picked >= 0) return;
        e.preventDefault();
        this.scrollBy((-e.deltaY * this.visibleH) / cv.clientHeight);
      },
      { passive: false },
    );
  }
}
