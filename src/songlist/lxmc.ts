import * as pako from 'pako';
import type { MusicInfo, PlatformId } from '../types';
import { base64ToBytes } from '../lx_sync/crypto_lx';

const MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
const MAX_PLAYLISTS = 200;
const MAX_SONGS_PER_PLAYLIST = 5000;
const MAX_TOTAL_SONGS = 20000;
const PLATFORM_IDS = new Set<PlatformId>(['kw', 'kg', 'tx', 'wy', 'mg']);

type UnknownRecord = Record<string, unknown>;

export interface LxmcPlaylist {
  id: string;
  name: string;
  kind: 'default' | 'love' | 'user' | 'temp';
  songs: MusicInfo[];
}

export interface LxmcParseResult {
  format: 'lxmc';
  backup_type: string;
  playlists: LxmcPlaylist[];
  total_songs: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function bytesToUtf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8').decode(bytes); }
  catch { return Buffer.from(bytes).toString('utf8'); }
}

function inflateBounded(raw: Uint8Array): Uint8Array {
  const InflateCtor = (pako as { Inflate?: new (opts?: object) => {
    err: number;
    msg: string;
    onData: ((chunk: Uint8Array) => void) | null;
    push: (data: Uint8Array, mode?: boolean | number) => boolean;
  } }).Inflate;
  if (!InflateCtor) throw new Error('当前环境不支持解压洛雪备份');

  const inflator = new InflateCtor({ windowBits: 15 + 32 });
  const chunks: Uint8Array[] = [];
  let total = 0;
  inflator.onData = chunk => {
    total += chunk.byteLength;
    if (total > MAX_INFLATED_BYTES) throw new Error('洛雪备份解压后过大');
    chunks.push(chunk);
  };
  for (let offset = 0; offset < raw.byteLength; offset += 1024) {
    const end = Math.min(offset + 1024, raw.byteLength);
    inflator.push(raw.subarray(offset, end), end === raw.byteLength);
    if (inflator.err) throw new Error(inflator.msg || '洛雪备份解压失败');
  }
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return output;
}

function parseDuration(interval: unknown, fallback: unknown): number {
  const text = String(interval || '').trim();
  if (/^\d{1,3}:\d{2}$/.test(text)) {
    const [minutes, seconds] = text.split(':').map(Number);
    return minutes * 60 + seconds;
  }
  const numeric = Number(fallback || 0);
  return numeric > 10000 ? Math.round(numeric / 1000) : Math.max(0, numeric);
}

function normalizeSong(value: unknown): MusicInfo | null {
  if (!isRecord(value)) return null;
  const source = String(value.source || '').trim() as PlatformId;
  const name = String(value.name || value.title || '').trim();
  if (!PLATFORM_IDS.has(source) || !name) return null;
  const meta = isRecord(value.meta) ? value.meta : {};
  const singer = String(value.singer || value.artist || '').trim();
  return {
    ...meta,
    ...value,
    source,
    name,
    singer,
    albumName: String(value.albumName || meta.albumName || ''),
    duration: parseDuration(value.interval, value.duration),
    interval: value.interval == null ? undefined : String(value.interval),
    img: String(value.img || meta.picUrl || ''),
    meta: { ...meta },
  };
}

function normalizeSongs(value: unknown, remaining: number): MusicInfo[] {
  if (!Array.isArray(value) || remaining <= 0) return [];
  return value.slice(0, Math.min(MAX_SONGS_PER_PLAYLIST, remaining)).map(normalizeSong).filter((song): song is MusicInfo => Boolean(song));
}

export function parseLxmcBytes(raw: Uint8Array): LxmcParseResult {
  if (!raw.byteLength) throw new Error('洛雪备份为空');
  if (raw.byteLength > MAX_COMPRESSED_BYTES) throw new Error('洛雪备份超过 8 MB 限制');
  const decoded = raw[0] === 0x1f && raw[1] === 0x8b ? inflateBounded(raw) : raw;
  if (decoded.byteLength > MAX_INFLATED_BYTES) throw new Error('洛雪备份内容过大');

  let root: unknown;
  try { root = JSON.parse(bytesToUtf8(decoded).replace(/^\uFEFF/, '')); }
  catch { throw new Error('无法读取洛雪备份内容'); }
  if (!isRecord(root)) throw new Error('洛雪备份结构无效');
  const data = isRecord(root.data) ? root.data : root;
  const lists = isRecord(data.lists) ? data.lists : data;
  if (!isRecord(lists)) throw new Error('洛雪备份中没有找到歌单数据');

  const playlists: LxmcPlaylist[] = [];
  let total = 0;
  const add = (id: string, name: string, kind: LxmcPlaylist['kind'], songsValue: unknown): void => {
    if (playlists.length >= MAX_PLAYLISTS || total >= MAX_TOTAL_SONGS) return;
    const songs = normalizeSongs(songsValue, MAX_TOTAL_SONGS - total);
    if (!songs.length) return;
    playlists.push({ id, name, kind, songs });
    total += songs.length;
  };

  if (Array.isArray(data.list)) {
    add(
      `user:${String(data.id || 'imported')}`,
      String(data.name || '导入歌单'),
      'user',
      data.list,
    );
  }
  add('default', '默认列表', 'default', lists.defaultList);
  add('love', '我的收藏', 'love', lists.loveList);
  if (Array.isArray(lists.userList)) {
    for (const [index, item] of lists.userList.entries()) {
      if (!isRecord(item)) continue;
      add(`user:${String(item.id || index)}`, String(item.name || `自建歌单 ${index + 1}`), 'user', item.list);
    }
  }
  add('temp', '临时列表', 'temp', lists.tempList);
  if (!playlists.length) throw new Error('洛雪备份的歌单中没有可导入歌曲');

  return {
    format: 'lxmc',
    backup_type: String(root.type || 'unknown'),
    playlists,
    total_songs: total,
  };
}

export function parseLxmcBase64(encoded: unknown): LxmcParseResult {
  const value = String(encoded || '').trim();
  if (!value) throw new Error('缺少洛雪备份内容');
  if (value.length > Math.ceil((MAX_COMPRESSED_BYTES * 4) / 3) + 8) throw new Error('洛雪备份超过 8 MB 限制');
  return parseLxmcBytes(base64ToBytes(value));
}
