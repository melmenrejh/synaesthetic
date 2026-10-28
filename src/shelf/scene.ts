// The shelf of record sleeves (MVP doc §3). The wall and the shelf come from Blender with baked light
// (shelf/model.ts); sleeves stand where the file's empties stand, lit by the same studio HDRI the bake
// used. When there are more sleeves than places, the whole wall-and-shelf module repeats along the
// wall and the view pans. Frames are drawn only while something moves, textures are small on the
// shelf and large only for the sleeve in hand.
import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type { ShelfEntry } from '../data/model';
import { loadShelfModel, type ShelfModel } from './model';
import { loadRecordModel, type RecordModel } from './record';
import { coverColours } from '../images/process';
import { createWaterVeil, WATER } from './water';
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

/**
 * A deleted sleeve falls out of the hand: seconds to leave the screen, and how much it tumbles
 * (rad/s). It falls against the water; once it is gone the water fades as usual and the shelf
 * develops out of blur (design system: blur-reveal, duration-reveal, ease-develop).
 */
const DROP = { seconds: 1.1, tumble: 0.7 };

/**
 * How far a hovered sleeve rises, as a share of its height: `front` for the one nearest the viewer,
 * `back` for the furthest one standing in its module, in between for the rest. The front one barely
 * moves, so it does not slip from under the pointer onto the sleeve behind it.
 */
const HOVER_LIFT = { front: 0.1, back: 0.5 };

/**
 * Paging between shelves. `peek`: how far the first gesture leans the view toward the next shelf
 * (a share of the view's width); `peekSeconds`: how long it waits for the second (then leans back, the
 * hint's own 4 s); `travelSeconds` / `leanSeconds`: how long the view takes to another shelf / to
 * lean. A swipe counts past `swipePx`, a scroll past `wheelPx` of movement, and the next scroll only
 * after `wheelPauseMs` of quiet.
 */
const PAGING = { peek: 0.12, peekSeconds: 4, travelSeconds: 1.2, leanSeconds: 0.8, swipePx: 40, wheelPx: 40, wheelPauseMs: 350 };

/**
 * The design system's ease-settle, cubic-bezier(0.65, 0, 0.35, 1): for things that move from one
 * place to another. x and y of the curve are solved by bisection (it is monotonic).
 */
function easeSettle(x: number) {
  const bez = (t: number, a: number, b: number) => 3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 20; i++) {
    t = (lo + hi) / 2;
    if (bez(t, 0.65, 0.35) < x) lo = t;
    else hi = t;
  }
  return bez(t, 0, 1);
}

/** The studio the bake was lit with; the sleeves get the same light. */
const ENV_URL = '/env/wooden_studio_08_1k.hdr';
const MODEL_URL = '/models/shelf.glb';
/** "12" Vinyl Record" by AleixoAlonso, CC BY 4.0 (credited on the page and in README). */
const RECORD_URL = '/models/vinyl/scene.gltf';
/** Radius of the record in sleeve units (the sleeve spans ±1). */
const RECORD_R = 0.94;

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
  vinylMat: THREE.MeshStandardMaterial | null;
  home: { pos: THREE.Vector3; quat: THREE.Quaternion };
  /** Every lit material of the sleeve, for the held-light boost. */
  mats: THREE.MeshStandardMaterial[];
  hover: number;
  /** How far it rises when hovered, as a share of its height (set by its place: see HOVER_LIFT). */
  lift: number;
  /** 0 on the shelf, 1 in hand: how much of HELD_LIGHT it gets. */
  glow: number;
  /** The water's colours from its cover (undefined: not worked out yet, null: no cover). */
  tint?: { water: string; highlight: string } | null;
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
  /** The view leans toward the next (1) or previous (−1) shelf, waiting for a second gesture; 0: no longer. */
  onPeek?(dir: -1 | 0 | 1): void;
  /** The wall has loaded: what lies on it can take its tone (`wallTone`). */
  onWall?(): void;
  /** The model could not be loaded. */
  onError?(e: unknown): void;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const WHITE = new THREE.Color('#ffffff');
