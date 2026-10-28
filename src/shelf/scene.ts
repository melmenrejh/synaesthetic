// The shelf of record sleeves (MVP doc §3). The wall and the shelf come from Blender with baked light
// (shelf/model.ts); sleeves stand where the file's empties stand, lit by the same studio HDRI the bake
// used. When there are more sleeves than places, the whole wall-and-shelf module repeats along the
// wall and the view pans. Frames are drawn only while something moves, textures are small on the
// shelf and large only for the sleeve in hand.
import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type { ShelfEntry } from '../data/model';
import { loadShelfModel, type ShelfModel } from './model';
import { backCanvas, frontCanvas, KRAFT, rng, stickerCanvas, vinylCanvas, type SleeveImages } from './textures';

/** Sleeve geometry is built at this size and scaled to the size of the places in the model. */
const SIZE = 2;
const LOW = 512;
const HIGH = 1024;

/** How the camera looks at the shelf. Tuned by eye; change freely. */
const VIEW = {
  /** 0: straight at the sleeve fronts, 1: straight at the wall. */
  towardWall: 0.35,
  /** Degrees above the shelf. */
  pitch: 8,
  fov: 32,
  /** Share of the screen the shelf and its sleeves take. */
  fill: 0.72,
};

/**
 * Light for the sleeve in hand: it turns its face to the viewer, where the studio is dark, so it
 * is brought "to the light": a soft light from the viewer's side fades in, and the studio's
 * reflected light on the sleeve grows. Both fade back when it returns to the shelf.
 */
const HELD_LIGHT = {
  /** Intensity of the light from the viewer's side. */
  fill: 1.8,
  /** Studio light on the sleeve in hand, as a multiple of the shelf's. */
  env: 1.8,
};

/** How far a hovered sleeve rises, as a share of its height. */
const HOVER_LIFT = 0.5;

/** The studio the bake was lit with; the sleeves get the same light. */
const ENV_URL = '/env/wooden_studio_08_1k.hdr';
const MODEL_URL = '/models/shelf.glb';

export interface ShelfItem {
  entry: ShelfEntry;
  images: SleeveImages;
}

interface Item extends ShelfItem {
  group: THREE.Group;
  front: THREE.MeshStandardMaterial;
  back: THREE.MeshStandardMaterial;
  sticker: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial> | null;
  vinyl: THREE.Mesh | null;
  vinylMat: THREE.MeshPhysicalMaterial | null;
  home: { pos: THREE.Vector3; quat: THREE.Quaternion };
  /** Every lit material of the sleeve, for the held-light boost. */
  mats: THREE.MeshStandardMaterial[];
  hover: number;
  /** 0 on the shelf, 1 in hand: how much of HELD_LIGHT it gets. */
  glow: number;
  /** Has reached the hand since it was picked. */
  inHand: boolean;
  /** Texture size it should have, and the parts still drawn at the other size. */
  want: number;
  pending: Part[];
}

type Part = 'front' | 'back' | 'sticker' | 'vinyl';

export interface ShelfCallbacks {
  onPick(entry: ShelfEntry): void;
  onPutBack(): void;
  /** The model could not be loaded. */
  onError?(e: unknown): void;
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
  private cam = new THREE.PerspectiveCamera(VIEW.fov, 1, 0.05, 100);
  private items: Item[] = [];
  private model: ShelfModel | null = null;
  private modules = new THREE.Group();
  private dimMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  private dim = new THREE.Mesh(new THREE.PlaneGeometry(80, 60), this.dimMat);
  private sun = new THREE.DirectionalLight(0xffffff, 1.2);
  private fill = new THREE.DirectionalLight(0xffffff, 0);
  private s = { picked: -1, flipped: false, open: false, rotX: 0, rotY: 0, hover: -1, dragging: false };
  /** Sleeve scale: the model's place size over SIZE. */
  private k = 0.4;
  private target = new THREE.Vector3();
  private dir = new THREE.Vector3(0, 0, 1);
  private dist = 5;
  private pan = 0;
  private panMax = 0;
  private pickD = 2;
  private visibleW = 1;
  private raf = 0;
  private last = 0;
  private reduce = matchMedia('(prefers-reduced-motion: reduce)');

