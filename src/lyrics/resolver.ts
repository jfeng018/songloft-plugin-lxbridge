import type { SearchResultItem } from '@songloft/plugin-sdk';
import type { LyricResult, MusicInfo, PlatformId } from '../types';
import { musicSdk } from '../musicSdk/facade';
import { matchScore, searchAcross } from '../handlers/search';
import { getLyricSettings, type LyricPreferredSource, type LyricTranslationMode } from './settings';
import type { WordLyricStatus } from './wordLyric';
import { getLrclibLyrics } from './lrclib';

export type LyricStatus = 'pending' | 'fetching' | 'completed' | 'not_found' | 'failed' | 'skipped';

export interface ResolvedLyrics {
  status: Exclude<LyricStatus, 'pending' | 'fetching'>;
  lyric: string;
  tlyric: string;
  lxlyric: string;
  wordLyricStatus?: WordLyricStatus;
  displayLyric: string;
  source: PlatformId | 'lrclib' | '';
  fallback: boolean;
  message: string;
  error: string;
}

export interface LyricMetadataQuery {
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
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
    wordLyricStatus: lxlyric ? 'available' : result.wordLyricSupported === false ? 'unsupported' : result.wordLyricSupported === true ? 'not_found' : 'unknown',
    displayLyric: composeLyric(lyric, tlyric, lxlyric, mode),
    source: platform, fallback,
    message: fallback ? `已从${PLATFORM_NAMES[platform]}匹配歌词` : `已从${PLATFORM_NAMES[platform]}获取歌词`,
    error: '',
  };
}

