import type { SearchResultItem } from '@songloft/plugin-sdk';
import type { LyricResult, MusicInfo, PlatformId } from '../types';
import { musicSdk } from '../musicSdk/facade';
import { matchScore, searchAcross } from '../handlers/search';
import { getLyricSettings, type LyricTranslationMode } from './settings';

export type LyricStatus = 'pending' | 'fetching' | 'completed' | 'not_found' | 'failed' | 'skipped';

export interface ResolvedLyrics {
  status: Exclude<LyricStatus, 'pending' | 'fetching'>;
  lyric: string;
  tlyric: string;
  lxlyric: string;
  displayLyric: string;
  source: PlatformId | '';
  fallback: boolean;
  message: string;
  error: string;
}

const PLATFORM_IDS = new Set<PlatformId>(['kw', 'kg', 'tx', 'wy', 'mg']);
const PLATFORM_NAMES: Record<PlatformId, string> = {
  kw: '酷我', kg: '酷狗', tx: 'QQ 音乐', wy: '网易云', mg: '咪咕',
};
const cache = new Map<string, ResolvedLyrics>();
let lyricRequestChain: Promise<void> = Promise.resolve();
let lastLyricRequestAt = 0;

function isPlatform(value: unknown): value is PlatformId {
  return PLATFORM_IDS.has(String(value) as PlatformId);
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function cacheKey(platform: PlatformId, song: MusicInfo): string {
  const id = song.songmid || song.musicId || song.hash || song.copyrightId || song.meta?.songId || song.id;
  return `${platform}:${String(id || `${song.name}|${song.singer}`)}`;
}

async function protectedLyricRequest<T>(task: () => Promise<T>, intervalMs: number): Promise<T> {
  let release!: () => void;
  const previous = lyricRequestChain;
  lyricRequestChain = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const wait = Math.max(0, lastLyricRequestAt + intervalMs - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    return await task();
  } finally {
    lastLyricRequestAt = Date.now();
    release();
  }
}

function timestampKey(line: string): string {
  const match = line.match(/^\s*(\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])/);
  return match?.[1].replace('.', ':') || '';
}

export function mergeTranslatedLyric(lyric: string, translated: string): string {
  const primary = normalizeText(lyric);
  const translation = normalizeText(translated);
  if (!primary) return translation;
  if (!translation) return primary;
  const translatedByTime = new Map<string, string[]>();
  const unmatched: string[] = [];
  for (const line of translation.split(/\r?\n/)) {
    const key = timestampKey(line);
    if (!key) { if (line.trim()) unmatched.push(line); continue; }
    const rows = translatedByTime.get(key) || [];
    rows.push(line);
    translatedByTime.set(key, rows);
  }
  const output: string[] = [];
  for (const line of primary.split(/\r?\n/)) {
    output.push(line);
    const key = timestampKey(line);
    const rows = key ? translatedByTime.get(key) : undefined;
    if (rows?.length) {
      for (const translatedLine of rows) if (translatedLine.trim() !== line.trim()) output.push(translatedLine);
      translatedByTime.delete(key);
    }
  }
  const remainder = [...translatedByTime.values()].flat().concat(unmatched);
  if (remainder.length) output.push(...remainder);
  return output.join('\n').trim();
}

export function composeLyric(lyric: string, translated: string, enhanced: string, mode: LyricTranslationMode): string {
  const primary = normalizeText(lyric) || normalizeText(enhanced);
  const translation = normalizeText(translated);
  if (mode === 'original') return primary;
  if (mode === 'translation') return translation || primary;
  return mergeTranslatedLyric(primary, translation);
}

async function fetchPlatformLyric(platform: PlatformId, song: MusicInfo, intervalMs: number): Promise<LyricResult> {
  return protectedLyricRequest(() => musicSdk[platform].getLyric(song), intervalMs);
}

