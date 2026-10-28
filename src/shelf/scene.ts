// The shelf of record sleeves (MVP doc §3). The wall and the shelf come from Blender with baked light
// (shelf/model.ts); sleeves stand where the file's empties stand, lit by the same studio HDRI the bake
// used. When there are more sleeves than places, the whole wall-and-shelf module repeats along the
// wall and the view pans. Frames are drawn only while something moves, textures are small on the
// shelf and large only for the sleeve in hand.
import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type { ShelfEntry } from '../data/model';
import { loadShelfModel, type ShelfModel } from './model';
import { createWaterVeil } from './water';
import { backCanvas, frontCanvas, KRAFT, rng, stickerCanvas, vinylCanvas, type SleeveImages } from './textures';

/** Sleeve geometry is built at this size and scaled to the size of the places in the model. */
const SIZE = 2;
const LOW = 512;
const HIGH = 1024;
/** Layer of the front pass: the sleeve in hand and the water behind it. */
const FRONT = 1;

/** How the camera looks at the shelf. Tuned by eye; change freely. */
const VIEW = {
  /** 0: straight at the sleeve fronts, 1: straight at the wall. */
  towardWall: 0.35,
  /** Degrees above the shelf. */
  pitch: 8,
  fov: 32,
  /** At most this share of the screen's width goes to the shelf (what limits a narrow window)… */
  fill: 0.72,
  /** …and at most this share of its height (what limits a wide one). */
  fillHeight: 0.33,
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

/**
 * The sleeve in hand floats as if weightless: it sways slowly around three axes and bobs a little.
 * Angles in degrees, bob as a share of the sleeve's height; each sway has its own period (7–13 s,
 * set in `step`). `ease`: how fast the float comes in and rests (per second).
 */
const FLOAT = { yaw: 4, pitch: 2.5, roll: 1.2, bob: 0.015, ease: 1.2 };

/**
 * Pulling the record out by hand. `edge`: the right part of the sleeve that starts the gesture
 * (0 = middle, 1 = edge; 0 gives the whole right half). `travel`: how far the hand moves for the full
 * way, as a share of the sleeve's width on screen. `snap`: let go past this share of the way and
 * it completes, short of it it goes back.
 */
const PULL = { edge: 0, travel: 0.6, snap: 0.33 };

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
  /** Drawn in the front pass, over the shelf: while in hand and on its way back. */
  onTop: boolean;
  /** Texture size it should have, and the parts still drawn at the other size. */
  want: number;
  pending: Part[];
}

type Part = 'front' | 'back' | 'sticker' | 'vinyl';

export interface ShelfCallbacks {
  onPick(entry: ShelfEntry): void;
  onPutBack(): void;
  /** The record went in or out by hand (the pull gesture), not through `toggleRecord`. */
  onChange?(): void;
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
  /** Backdrop behind the sleeve in hand: moving water (shelf/water.ts). */
  private veil = createWaterVeil();
  private sun = new THREE.DirectionalLight(0xffffff, 1.2);
  private fill = new THREE.DirectionalLight(0xffffff, 0);
  private s = {
    picked: -1,
    flipped: false,
    open: false,
    rotX: 0,
    rotY: 0,
    hover: -1,
    dragging: false,
    /** The record being pulled by hand: openness when the gesture began, now, and where it began. */
    pull: null as null | { from: number; amt: number; x0: number },
  };
  /** How far the record of the sleeve in hand is out, 0..1, eased toward its target. */
  private openNow = 0;
  /** Width of the sleeve in hand on screen, in CSS pixels: the scale of the pull gesture. */
  private sleevePx = 300;
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
    this.scene.add(sun, sun.target, this.fill, this.fill.target, this.modules, this.veil.mesh);
    // lights shine on both passes; the water lives in the front one with the sleeve in hand
    sun.layers.enableAll();
    this.fill.layers.enableAll();
    this.veil.mesh.layers.set(FRONT);
    this.ray.layers.enableAll();