  constructor(
    private host: HTMLElement,
    private cb: ShelfCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    host.prepend(this.canvas);

    // Soft key light from the studio ceiling on the sleeves. Sleeves cast no shadows: the shelf's
    // shadow is baked, and a live one would never match it.
    const sun = this.sun;
    this.scene.add(sun, sun.target, this.fill, this.fill.target, this.modules, this.dim);
    this.dim.renderOrder = 1;

    this.applyTheme();
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(host);
    this.reduce.addEventListener('change', () => this.invalidate());
    void this.load();  }

  private async load() {
    try {
      const [model, env] = await Promise.all([loadShelfModel(MODEL_URL), new RGBELoader().loadAsync(ENV_URL)]);
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      env.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.environment = pmrem.fromEquirectangular(env).texture;
      env.dispose();
      pmrem.dispose();
      this.model = model;
      this.k = model.slots[0].size / SIZE;
      this.scene.background = model.wallColor;
      this.layout();
      this.snapHome();
      this.warmUp();
    } catch (e) {
      console.error(e);
      this.cb.onError?.(e);
    }
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
    if (this.s.picked >= 0) this.requestDetail(this.items[this.s.picked], HIGH);
    this.layout();
    this.snapHome();
    if (this.model) this.warmUp();
  }

  /**
   * Compiles every shader now, while nothing moves. A material drawn for the first time compiles
   * on the spot, and that stalls the frame for 100+ ms: at the moment of a click it looks like
   * the light blinking.
   */
  private warmUp() {
    this.step(0);
    void this.renderer.compileAsync(this.scene, this.cam).then(() => this.invalidate());
  }

  /** Fresh meshes start where they live, not in the middle of the scene. */
  private snapHome() {
    for (const it of this.items) {
      it.group.position.copy(it.home.pos);
      it.group.quaternion.copy(it.home.quat);
    }
    this.invalidate();
  }

  applyTheme() {
    // The wall's light is baked, so only what lies over it follows the theme.
    this.dimMat.color.set(css('--paper') || '#efeeec');
    this.invalidate();
  }

  pick(i: number) {
    if (i < 0 || i >= this.items.length) return;
    if (this.s.picked >= 0 && this.s.picked !== i) this.requestDetail(this.items[this.s.picked], LOW);
    Object.assign(this.s, { picked: i, flipped: false, open: false, rotX: 0, rotY: 0, hover: -1 });
    this.requestDetail(this.items[i], HIGH);
    this.cb.onPick(this.items[i].entry);
    this.invalidate();
  }