function completed(platform: PlatformId, result: LyricResult, fallback: boolean, mode: LyricTranslationMode): ResolvedLyrics {
  const lyric = normalizeText(result.lyric);
  const tlyric = normalizeText(result.tlyric);
  const lxlyric = normalizeText(result.lxlyric);
  return {
    status: 'completed', lyric, tlyric, lxlyric,
    displayLyric: composeLyric(lyric, tlyric, lxlyric, mode),
    source: platform, fallback,
    message: fallback ? `已从${PLATFORM_NAMES[platform]}匹配歌词` : `已从${PLATFORM_NAMES[platform]}获取歌词`,
    error: '',
  };
}

async function trySong(platform: PlatformId, song: MusicInfo, fallback: boolean, mode: LyricTranslationMode, intervalMs: number): Promise<ResolvedLyrics | null> {
  const key = cacheKey(platform, song);
  const cached = cache.get(key);
  if (cached) return cached.status === 'completed' ? {
    ...cached,
    fallback,
    displayLyric: composeLyric(cached.lyric, cached.tlyric, cached.lxlyric, mode),
    message: fallback ? `已从${PLATFORM_NAMES[platform]}匹配歌词` : `已从${PLATFORM_NAMES[platform]}获取歌词`,
  } : null;
  try {
    const result = await fetchPlatformLyric(platform, song, intervalMs);
    if (!normalizeText(result.lyric) && !normalizeText(result.lxlyric)) {
      cache.set(key, { status: 'not_found', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: platform, fallback, message: '该版本没有返回歌词', error: '' });
      return null;
    }
    const resolved = completed(platform, result, fallback, mode);
    cache.set(key, resolved);
    return resolved;
  } catch {
    return null;
  }
}

export async function resolveLyrics(item: SearchResultItem, allowFallback?: boolean): Promise<ResolvedLyrics> {
  const settings = await getLyricSettings();
  const fallbackEnabled = allowFallback ?? settings.fallback_enabled;
  const sourceData = item.source_data || {};
  const originalSource = String(sourceData.platform || '') as PlatformId;
  const originalSong = sourceData.songInfo as MusicInfo | undefined;
  if (!isPlatform(originalSource) || !originalSong) {
    return { status: 'failed', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: '', fallback: false, message: '歌曲缺少歌词来源信息', error: 'source_data 格式无效' };
  }

  const direct = await trySong(originalSource, originalSong, false, settings.translation_mode, settings.request_interval_ms);
  if (direct) return direct;
  if (!fallbackEnabled) {
    return { status: 'not_found', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: originalSource, fallback: false, message: '原平台没有返回歌词', error: '' };
  }

  const title = item.title || originalSong.name || '';
  const artist = item.artist || originalSong.singer || '';
  const duration = Number(item.duration || originalSong.duration || 0) || undefined;
  try {
    const candidates = (await searchAcross(`${title} ${artist}`.trim(), 1, 10, '128k'))
      .filter(candidate => isPlatform(candidate.source_data?.platform) && candidate.source_data.platform !== originalSource)
      .map(candidate => ({ candidate, score: matchScore(candidate, title, artist, duration) }))
      .filter(entry => entry.score >= 130)
      .sort((a, b) => b.score - a.score);
    for (const { candidate } of candidates.slice(0, 5)) {
      const platform = candidate.source_data.platform as PlatformId;
      const song = candidate.source_data.songInfo as MusicInfo | undefined;
      if (!song) continue;
      const result = await trySong(platform, song, true, settings.translation_mode, settings.request_interval_ms);
      if (result) return result;
    }
    return { status: 'not_found', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: originalSource, fallback: false, message: '原平台及其他安全匹配版本均没有歌词', error: '' };
  } catch (error) {
    return { status: 'failed', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: originalSource, fallback: false, message: '歌词跨平台匹配失败', error: String((error as Error)?.message || error) };
  }
}

export function clearLyricCache(): void {
  cache.clear();
}
