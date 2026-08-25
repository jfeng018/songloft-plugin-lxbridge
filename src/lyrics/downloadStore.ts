import type { SearchResultItem } from '@songloft/plugin-sdk';
import type { ResolvedLyrics } from './resolver';

const STORAGE_KEY = 'neo-lxbridge:download_lyrics:v1';
const MAX_ENTRIES = 100;

export interface DownloadLyricSnapshot {
  job_id: string;
  song_id: number;
  item: SearchResultItem;
  result: ResolvedLyrics;
  updated_at: number;
}

let loaded = false;
let snapshots = new Map<string, DownloadLyricSnapshot>();
let persistChain: Promise<void> = Promise.resolve();

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await songloft.persistentStorage.get(STORAGE_KEY);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      snapshots = new Map(parsed
        .filter(entry => entry && typeof entry.job_id === 'string')
        .map(entry => [entry.job_id, entry as DownloadLyricSnapshot]));
    }
  } catch {
    snapshots = new Map();
  }
}

async function persist(): Promise<void> {
  const entries = [...snapshots.values()]
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, MAX_ENTRIES);
  snapshots = new Map(entries.map(entry => [entry.job_id, entry]));
  persistChain = persistChain.then(() => songloft.persistentStorage.set(STORAGE_KEY, JSON.stringify(entries)));
  await persistChain;
}

export async function getDownloadLyricSnapshot(jobId: string): Promise<DownloadLyricSnapshot | null> {
  await ensureLoaded();
  return snapshots.get(jobId) || null;
}

export async function saveDownloadLyricSnapshot(jobId: string, songId: number, item: SearchResultItem, result: ResolvedLyrics): Promise<void> {
  await ensureLoaded();
  snapshots.set(jobId, { job_id: jobId, song_id: songId, item, result, updated_at: Date.now() });
  await persist();
}

export function resetDownloadLyricStore(): void {
  loaded = false;
  snapshots = new Map();
  persistChain = Promise.resolve();
}