/** The design system's ink in the day and night themes: the two text colours to choose from. */
const INK_DARK = '#1f1e21';
const INK_LIGHT = '#e9e8e6';

/** WCAG relative luminance of a hex colour. */
function luminance(hex: string) {
  const c = new THREE.Color(hex); // linear already
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** 'dark' (light text) or 'light' (dark text) on a background: the ink with more contrast wins. */
function toneFor(background: string): 'light' | 'dark' {
  const l = luminance(background);
  const onDark = (luminance(INK_LIGHT) + 0.05) / (l + 0.05);
  const onLight = (l + 0.05) / (luminance(INK_DARK) + 0.05);
  return onDark >= onLight ? 'dark' : 'light';
}

/** `flipY: false` for textures on glTF models, whose UVs read images top down. */
function tex(c: HTMLCanvasElement, flipY = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.flipY = flipY;
  return t;
}

export class Shelf {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(VIEW.fov, 1, 0.05, 100);
  private items: Item[] = [];
  private model: ShelfModel | null = null;
  private record: RecordModel | null = null;
  private modules = new THREE.Group();
  /** Backdrop behind the sleeve in hand: moving water (shelf/water.ts). */
  private veil = createWaterVeil();
  private sun = new THREE.DirectionalLight(0xffffff, 1.2);
  private fill = new THREE.DirectionalLight(0xffffff, 0);
  private s = {
    picked: -1,
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
  /** 2·tan(fov/2): the view's height per unit of distance from the camera. */
  private viewT = 0.57;
  /** Sleeve scale: the model's place size over SIZE. */
  private k = 0.4;
  private target = new THREE.Vector3();
  private dir = new THREE.Vector3(0, 0, 1);
  private dist = 5;
  /** How far along the wall the view is now, and its journey toward page and peek. */
  private pan = 0;
  private panTween = { from: 0, to: 0, t: 0, dur: 1 };
  /** The shelf in view (one module per `slots.length` sleeves), how many there are, and the lean. */
  private page = 0;
  private pages = 1;
  private peek: -1 | 0 | 1 = 0;
  private peekTimer = 0;
  private pickD = 2;
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
    // the baked shelf throws a live shadow onto a lit wall (shelf/model.ts)
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    host.prepend(this.canvas);

    // Soft key light from the studio ceiling, on the sleeves and the lit wall. It casts the shelf's
    // shadow onto the wall; sleeves cast none (the user's call).
    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.radius = 10;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
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
      const [model, env, record] = await Promise.all([
        loadShelfModel(MODEL_URL),
        new RGBELoader().loadAsync(ENV_URL),
        // without the record model the shelf still works, with drawn records
        loadRecordModel(RECORD_URL).catch((e) => (console.error(e), null)),
      ]);
      this.record = record;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      env.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.environment = pmrem.fromEquirectangular(env).texture;
      env.dispose();
      pmrem.dispose();
      this.model = model;
      this.k = model.slots[0].size / SIZE;
      this.scene.background = model.wallColor;
      this.cb.onWall?.();
      // sleeves built before the record model arrived get rebuilt with it
      if (record && this.items.length) this.setItems(this.items.map(({ entry, images }) => ({ entry, images })));
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
  get recordOut() {
    return this.s.open;
  }

  setItems(list: ShelfItem[]) {
    const keep = this.pickedEntry?.bottle.id;
    // where each sleeve stands now: rebuilt sleeves continue from there, so a sleeve whose place
    // changed (one was added or removed) travels to its new place instead of jumping
    const was = new Map(
      this.items.map((it) => [
        it.entry.bottle.id,
        { pos: it.group.position.clone(), quat: it.group.quaternion.clone(), inHand: it.inHand, glow: it.glow },
      ]),
    );
    for (const it of this.items) this.disposeItem(it);
    this.items = list.map((d, i) => this.buildItem(d, i));
    this.s.picked = keep ? this.items.findIndex((it) => it.entry.bottle.id === keep) : -1;
    if (this.s.picked >= 0) {
      this.requestDetail(this.items[this.s.picked], HIGH);
      this.setFront(this.items[this.s.picked], true);
    }
    this.layout();
    this.snapHome();
    for (const it of this.items) {
      const w = was.get(it.entry.bottle.id);
      if (!w) continue;
      it.group.position.copy(w.pos);
      it.group.quaternion.copy(w.quat);
      Object.assign(it, { inHand: w.inHand, glow: w.glow });
    }
    if (this.model) this.warmUp();
  }

  /**
   * The sleeve in hand falls out of the hand and below the screen; resolves once it is gone, so
   * the caller can delete it and rebuild the shelf. With reduced motion it is gone at once.
   */
  discardPicked(): Promise<void> {
    const i = this.s.picked;
    if (i < 0) return Promise.resolve();
    const it = this.items[i];
    Object.assign(this.s, { picked: -1, open: false, rotX: 0, rotY: 0, pull: null, dragging: false });
    this.canvas.style.cursor = 'default';
    this.cb.onPutBack();
    if (this.reduce.matches) {
      it.group.visible = false;
      this.invalidate();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.dropping = { it, v: 0, fallen: 0, resolve };
      this.invalidate();
    });
  }
  private dropping: { it: Item; v: number; fallen: number; resolve: () => void } | null = null;

  /** The shelf develops out of blur, like a photo in the tray (after a deletion). */
  private develop() {
    if (this.reduce.matches) return;
    const cv = this.canvas;
    cv.style.transition = 'none';
    cv.style.filter = `blur(${css('--blur-reveal') || '12px'})`;
    void cv.offsetWidth; // apply the blur before the transition starts
    cv.style.transition = 'filter var(--duration-reveal) var(--ease-develop)';
    cv.style.filter = 'blur(0px)';
    cv.addEventListener(
      'transitionend',
      () => {
        cv.style.filter = '';
        cv.style.transition = '';
      },
      { once: true },
    );
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
    this.aimWater(this.waterOwner, true);
    this.invalidate();
  }

  // ---------- the water's colours ----------

  /** Whose colours the water shows: the sleeve in hand (or falling), until the water has faded. */
  private waterOwner: Item | null = null;

  /**
   * The cover's two colours, as they are: the colour that carries the cover for the water, its
   * second colour for the highlights, or the first one lightened when the cover has no second.
   * The cover is the one on the sleeve: the person's own picture, else the track's artwork.
   */
  private coverTint(it: Item): { water: string; highlight: string } | null {
    if (it.tint === undefined) {
      const c = it.entry.current && it.images.cover ? coverColours(it.images.cover as ImageBitmap) : null;
      it.tint = c ? { water: c.main, highlight: c.second ?? `#${new THREE.Color(c.main).lerp(WHITE, 0.55).getHexString()}` } : null;
    }
    return it.tint;
  }

  /** Points the water at a sleeve's cover colours, or at the theme's when it has none. */
  private aimWater(owner: Item | null, now = false) {
    this.waterOwner = owner;
    const tint = owner ? this.coverTint(owner) : null;
    if (tint) this.veil.aim(tint.water, tint.highlight, WATER.strength.cover, now);
    else {
      const night = document.documentElement.dataset.theme === 'dark';
      const strength = night ? WATER.strength.night : WATER.strength.day;
      this.veil.aim(css('--paper') || '#efeeec', css('--ink') || '#1f1e21', strength, now);
    }
  }

  /**
   * Which text reads on the wall (the top bar, the hint, the credits): 'dark' for light text,
   * 'light' for dark text, by the wall's own colour. Null until the model has loaded.
   */
  get wallTone(): 'light' | 'dark' | null {
    return this.model ? toneFor(`#${this.model.wallColor.getHexString()}`) : null;
  }

  /**
   * Which text reads on the water behind the sleeve in hand: 'dark' for light text, 'light' for
   * dark text, null when the water wears the theme's own colours. Of the two inks, the one with
   * more contrast wins.
   */
  get backdropTone(): 'light' | 'dark' | null {
    const tint = this.waterOwner ? this.coverTint(this.waterOwner) : null;
    return tint ? toneFor(tint.water) : null;
  }

  pick(i: number) {
    if (i < 0 || i >= this.items.length || this.dropping?.it === this.items[i]) return;
    if (this.s.picked >= 0 && this.s.picked !== i) this.requestDetail(this.items[this.s.picked], LOW);
    Object.assign(this.s, { picked: i, open: false, rotX: 0, rotY: 0, hover: -1, pull: null });
    this.openNow = 0;
    this.requestDetail(this.items[i], HIGH);
    this.setFront(this.items[i], true);
    // water still hidden: it comes up already in the cover's colours; already shown: it flows to them
    this.aimWater(this.items[i], this.veil.opacity < 0.01);
    // picked from another shelf (the keyboard's list): the view goes to that shelf
    if (this.model) this.goTo(Math.floor(i / this.model.slots.length));
    this.cb.onPick(this.items[i].entry);
    this.invalidate();
  }

  putBack() {
    if (this.s.picked < 0) return;
    this.requestDetail(this.items[this.s.picked], LOW);
    Object.assign(this.s, { picked: -1, open: false, rotX: 0, rotY: 0, pull: null });
    this.canvas.style.cursor = 'default';
    this.cb.onPutBack();
    this.invalidate();
  }

  /** The record in or out without the gesture: the keyboard's way (Space). */
  toggleRecord() {
    const it = this.items[this.s.picked];
    if (!it?.vinyl) return;
    this.s.open = !this.s.open;
    if (this.s.open) Object.assign(this.s, { rotX: 0, rotY: 0 });
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
    let vinylMat: THREE.MeshStandardMaterial | null = null;
    const rec = this.record;
    if (e.current && rec) {
      // the record model, its own maps, our label on its colour texture
      vinylMat = rec.material.clone();
      vinylMat.map = tex(vinylCanvas(e, LOW, rec.skin), false);
      vinyl = new THREE.Mesh(rec.geometry, vinylMat);
      vinyl.scale.setScalar(RECORD_R / rec.radius);
      vinyl.userData.sharedGeometry = true;
      g.add(vinyl);
    } else if (e.current) {
      vinylMat = new THREE.MeshPhysicalMaterial({ map: tex(vinylCanvas(e, LOW)), roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.2 });
      const vg = new THREE.CylinderGeometry(RECORD_R, RECORD_R, 0.012, 96);
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
      lift: HOVER_LIFT.back,
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
    else if (part === 'vinyl' && it.vinylMat) (mat = it.vinylMat), (canvas = vinylCanvas(it.entry, size, this.record?.skin));
    else if (part === 'sticker' && it.sticker) (mat = it.sticker.material), (canvas = stickerCanvas(it.entry, it.images, size)?.canvas ?? null);
    if (!mat || !canvas) return;
    const t = tex(canvas, !(part === 'vinyl' && this.record));
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
      // the record model's geometry is shared by every sleeve; its maps belong to the model too
      if (!o.userData.sharedGeometry) o.geometry.dispose();
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
      const module = Math.floor(i / per);
      const offset = m.along.clone().multiplyScalar(m.width * module);
      it.home.pos.copy(slot.pos).add(offset);
      it.home.quat.copy(slot.quat);
      it.group.scale.setScalar(this.k);
      // places are numbered from the viewer back: the further back, the higher it rises
      const standing = Math.min(per, this.items.length - module * per);
      const depth = standing > 1 ? (i % per) / (standing - 1) : 0;
      it.lift = HOVER_LIFT.front + (HOVER_LIFT.back - HOVER_LIFT.front) * depth;
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
    this.viewT = t;
    this.pages = count;
    if (this.page > count - 1) this.goTo(count - 1);
    this.pan = THREE.MathUtils.clamp(this.pan, 0, (count - 1) * m.width);

    // the sleeve in hand fills ~70% of the short side, with room for the record pulled out
    const S = SIZE * this.k;
    this.pickD = Math.max((S + 1.3 * this.k) / 0.86 / t / this.cam.aspect, S / 0.62 / t);
    this.sleevePx = (S / (this.pickD * t)) * this.host.clientHeight;
    this.viewT = t;
    this.invalidate();
  }

  // ---------- paging between shelves ----------
  // One gesture toward the next shelf (a scroll, a swipe, an arrow key) only leans the view that
  // way and says so; a second one in the same direction carries it there. Nobody has to scroll the
  // whole wall by hand.

  /** Leans toward the next (+1) or previous (−1) shelf, or goes there if already leaning. */
  nudge(dir: 1 | -1) {
    if (this.s.picked >= 0) return;
    const to = this.page + dir;
    if (to < 0 || to >= this.pages) return;
    if (this.peek === dir) {
      this.goTo(to);
      return;
    }
    this.peek = dir;
    clearTimeout(this.peekTimer);
    this.peekTimer = window.setTimeout(() => this.endPeek(), PAGING.peekSeconds * 1000);
    this.cb.onPeek?.(dir);
    this.invalidate();
  }

  private goTo(page: number) {
    this.page = page;
    this.endPeek();
  }

  private endPeek() {
    clearTimeout(this.peekTimer);
    if (this.peek) this.cb.onPeek?.(0);
    this.peek = 0;
    this.invalidate();
  }

  /** How far along the wall the view stands for a shelf and a lean (a share of the view's width). */
  private panFor(page: number, peek: number) {
    const m = this.model;
    if (!m) return 0;
    const viewW = this.dist * this.viewT * this.cam.aspect;
    return page * m.width + peek * PAGING.peek * viewW;
  }

  /**
   * Where the hint goes: above the middle of the shelf in view, in CSS pixels, as it will stand
   * once the view has finished leaning.
   */
  hintAnchor(): { x: number; y: number } | null {
    const m = this.model;
    if (!m) return null;
    const top = Math.max(...m.slots.map((s) => s.pos.y + s.size / 2));
    const shelf = this.target.clone().addScaledVector(m.along, this.page * m.width);
    shelf.y = top + SIZE * this.k * 0.25;
    // the camera where the lean will leave it
    const look = this.target.clone().addScaledVector(m.along, this.panFor(this.page, this.peek));
    const cam = this.cam.clone();
    cam.position.copy(look).addScaledVector(this.dir, this.dist);
    cam.lookAt(look);
    cam.updateMatrixWorld();
    const p = shelf.project(cam);
    return { x: ((p.x + 1) / 2) * this.host.clientWidth, y: ((1 - p.y) / 2) * this.host.clientHeight };
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

    // the view travels along the wall on the design system's ease-settle: it sets off gently and
    // comes to rest gently, over PAGING.travelSeconds to another shelf, PAGING.leanSeconds to lean
    if (m) {
      const to = this.panFor(this.page, this.peek);
      const tw = this.panTween;
      if (to !== tw.to) {
        const far = Math.abs(to - this.pan) > m.width / 2;
        Object.assign(tw, { from: this.pan, to, t: 0, dur: far ? PAGING.travelSeconds : PAGING.leanSeconds });
      }
      if (reduce) tw.t = tw.dur;
      tw.t = Math.min(tw.dur, tw.t + dt);
      this.pan = tw.from + (tw.to - tw.from) * easeSettle(tw.t / tw.dur);
      if (tw.t < tw.dur) moving = true;
    }
    const look = this.target.clone();
    if (m) look.addScaledVector(m.along, this.pan);
    this.cam.position.copy(look).addScaledVector(this.dir, this.dist);
    this.cam.lookAt(look);
    this.cam.updateMatrixWorld();
    this.cam.getWorldDirection(this.camFwd);
    this.camRight.setFromMatrixColumn(this.cam.matrixWorld, 0);
    this.sun.target.position.copy(look);
    if (m) {
      this.sun.position.copy(look).addScaledVector(m.wallNormal, 2).add(new THREE.Vector3(0, 4, 0)).addScaledVector(m.along, -1);
      // the shadow map covers the shelf in view and the wall below it
      const sc = this.sun.shadow.camera;
      const r = m.width / 2;
      if (sc.right !== r) {
        Object.assign(sc, { left: -r, right: r, top: r, bottom: -r, near: 0.1, far: 20 });
        sc.updateProjectionMatrix();
      }
    }

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
      // a sleeve falling away moves on its own, below
      if (this.dropping?.it === it) return;
      const held = s.picked === i;
      if (held) {
        this.tp.copy(this.cam.position).addScaledVector(this.camFwd, this.pickD);
        if (it.vinyl) this.tp.addScaledVector(this.camRight, -0.6 * this.k * this.openNow);
        this.eu.set(s.rotX, s.rotY, 0);
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
        // a hovered sleeve rises straight up out of the row (by it.lift of its height), so it
        // never passes through the sleeve standing in front of it
        this.tp.copy(it.home.pos);
        this.tp.y += it.hover * it.lift * SIZE * this.k;
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
    // the deleted sleeve falls: from rest, faster and faster, tumbling a little, until it has left
    // the screen (DROP.seconds to fall the height of the view)
    const d = this.dropping;
    if (d) {
      const fall = this.pickD * this.viewT + SIZE * this.k;
      const g = (2 * fall) / DROP.seconds ** 2;
      d.v += g * dt;
      const dy = d.v * dt;
      d.fallen += dy;
      d.it.group.position.addScaledVector(this.camUp, -dy);
      d.it.group.rotateX(dt * DROP.tumble);
      d.it.group.rotateZ(-dt * DROP.tumble * 0.6);
      moving = true;
      if (d.fallen > fall) {
        d.it.group.visible = false;
        this.dropping = null;
        this.develop();
        d.resolve();
      }
    }

    const veil = this.veil;
    veil.mesh.position.copy(this.cam.position).addScaledVector(this.camFwd, this.pickD + SIZE * this.k);
    veil.mesh.quaternion.copy(this.cam.quaternion);
    // the water stays while a deleted sleeve is still falling
    const veilTarget = s.picked >= 0 || this.dropping ? 1 : 0;
    veil.opacity += (veilTarget - veil.opacity) * k;
    if (Math.abs(veilTarget - veil.opacity) > 1e-3) moving = true;
    else veil.opacity = veilTarget;
    // its colours flow to the cover of the sleeve in hand; they go back to the theme's only once
    // the water has faded, so it never changes colour while it is leaving
    if (veil.opacity === 0 && this.waterOwner && s.picked < 0 && !this.dropping) this.aimWater(null, true);
    if (veil.ease(k)) moving = true;
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
   * right to put it back; the left part turns the sleeve either way. Only with a record, and only
   * while the front faces the viewer (turned round, the "right half" would be the wrong side).
   */
  private startsPull(local: THREE.Vector3): boolean {
    const it = this.items[this.s.picked];
    const faceUp = Math.cos(this.s.rotX) * Math.cos(this.s.rotY) > 0;
    if (!it?.vinyl || !faceUp) return false;
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
      const start = down;
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
      // a sideways swipe across the wall: one step toward the next or previous shelf
      if (moved && this.s.picked < 0 && start) {
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) > PAGING.swipePx && Math.abs(dx) > Math.abs(dy)) this.nudge(dx < 0 ? 1 : -1);
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
    // A scroll is one gesture however many wheel events it sends (a trackpad sends dozens, with
    // inertia): it counts once its movement adds up, and the next one only after a pause.
    let wheelSum = 0;
    let wheelQuiet = 0;
    let wheelSpent = false;
    cv.addEventListener(
      'wheel',
      (e) => {
        if (this.s.picked >= 0) return;
        e.preventDefault();
        clearTimeout(wheelQuiet);
        wheelQuiet = window.setTimeout(() => ((wheelSum = 0), (wheelSpent = false)), PAGING.wheelPauseMs);
        if (wheelSpent) return;
        wheelSum += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (Math.abs(wheelSum) < PAGING.wheelPx) return;
        wheelSpent = true;
        this.nudge(wheelSum > 0 ? 1 : -1);
      },
      { passive: false },
    );
  }
}