    this.applyTheme();
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(host);
    this.reduce.addEventListener('change', () => this.invalidate());
    void this.load();
  }

  /** Moves a sleeve into the front pass (over everything) or back into the shelf's. */
  private setFront(it: Item, on: boolean) {
    if (it.onTop === on) return;
    it.onTop = on;
    it.group.traverse((o) => o.layers.set(on ? FRONT : 0));
  }

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
    if (this.s.picked >= 0) {
      this.requestDetail(this.items[this.s.picked], HIGH);
      this.setFront(this.items[this.s.picked], true);
    }
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
    // both passes, so the water's shader is ready too
    this.cam.layers.enableAll();
    void this.renderer.compileAsync(this.scene, this.cam).then(() => this.invalidate());
    this.cam.layers.set(0);
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
    const night = document.documentElement.dataset.theme === 'dark';
    this.veil.setTheme(css('--paper') || '#efeeec', css('--ink') || '#1f1e21', night);
    this.invalidate();
  }

  pick(i: number) {
    if (i < 0 || i >= this.items.length) return;
    if (this.s.picked >= 0 && this.s.picked !== i) this.requestDetail(this.items[this.s.picked], LOW);
    Object.assign(this.s, { picked: i, flipped: false, open: false, rotX: 0, rotY: 0, hover: -1, pull: null });
    this.openNow = 0;
    this.requestDetail(this.items[i], HIGH);
    this.setFront(this.items[i], true);
    this.cb.onPick(this.items[i].entry);
    this.invalidate();
  }

  putBack() {
    if (this.s.picked < 0) return;
    this.requestDetail(this.items[this.s.picked], LOW);
    Object.assign(this.s, { picked: -1, open: false, flipped: false, rotX: 0, rotY: 0, pull: null });
    this.canvas.style.cursor = 'default';
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
      onTop: false,
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
    const px = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.veil.setResolution(px.x, px.y);
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
    this.dist = Math.max(contentW / VIEW.fill / (t * this.cam.aspect), contentH / VIEW.fillHeight / t);
    this.visibleW = this.dist * t * this.cam.aspect;
    this.panMax = (count - 1) * m.width;
    this.pan = THREE.MathUtils.clamp(this.pan, 0, this.panMax);

    // the sleeve in hand fills ~70% of the short side, with room for the record pulled out
    const S = SIZE * this.k;
    this.pickD = Math.max((S + 1.3 * this.k) / 0.86 / t / this.cam.aspect, S / 0.62 / t);
    this.sleevePx = (S / (this.pickD * t)) * this.host.clientHeight;
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
    // Two passes: the shelf, then — over it, with depth cleared — the water and the sleeve in hand,
    // so nothing on the shelf can cut into them however close the camera stands.
    const r = this.renderer;
    this.cam.layers.set(0);
    r.render(this.scene, this.cam);
    if (this.veil.opacity > 0 || this.items.some((it) => it.onTop)) {
      r.autoClear = false;
      r.clearDepth();
      this.cam.layers.set(FRONT);
      r.render(this.scene, this.cam);
      this.cam.layers.set(0);
      r.autoClear = true;
    }
    this.last = moving ? now : 0;
    if (moving) this.invalidate();
  };

  private tp = new THREE.Vector3();
  private tq = new THREE.Quaternion();
  private eu = new THREE.Euler();
  private camRight = new THREE.Vector3();
  private camFwd = new THREE.Vector3();
  private camUp = new THREE.Vector3();
  private q1 = new THREE.Quaternion();
  /** 0..1: how much of FLOAT the sleeve in hand shows, and its clock in seconds. */
  private floatAmt = 0;
  private floatT = 0;

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

    // the float of the sleeve in hand: comes in once it has arrived, rests while it is being turned
    this.camUp.setFromMatrixColumn(this.cam.matrixWorld, 1);
    const heldNow = s.picked >= 0 ? this.items[s.picked] : null;
    const floatTarget = heldNow?.inHand && !s.dragging && !s.pull && !reduce ? 1 : 0;

    // the record: follows the hand while pulled, eases to in or out otherwise
    const openTarget = s.pull ? s.pull.amt : s.open ? 1 : 0;
    this.openNow += (openTarget - this.openNow) * (s.pull ? 1 - Math.exp(-dt * 30) : kv);
    if (Math.abs(openTarget - this.openNow) > 1e-3) moving = true;
    else this.openNow = openTarget;
    this.floatAmt += (floatTarget - this.floatAmt) * (1 - Math.exp(-dt * FLOAT.ease));
    if (this.floatAmt > 1e-3 || floatTarget) {
      this.floatT += dt;
      moving = true;
    } else this.floatAmt = 0;

    let heldArrived = false;
    let swapped = false;
    this.items.forEach((it, i) => {
      const held = s.picked === i;
      if (held) {
        this.tp.copy(this.cam.position).addScaledVector(this.camFwd, this.pickD);
        if (it.vinyl) this.tp.addScaledVector(this.camRight, -0.6 * this.k * this.openNow);
        this.eu.set(s.rotX, s.rotY + (s.flipped ? Math.PI : 0), 0);
        this.tq.copy(this.cam.quaternion).multiply(this.q1.setFromEuler(this.eu));
        const f = this.floatAmt;
        if (f > 0) {
          // three slow sways with periods that never line up, so it does not look like a loop
          const t = this.floatT * Math.PI * 2, deg = THREE.MathUtils.degToRad;
          this.eu.set(
            deg(FLOAT.pitch) * Math.sin(t / 13 + 1) * f,
            deg(FLOAT.yaw) * Math.sin(t / 9) * f,
            deg(FLOAT.roll) * Math.sin(t / 11 + 2) * f,
          );
          this.tq.multiply(this.q1.setFromEuler(this.eu));
          this.tp.addScaledVector(this.camUp, FLOAT.bob * SIZE * this.k * Math.sin(t / 7 + 0.5) * f);
        }
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
      // back in its place: it rejoins the shelf's pass, behind its neighbours again
      if (it.onTop && !held && it.group.position.distanceTo(it.home.pos) < 0.02 * SIZE * this.k) this.setFront(it, false);
      if (it.vinyl) {
        // in hand the record goes exactly as far as openNow says; elsewhere it slides back in
        const out = held ? 1.15 * this.openNow : 0;
        it.vinyl.position.x += (out - it.vinyl.position.x) * (held ? 1 : kv);
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

    // the water hangs just behind the sleeve in hand, facing the camera
    // (always in the scene, never hidden: its shader is compiled up front, see warmUp)
    const veil = this.veil;
    veil.mesh.position.copy(this.cam.position).addScaledVector(this.camFwd, this.pickD + SIZE * this.k);
    veil.mesh.quaternion.copy(this.cam.quaternion);
    const veilTarget = s.picked >= 0 ? 1 : 0;
    veil.opacity += (veilTarget - veil.opacity) * k;
    if (Math.abs(veilTarget - veil.opacity) > 1e-3) moving = true;
    else veil.opacity = veilTarget;
    // the water keeps moving while it is shown (still, if motion is reduced)
    if (veil.opacity > 0 && !reduce) {
      veil.advance(dt);
      moving = true;
    }
    return moving;
  }

  // ---------- input ----------

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  private hitAt(e: { clientX: number; clientY: number }): number {
    return this.hit(e)?.index ?? -1;
  }

  /** The sleeve under the pointer and the point on it, in the sleeve's own units (±1 across). */
  private hit(e: { clientX: number; clientY: number }): { index: number; local: THREE.Vector3 } | null {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.cam);
    const groups = this.s.picked >= 0 ? [this.items[this.s.picked].group] : this.items.map((it) => it.group);
    const h = this.ray.intersectObjects(groups, true)[0];
    let o: THREE.Object3D | null = h?.object ?? null;
    while (o && o.userData.item === undefined) o = o.parent;
    if (!o || !h) return null;
    return { index: o.userData.item as number, local: o.worldToLocal(h.point.clone()) };
  }

  /**
   * Whether a press on the sleeve in hand starts the pull gesture: on its right part (PULL.edge),
   * or on the record itself, which lies further right still. Pull left to bring the record out,
   * right to put it back; the left part turns the sleeve either way. Only face up, with a record.
   */
  private startsPull(local: THREE.Vector3): boolean {
    const it = this.items[this.s.picked];
    if (!it?.vinyl || this.s.flipped) return false;
    return local.x > PULL.edge * (SIZE / 2);
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
      const h = this.s.picked >= 0 ? this.hit(e) : null;
      if (h && h.index === this.s.picked) {
        if (this.startsPull(h.local)) {
          const from = this.s.open ? 1 : 0;
          this.s.pull = { from, amt: from, x0: e.clientX };
        } else this.s.dragging = true;
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) moved = true;
      const pull = this.s.pull;
      if (pull) {
        // the sleeve follows the hand: pulling left brings the record out, right puts it back
        const travel = Math.max(40, this.sleevePx * PULL.travel);
        pull.amt = THREE.MathUtils.clamp(pull.from + (pull.x0 - e.clientX) / travel, 0, 1);
        this.invalidate();
      } else if (this.s.dragging) {
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
      } else if (!down && this.s.picked >= 0 && e.pointerType === 'mouse') {
        // in hand: the edge that pulls shows a sideways cursor, the rest of the sleeve a grab
        const h = this.hit(e);
        cv.style.cursor = h?.index !== this.s.picked ? 'default' : this.startsPull(h.local) ? 'ew-resize' : 'grab';
      }
      last = { x: e.clientX, y: e.clientY };
    });
    cv.addEventListener('pointerup', (e) => {
      this.s.dragging = false;
      down = null;
      const pull = this.s.pull;
      if (pull) {
        // let go: past PULL.snap of the way it completes, short of it it goes back
        this.s.pull = null;
        const open = pull.from === 0 ? pull.amt > PULL.snap : pull.amt > 1 - PULL.snap;
        if (open !== this.s.open) {
          this.s.open = open;
          this.cb.onChange?.();
        }
        this.invalidate();
      }
      if (moved) return;
      const h = this.hitAt(e);
      if (this.s.picked < 0) {
        if (h >= 0) this.pick(h);
      } else if (h < 0) this.putBack();
    });
    cv.addEventListener('pointercancel', () => {
      this.s.dragging = false;
      this.s.pull = null;
      down = null;
      this.invalidate();
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
