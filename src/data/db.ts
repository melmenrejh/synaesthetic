// Everything lives in the browser (IndexedDB) for the MVP. The functions below are the only way
// the app touches storage, so a server-backed version can replace this file without the UI noticing.
import { openDB, type DBSchema } from 'idb';
import { lastChange, newId, now, type Bottle, type Pairing, type ShelfEntry, type Track } from './model';

interface Schema extends DBSchema {
  bottles: { key: string; value: Bottle };
  pairings: { key: string; value: Pairing; indexes: { bottleId: string } };
  tracks: { key: string; value: Track };
  blobs: { key: string; value: Blob };
}

const db = openDB<Schema>('synaesthetic', 1, {
  upgrade(d) {
    d.createObjectStore('bottles', { keyPath: 'id' });
    d.createObjectStore('pairings', { keyPath: 'id' }).createIndex('bottleId', 'bottleId');
    d.createObjectStore('tracks', { keyPath: 'id' });
    d.createObjectStore('blobs');
  },
});

// Ask the browser not to clear our storage under pressure (Safari does, unless installed as a PWA).
void navigator.storage?.persist?.();

export async function putBlob(blob: Blob): Promise<string> {
  const id = newId();
  await (await db).put('blobs', blob, id);
  return id;
}

export const getBlob = async (id: string) => (await db).get('blobs', id);

export async function loadShelf(): Promise<ShelfEntry[]> {
  const d = await db;
  const [bottles, pairings, tracks] = await Promise.all([d.getAll('bottles'), d.getAll('pairings'), d.getAll('tracks')]);
  const trackById = new Map(tracks.map((t) => [t.id, t]));
  const entries = bottles.map((bottle): ShelfEntry => {
    const history = pairings
      .filter((p) => p.bottleId === bottle.id)
      .sort((a, b) => a.from.localeCompare(b.from))
      .map((pairing) => ({ pairing, track: trackById.get(pairing.trackId)! }))
      .filter((h) => h.track);
    return { bottle, history, current: history.find((h) => !h.pairing.to) };
  });
  return entries.sort((a, b) => lastChange(b).localeCompare(lastChange(a)));
}

const sameBottle = (a: Pick<Bottle, 'brand' | 'name'>, b: Pick<Bottle, 'brand' | 'name'>) =>
  a.brand.trim().toLowerCase() === b.brand.trim().toLowerCase() &&
  a.name.trim().toLowerCase() === b.name.trim().toLowerCase();

export async function findBottle(brand: string, name: string): Promise<Bottle | undefined> {
  return (await (await db).getAll('bottles')).find((b) => sameBottle(b, { brand, name }));
}

export async function addBottle(bottle: Omit<Bottle, 'id' | 'addedAt'>): Promise<Bottle> {
  const b: Bottle = { ...bottle, id: newId(), addedAt: now() };
  await (await db).put('bottles', b);
  return b;
}

/**
 * Removes a bottle for good: its pairings, its pictures, and the tracks no other bottle uses
 * (with their artwork and audio files). One transaction, so a failure leaves nothing half-deleted.
 */
export async function deleteBottle(id: string): Promise<void> {
  const d = await db;
  const tx = d.transaction(['bottles', 'pairings', 'tracks', 'blobs'], 'readwrite');
  const bottles = tx.objectStore('bottles');
  const pairings = tx.objectStore('pairings');
  const tracks = tx.objectStore('tracks');
  const blobs = tx.objectStore('blobs');

  const bottle = await bottles.get(id);
  const all = await pairings.getAll();
  const own = all.filter((p) => p.bottleId === id);
  const stillUsed = new Set(all.filter((p) => p.bottleId !== id).map((p) => p.trackId));
  const orphanBlobs: (string | undefined)[] = [bottle?.photo, bottle?.cutout, ...own.map((p) => p.coverImage)];

  for (const p of own) await pairings.delete(p.id);
  for (const trackId of new Set(own.map((p) => p.trackId))) {
    if (stillUsed.has(trackId)) continue;
    const t = await tracks.get(trackId);
    if (t) orphanBlobs.push(t.artwork, t.localFile);
    await tracks.delete(trackId);
  }
  for (const b of orphanBlobs) if (b) await blobs.delete(b);
  await bottles.delete(id);
  await tx.done;
}

/**
 * Gives the bottle a new song from `from` (ISO date, the day it is put on). The current pairing,
 * if any, ends on that date, so the history stays gapless; a song can be replaced but never removed.
 */
export async function setSong(
  bottleId: string,
  track: Omit<Track, 'id'>,
  from: string,
  coverImage?: string,
): Promise<void> {
  const d = await db;
  const tx = d.transaction(['pairings', 'tracks'], 'readwrite');
  const tracks = tx.objectStore('tracks');
  const existing = track.sourceUrl ? (await tracks.getAll()).find((t) => t.sourceUrl === track.sourceUrl) : undefined;
  const t: Track = existing ? { ...existing, ...track, id: existing.id } : { ...track, id: newId() };
  await tracks.put(t);
  const pairings = tx.objectStore('pairings');
  const current = (await pairings.index('bottleId').getAll(bottleId)).find((p) => !p.to);
  if (current) await pairings.put({ ...current, to: from });
  await pairings.put({ id: newId(), bottleId, trackId: t.id, coverImage, from });
  await tx.done;
}