  putBack() {
    if (this.s.picked < 0) return;
    this.requestDetail(this.items[this.s.picked], LOW);
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
    g.add(sleeve);

    // no photo of the bottle: the cover stays clean
    const st = stickerCanvas(e, d.images, LOW);
    let sticker: Item['sticker'] = null;
    if (st) {
      sticker = new THREE.Mesh(
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
    }

    let vinyl: THREE.Mesh | null = null;
    let vinylMat: THREE.MeshPhysicalMaterial | null = null;
    if (e.current) {
      vinylMat = new THREE.MeshPhysicalMaterial({ map: tex(vinylCanvas(e, LOW)), roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.2 });
      const vg = new THREE.CylinderGeometry(0.94, 0.94, 0.012, 96);
      vg.rotateX(Math.PI / 2);
      vinyl = new THREE.Mesh(vg, [new THREE.MeshStandardMaterial({ color: '#0e0d10', roughness: 0.4 }), vinylMat, vinylMat]);
      g.add(vinyl);
    }

    g.scale.setScalar(this.k);
    g.userData.item = i;
    this.scene.add(g);
    const mats: THREE.MeshStandardMaterial[] = [];
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) for (const m of [o.material].flat()) if (!mats.includes(m)) mats.push(m);
    });
    return {
      ...d,
      group: g,
      front,
      back,
      sticker,
      vinyl,
      vinylMat,
      home: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
      mats,
      hover: 0,
      glow: 0,
      inHand: false,
      want: LOW,
      pending: [],
    };
  }

  /**
   * Asks for the sleeve's textures at another size. They are not swapped here: drawing and
   * uploading four large textures at once holds the GPU for ~100 ms, which shows as a blink at the
   * moment of a click. `step` swaps them one part per frame, once the sleeve has settled.
   */
  private requestDetail(it: Item, size: number) {
    if (it.want === size) return;
    it.want = size;
    it.pending = ['front', 'sticker', 'vinyl', 'back'];
    this.invalidate();
  }

  /** Redraws one part of the sleeve at the wanted size; the old texture leaves video memory. */
  private swapPart(it: Item) {
    const part = it.pending.shift();
    if (!part) return;
    const size = it.want;
    let mat: THREE.MeshStandardMaterial | null = null;
    let canvas: HTMLCanvasElement | null = null;
    if (part === 'front') (mat = it.front), (canvas = frontCanvas(it.entry, it.images, size));
    else if (part === 'back') (mat = it.back), (canvas = backCanvas(it.entry, size));
    else if (part === 'vinyl' && it.vinylMat) (mat = it.vinylMat), (canvas = vinylCanvas(it.entry, size));
    else if (part === 'sticker' && it.sticker) (mat = it.sticker.material), (canvas = stickerCanvas(it.entry, it.images, size)?.canvas ?? null);
    if (!mat || !canvas) return;
    const t = tex(canvas);
    // upload before it is shown, so the swap itself costs nothing to draw
    this.renderer.initTexture(t);
    const old = mat.map;
    mat.map = t;
    old?.dispose();
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
    const m = this.model;
    if (!m) return;
    const per = m.slots.length;
    const count = Math.max(1, Math.ceil(this.items.length / per));

    // one wall-and-shelf module per `per` sleeves, side by side along the wall
    while (this.modules.children.length < count) {
      const clone = this.modules.children.length ? m.root.clone() : m.root;
      clone.position.copy(m.along).multiplyScalar(m.width * this.modules.children.length);
      this.modules.add(clone);
    }
    while (this.modules.children.length > count) this.modules.remove(this.modules.children[this.modules.children.length - 1]);

    this.items.forEach((it, i) => {
      const slot = m.slots[i % per];
      const offset = m.along.clone().multiplyScalar(m.width * Math.floor(i / per));
      it.home.pos.copy(slot.pos).add(offset);
      it.home.quat.copy(slot.quat);
      it.group.scale.setScalar(this.k);
    });

    // camera: between the sleeves' faces and the wall, a little from above
    // the average way the places face: they may fan out along the shelf
    const normal = m.slots.reduce((sum, s) => sum.add(s.normal), new THREE.Vector3()).normalize();
    const flat = normal.lerp(m.wallNormal, VIEW.towardWall).normalize();
    const pitch = THREE.MathUtils.degToRad(VIEW.pitch);
    this.dir.copy(flat).multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch)).normalize();
    const slotTop = Math.max(...m.slots.map((s) => s.pos.y + s.size / 2));
    const box = m.shelfBox;
    this.target.set(0, 0, 0);
    for (const s of m.slots) this.target.add(s.pos);
    this.target.divideScalar(per);
    this.target.y = (box.min.y + slotTop) / 2;
    const size = box.getSize(new THREE.Vector3());
    const contentW = Math.max(size.x, size.z);
    const contentH = slotTop - box.min.y;
    const t = 2 * Math.tan(THREE.MathUtils.degToRad(this.cam.fov / 2));
    this.dist = Math.max(contentW / VIEW.fill / (t * this.cam.aspect), contentH / VIEW.fill / t);
    this.visibleW = this.dist * t * this.cam.aspect;
    this.panMax = (count - 1) * m.width;
    this.pan = THREE.MathUtils.clamp(this.pan, 0, this.panMax);

    // the sleeve in hand fills ~70% of the short side, with room for the record pulled out
    const S = SIZE * this.k;
    this.pickD = Math.max((S + 1.3 * this.k) / 0.86 / t / this.cam.aspect, S / 0.62 / t);
    this.invalidate();
  }

  private panBy(world: number) {
    const p = THREE.MathUtils.clamp(this.pan + world, 0, this.panMax);
    if (p !== this.pan) {
      this.pan = p;
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
  private camRight = new THREE.Vector3();
  private camFwd = new THREE.Vector3();

  /** Moves everything one step toward where it should be; true while anything is still moving. */
  private step(dt: number): boolean {
    const reduce = this.reduce.matches;
    const k = 1 - Math.exp(-dt * (reduce ? 30 : 7));
    const kv = 1 - Math.exp(-dt * (reduce ? 30 : 5));
    let moving = false;
    const s = this.s;
    const m = this.model;

    const look = this.target.clone();
    if (m) look.addScaledVector(m.along, this.pan);
    this.cam.position.copy(look).addScaledVector(this.dir, this.dist);
    this.cam.lookAt(look);
    this.cam.updateMatrixWorld();
    this.cam.getWorldDirection(this.camFwd);
    this.camRight.setFromMatrixColumn(this.cam.matrixWorld, 0);
    this.sun.target.position.copy(look);
    if (m) this.sun.position.copy(look).addScaledVector(m.wallNormal, 2).add(new THREE.Vector3(0, 4, 0)).addScaledVector(m.along, -1);

    let heldArrived = false;
    let swapped = false;
    this.items.forEach((it, i) => {
      const held = s.picked === i;
      if (held) {
        this.tp.copy(this.cam.position).addScaledVector(this.camFwd, this.pickD);
        if (s.open && it.vinyl) this.tp.addScaledVector(this.camRight, -0.6 * this.k);
        this.eu.set(s.rotX, s.rotY + (s.flipped ? Math.PI : 0), 0);
        this.tq.copy(this.cam.quaternion).multiply(new THREE.Quaternion().setFromEuler(this.eu));
      } else {
        const target = s.hover === i && s.picked < 0 ? 1 : 0;
        it.hover += (target - it.hover) * k;
        if (Math.abs(target - it.hover) > 1e-3) moving = true;
        // a hovered sleeve rises straight up out of the row, by HOVER_LIFT of its height, so it
        // never passes through the sleeve standing in front of it
        this.tp.copy(it.home.pos);
        this.tp.y += it.hover * HOVER_LIFT * SIZE * this.k;
        this.tq.copy(it.home.quat);
      }
      if (it.group.position.distanceToSquared(this.tp) > 1e-8 || it.group.quaternion.angleTo(this.tq) > 1e-4) moving = true;
      it.group.position.lerp(this.tp, k);
      it.group.quaternion.slerp(this.tq, k);
      // the light comes up only once the sleeve has reached the hand (and stays while it is turned
      // or the record slides out), and leaves as soon as it goes back
      if (!held) it.inHand = false;
      else if (it.group.position.distanceTo(this.tp) < 0.05 * SIZE * this.k) it.inHand = true;
      if (held) heldArrived = it.inHand;
      const glow = it.inHand ? 1 : 0;
      if (Math.abs(glow - it.glow) > 1e-3) {
        it.glow += (glow - it.glow) * k;
        for (const mat of it.mats) mat.envMapIntensity = 1 + (HELD_LIGHT.env - 1) * it.glow;
        moving = true;
      }
      // textures change size only when the sleeve is still: large once in hand, small once home;
      // one part per frame across the whole shelf
      if (it.pending.length) {
        const settled =
          it.want === HIGH ? it.inHand : !held && it.group.position.distanceTo(it.home.pos) < 0.02 * SIZE * this.k;
        if (settled && !swapped) {
          this.swapPart(it);
          swapped = true;
        }
        moving = true;
      }
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

    // the light from the viewer's side, a little above the eyes, aimed at the sleeve in hand
    // (it stays in the scene at zero instead of being hidden: adding or removing a light recompiles
    // every material, and the whole scene blinks)
    const heldItem = s.picked >= 0 ? this.items[s.picked] : null;
    const fillTarget = heldArrived ? HELD_LIGHT.fill : 0;
    this.fill.intensity += (fillTarget - this.fill.intensity) * k;
    if (Math.abs(fillTarget - this.fill.intensity) > 1e-3) moving = true;
    else this.fill.intensity = fillTarget;
    this.fill.position.copy(this.cam.position).add(new THREE.Vector3(0, SIZE * this.k, 0));
    this.fill.target.position.copy(heldItem ? heldItem.group.position : look);

    // the veil hangs just behind the sleeve in hand, facing the camera
    this.dim.position.copy(this.cam.position).addScaledVector(this.camFwd, this.pickD + SIZE * this.k);
    this.dim.quaternion.copy(this.cam.quaternion);
    // (always in the scene, never hidden: its shader is compiled up front, see warmUp)
    const dimTarget = s.picked >= 0 ? 0.7 : 0;
    this.dimMat.opacity += (dimTarget - this.dimMat.opacity) * k;
    if (Math.abs(dimTarget - this.dimMat.opacity) > 1e-3) moving = true;
    else this.dimMat.opacity = dimTarget;
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
        // dragging the wall slides along it, to the next shelves
        this.panBy((-(e.clientX - last.x) * this.visibleW) / cv.clientWidth);
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
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.panBy((d * this.visibleW) / cv.clientWidth);
      },
      { passive: false },
    );
  }
}