async function tryLrclib(query: LyricMetadataQuery, fallback: boolean, mode: LyricTranslationMode, intervalMs: number): Promise<ResolvedLyrics | null> {
  const result = await protectedLyricRequest(() => getLrclibLyrics({
    title: query.title,
    artist: query.artist || '',
    album: query.album,
    duration: query.duration,
  }), intervalMs);
  if (!result) return null;
  const lyric = normalizeText(result.lyric);
  return {
    status: 'completed', lyric, tlyric: '', lxlyric: '', wordLyricStatus: 'unsupported',
    displayLyric: composeLyric(lyric, '', '', mode), source: 'lrclib', fallback,
    message: fallback ? '已从 LRCLIB 补全歌词' : '已从 LRCLIB 获取歌词', error: '',
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

export async function resolveLyrics(item: SearchResultItem, allowFallback?: boolean, preferredSourceOverride?: LyricPreferredSource): Promise<ResolvedLyrics> {
  const settings = await getLyricSettings();
  const fallbackEnabled = allowFallback ?? settings.fallback_enabled;
  const preferredSource = preferredSourceOverride || settings.preferred_source;
  const preferredPlatform = preferredSource === 'lrclib' ? 'auto' : preferredSource;
  const sourceData = item.source_data || {};
  const originalSource = String(sourceData.platform || '') as PlatformId;
  const originalSong = sourceData.songInfo as MusicInfo | undefined;
  if (!isPlatform(originalSource) || !originalSong) {
    return { status: 'failed', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: '', fallback: false, message: '歌曲缺少歌词来源信息', error: 'source_data 格式无效' };
  }

  const title = item.title || originalSong.name || '';
  const artist = item.artist || originalSong.singer || '';
  const duration = Number(item.duration || originalSong.duration || 0) || undefined;
  if (preferredSource === 'lrclib') {
    try {
      const external = await tryLrclib({ title, artist, album: item.album || originalSong.albumName, duration }, false, settings.translation_mode, settings.request_interval_ms);
      if (external) return external;
    } catch (error) {
      if (!fallbackEnabled) return { status: 'failed', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: 'lrclib', fallback: false, message: 'LRCLIB 歌词获取失败', error: String((error as Error)?.message || error) };
    }
    if (!fallbackEnabled) return { status: 'not_found', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: 'lrclib', fallback: false, message: 'LRCLIB 没有找到匹配歌词', error: '' };
  }
  if (preferredPlatform === 'auto' || preferredPlatform === originalSource) {
    const direct = await trySong(originalSource, originalSong, false, settings.translation_mode, settings.request_interval_ms);
    if (direct) return preferredSource === originalSource
      ? { ...direct, message: `已从首选来源${PLATFORM_NAMES[originalSource]}获取歌词` }
      : direct;
    if (!fallbackEnabled) {
      const message = preferredPlatform === 'auto' ? '原平台没有返回歌词' : `指定的${PLATFORM_NAMES[originalSource]}没有返回歌词`;
      return { status: 'not_found', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: originalSource, fallback: false, message, error: '' };
    }
  }

  try {
    const candidates = (await searchAcross(`${title} ${artist}`.trim(), 1, 10, '128k'))
      .filter(candidate => isPlatform(candidate.source_data?.platform))
      .map(candidate => ({ candidate, score: matchScore(candidate, title, artist, duration) }))
      .filter(entry => entry.score >= 130)
      .sort((a, b) => b.score - a.score);

    if (preferredPlatform !== 'auto') {
      if (preferredPlatform !== originalSource) {
        for (const { candidate } of candidates.filter(entry => entry.candidate.source_data?.platform === preferredPlatform).slice(0, 3)) {
          const song = candidate.source_data.songInfo as MusicInfo | undefined;
          if (!song) continue;
          const result = await trySong(preferredPlatform, song, true, settings.translation_mode, settings.request_interval_ms);
          if (result) return { ...result, message: `已从首选来源${PLATFORM_NAMES[preferredPlatform]}获取歌词` };
        }
      }
      if (!fallbackEnabled) {
        return { status: 'not_found', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: preferredPlatform, fallback: preferredPlatform !== originalSource, message: `指定的${PLATFORM_NAMES[preferredPlatform]}没有找到匹配歌词`, error: '' };
      }
    }

    if (preferredPlatform !== 'auto' && preferredPlatform !== originalSource) {
      const direct = await trySong(originalSource, originalSong, false, settings.translation_mode, settings.request_interval_ms);
      if (direct) return direct;
    }

    for (const { candidate } of candidates.filter(entry => {
      const platform = entry.candidate.source_data?.platform;
      return platform !== originalSource && platform !== preferredPlatform;
    }).slice(0, 5)) {
      const platform = candidate.source_data.platform as PlatformId;
      const song = candidate.source_data.songInfo as MusicInfo | undefined;
      if (!song) continue;
      const result = await trySong(platform, song, true, settings.translation_mode, settings.request_interval_ms);
      if (result) return result;
    }
    if (preferredSource === 'auto') {
      const external = await tryLrclib({ title, artist, album: item.album || originalSong.albumName, duration }, true, settings.translation_mode, settings.request_interval_ms);
      if (external) return external;
    }
    return { status: 'not_found', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: originalSource, fallback: false, message: preferredSource === 'auto' ? '原平台、其他安全匹配版本及 LRCLIB 均没有歌词' : `首选来源、原平台及其他安全匹配版本均没有歌词`, error: '' };
  } catch (error) {
    return { status: 'failed', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: originalSource, fallback: false, message: '歌词跨平台匹配失败', error: String((error as Error)?.message || error) };
  }
}

export async function resolveLyricsByMetadata(query: LyricMetadataQuery, preferredSourceOverride?: LyricPreferredSource): Promise<ResolvedLyrics> {
  const settings = await getLyricSettings();
  const preferredSource = preferredSourceOverride || settings.preferred_source;
  const preferredPlatform = preferredSource === 'lrclib' ? 'auto' : preferredSource;
  const title = normalizeText(query.title);
  const artist = normalizeText(query.artist);
  const album = normalizeText(query.album);
  const duration = Number(query.duration || 0) || undefined;
  if (!title) {
    return { status: 'failed', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: '', fallback: false, message: '缺少歌曲名称', error: 'title 不能为空' };
  }
  try {
    if (preferredSource === 'lrclib') {
      try {
        const external = await tryLrclib({ title, artist, album, duration }, false, settings.translation_mode, settings.request_interval_ms);
        if (external) return external;
      } catch (error) {
        if (!settings.fallback_enabled) return { status: 'failed', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: 'lrclib', fallback: false, message: 'LRCLIB 歌词获取失败', error: String((error as Error)?.message || error) };
      }
      if (!settings.fallback_enabled) return { status: 'not_found', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: 'lrclib', fallback: false, message: 'LRCLIB 没有找到匹配歌词', error: '' };
    }
    const threshold = artist ? 130 : 90;
    const candidates = (await searchAcross(`${title} ${artist}`.trim(), 1, 12, '128k'))
      .filter(candidate => isPlatform(candidate.source_data?.platform))
      .map(candidate => {
        const albumScore = album && normalizeText(candidate.album) === album ? 20 : 0;
        return { candidate, score: matchScore(candidate, title, artist, duration) + albumScore };
      })
      .filter(entry => entry.score >= threshold)
      .sort((a, b) => b.score - a.score);
    const eligible = preferredPlatform !== 'auto' && !settings.fallback_enabled
      ? candidates.filter(entry => entry.candidate.source_data?.platform === preferredPlatform)
      : candidates.sort((a, b) => {
          const aPreferred = a.candidate.source_data?.platform === preferredPlatform ? 1 : 0;
          const bPreferred = b.candidate.source_data?.platform === preferredPlatform ? 1 : 0;
          return bPreferred - aPreferred || b.score - a.score;
        });
    for (const { candidate } of eligible.slice(0, 6)) {
      const platform = candidate.source_data.platform as PlatformId;
      const song = candidate.source_data.songInfo as MusicInfo | undefined;
      if (!song) continue;
      const result = await trySong(platform, song, false, settings.translation_mode, settings.request_interval_ms);
      if (result) return { ...result, message: `Songloft 原生歌词由${PLATFORM_NAMES[platform]}提供` };
    }
    if (preferredSource === 'auto') {
      const external = await tryLrclib({ title, artist, album, duration }, true, settings.translation_mode, settings.request_interval_ms);
      if (external) return { ...external, message: 'Songloft 原生歌词由 LRCLIB 提供' };
    }
    const source = preferredSource === 'auto' ? '' : preferredSource;
    return {
      status: 'not_found', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source, fallback: false,
      message: preferredPlatform !== 'auto' && !settings.fallback_enabled
        ? `指定的${PLATFORM_NAMES[preferredPlatform]}没有找到匹配歌词`
        : '没有找到安全匹配的歌词（含 LRCLIB）',
      error: '',
    };
  } catch (error) {
    return { status: 'failed', lyric: '', tlyric: '', lxlyric: '', displayLyric: '', source: '', fallback: false, message: '原生歌词查询失败', error: String((error as Error)?.message || error) };
  }
}

export function clearLyricCache(): void {
  cache.clear();
}
