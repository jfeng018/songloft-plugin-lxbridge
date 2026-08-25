import type { LyricResult } from '../types';
import { httpFetch } from '../musicSdk/request';

export interface LrclibQuery {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
}

interface LrclibResponse {
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

const CLIENT_HEADER = 'Songloft-LxBridge (https://github.com/NeoHeee/songloft-plugin-lxbridge)';

export function parseLrclibResponse(value: unknown): LyricResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as LrclibResponse;
  const synced = String(data.syncedLyrics || '').trim();
  const plain = String(data.plainLyrics || '').trim();
  if (data.instrumental || (!synced && !plain)) return null;
  return { lyric: synced || plain, tlyric: '', lxlyric: '', wordLyricSupported: false, raw: value };
}

export async function getLrclibLyrics(query: LrclibQuery): Promise<LyricResult | null> {
  const title = String(query.title || '').trim();
  const artist = String(query.artist || '').trim();
  if (!title || !artist) return null;
  const params = new URLSearchParams({ track_name: title, artist_name: artist });
  const album = String(query.album || '').trim();
  if (album) params.set('album_name', album);
  const duration = Math.round(Number(query.duration || 0));
  if (duration >= 1 && duration <= 3600) params.set('duration', String(duration));
  const { body, statusCode, headers } = await httpFetch(`https://lrclib.net/api/get?${params.toString()}`, {
    headers: { Accept: 'application/json', 'Lrclib-Client': CLIENT_HEADER },
    timeout: 20000,
  }).promise;
  if (statusCode === 404) return null;
  if (statusCode === 429) throw new Error(`LRCLIB 请求受限，请在 ${String(headers['retry-after'] || '稍后')} 秒后重试`);
  if (statusCode >= 400) throw new Error(`LRCLIB 获取失败：HTTP ${statusCode}`);
  return parseLrclibResponse(body);
}
