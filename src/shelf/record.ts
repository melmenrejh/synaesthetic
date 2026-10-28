// The record: "12" Vinyl Record" by AleixoAlonso (CC BY 4.0, public/models/vinyl/license.txt),
// with our own label laid over its label. Its geometry and its normal, roughness and occlusion maps
// stay as they are; only the colour texture is redrawn per bottle (textures.ts, vinylCanvas).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { RecordSkin } from './textures';

export interface RecordModel {
  /** A flat disc in the XY plane, centred on the origin, front facing +Z. Shared by all sleeves. */
  geometry: THREE.BufferGeometry;
  /** The model's material; each record takes a clone with its own colour texture. */
  material: THREE.MeshStandardMaterial;
  radius: number;
  skin: RecordSkin;
}

/**
 * Where the two labels (side A and side B) lie on the model's texture, measured on its roughness
 * map, where the paper labels stand out from the vinyl. The model's UVs show the texture mirrored,
 * so our label is drawn mirrored to read right on the record.
 */
const LABELS = [
  { u: 0.2906, v: 0.2905, r: 0.0947, rot: 0, mirror: true },
  { u: 0.709, v: 0.7087, r: 0.0947, rot: 0, mirror: true },
];

export async function loadRecordModel(url: string): Promise<RecordModel> {
  const gltf = await new GLTFLoader().loadAsync(url);
  let mesh: THREE.Mesh | null = null;
  gltf.scene.traverse((o) => {
    if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
  });
  if (!mesh) throw new Error('record model: no mesh');
  const m = mesh as THREE.Mesh;
  // the file's own node transforms only tilt it for a showcase; the mesh itself lies flat in XY
  const geometry = m.geometry.clone();
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  geometry.translate(0, 0, -(box.min.z + box.max.z) / 2);
  const material = m.material as THREE.MeshStandardMaterial;
  const image = material.map?.image as CanvasImageSource | undefined;
  if (!image) throw new Error('record model: no colour texture');
  return { geometry, material, radius: Math.max(box.max.x, -box.min.x), skin: { image, labels: LABELS } };
}
