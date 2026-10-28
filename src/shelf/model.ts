// The shelf made in Blender (public/models/shelf.glb): a wall and a shelf with baked lighting, plus
// empties that mark where sleeves stand. Everything is read from the file, so a new export with
// other shapes, more empties or another camera angle needs no code change.
import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface Slot {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  /** Outward direction of the sleeve's front. */
  normal: THREE.Vector3;
  /** Side of the sleeve in world units. */
  size: number;
}

export interface ShelfModel {
  /** Wall and shelf. Cloned for every extra module. */
  root: THREE.Group;
  /** In the order the file numbers them (front-most first when it does not). */
  slots: Slot[];
  /** Horizontal direction along the wall, and the module width along it. */
  along: THREE.Vector3;
  width: number;
  wallNormal: THREE.Vector3;
  /** Shelf top and bottom, and its width along the wall: what the camera frames. */
  shelfBox: THREE.Box3;
  /** Average colour of the wall, for whatever lies beyond its edges. */
  wallColor: THREE.Color;
}

export async function loadShelfModel(url: string): Promise<ShelfModel> {
  const draco = new DRACOLoader().setDecoderPath('/draco/');
  const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(url);
  draco.dispose();
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);

  const meshes: THREE.Mesh[] = [];
  const empties: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    else if (o !== scene && o.children.length === 0) empties.push(o);
  });

  // The wall is the flat mesh with the largest area; everything else is the shelf.
  const boxOf = (m: THREE.Object3D) => new THREE.Box3().setFromObject(m);
  const flatness = (b: THREE.Box3) => {
    const s = b.getSize(new THREE.Vector3());
    const dims = [s.x, s.y, s.z].sort((a, c) => a - c);
    return { thin: dims[0], area: dims[1] * dims[2] };
  };
  const wall = meshes
    .filter((m) => flatness(boxOf(m)).thin < 1e-3)
    .sort((a, b) => flatness(boxOf(b)).area - flatness(boxOf(a)).area)[0];
  if (!wall) throw new Error('shelf.glb: no wall (a flat mesh) found');
  const shelfMeshes = meshes.filter((m) => m !== wall);
  const shelfBox = new THREE.Box3();
  for (const m of shelfMeshes) shelfBox.union(boxOf(m));

  const wallBox = boxOf(wall);
  const wallCenter = wallBox.getCenter(new THREE.Vector3());
  const wallNormal = new THREE.Vector3();
  {
    const s = wallBox.getSize(new THREE.Vector3());
    if (s.x <= s.y && s.x <= s.z) wallNormal.set(1, 0, 0);
    else if (s.z <= s.y) wallNormal.set(0, 0, 1);
    else wallNormal.set(0, 1, 0);
    // pointing out of the wall, toward the shelf
    if (shelfBox.getCenter(new THREE.Vector3()).sub(wallCenter).dot(wallNormal) < 0) wallNormal.negate();
  }
  const along = new THREE.Vector3(0, 1, 0).cross(wallNormal).normalize();
  const wallSize = wallBox.getSize(new THREE.Vector3());
  const width = Math.abs(wallSize.dot(along));

  // Baked light lives in the textures: show them as they are, unlit. Sleeves cast no shadows
  // (the user's call): the baked shadow of the shelf is the only one.
  for (const m of meshes) {
    const old = m.material as THREE.MeshStandardMaterial;
    m.material = new THREE.MeshBasicMaterial({ map: old.map, side: old.side, toneMapped: false });
    old.dispose();
  }

  // Empties: the thin axis is the sleeve's thickness, the other two its size (a cube empty spans ±1).
  // Order: by the number in the empties' names (sleeve01, sleeve02, …), the newest bottle on the
  // first; without numbers, the place nearest the viewer comes first.
  const numberOf = (name: string) => {
    const m = /(\d+)\D*$/.exec(name);
    return m ? Number(m[1]) : NaN;
  };
  const numbered = empties.every((e) => !Number.isNaN(numberOf(e.name)));
  if (numbered) empties.sort((a, b) => numberOf(a.name) - numberOf(b.name));
  const slots: Slot[] = empties.map((e) => {
    const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
    e.matrixWorld.extractBasis(ax, ay, az);
    const axes = [ax, ay, az].sort((a, b) => a.length() - b.length());
    const normal = axes[0].clone().setY(0).normalize();
    if (normal.dot(wallNormal) < 0) normal.negate();
    const size = 2 * axes[2].length();
    const up = new THREE.Vector3(0, 1, 0);
    const x = new THREE.Vector3().crossVectors(up, normal).normalize();
    const quat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, normal));
    return { pos: new THREE.Vector3().setFromMatrixPosition(e.matrixWorld), quat, normal, size };
  });
  if (!slots.length) throw new Error('shelf.glb: no empties to stand sleeves on');
  if (!numbered) slots.sort((a, b) => b.pos.dot(a.normal) - a.pos.dot(a.normal));

  const root = new THREE.Group();
  for (const m of meshes) root.attach(m);
  return { root, slots, along, width, wallNormal, shelfBox, wallColor: averageColor(wall) };
}

function averageColor(mesh: THREE.Mesh): THREE.Color {
  const img = ((mesh.material as THREE.MeshBasicMaterial).map?.image ?? null) as CanvasImageSource | null;
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  try {
    if (img) x.drawImage(img, 0, 0, 8, 8);
    const d = x.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    return new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
  } catch {
    return new THREE.Color('#3a393c');
  }
}
