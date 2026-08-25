import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import { parseQuery } from '@songloft/plugin-sdk';
import type { DownloadManager } from '../download/manager';
import { parseJSONBody } from './request';
import { errorMessage, fail, ok } from './response';
import { upsertSearchSongs, type SearchSongItem } from './importSongs';
import { getDownloadPathSettings, resolveDownloadPathSettings, type DownloadPathSettings } from '../download/settings';
import type { RuntimeManager } from '../engine/manager';
import type { MusicInfo, PlatformId } from '../types';
import { probeAudio } from './direct';
import { localAudioFileStatus } from '../download/filesystem';
import { matchScore, searchAcross } from './search';
import type { ResolvedUrl } from '../types';
import type { ResolvedLyrics } from '../lyrics/resolver';
import { getLyricSettings } from '../lyrics/settings';
import type { LyricPreferredSource } from '../lyrics/settings';
import { getDownloadLyricSnapshot, saveDownloadLyricSnapshot } from '../lyrics/downloadStore';
import type { WordLyricStatus } from '../lyrics/wordLyric';

interface DownloadRequest {
  song?: SearchSongItem;
  download_meta?: { total_bytes?: number | null; actual_quality?: string; content_type?: string };
  download_options?: Partial<DownloadPathSettings>;
  upgrade_meta?: { source_song_id?: number; source_bitrate?: number; target_quality?: string };
}

interface BatchDownloadRequest {
  songs?: SearchSongItem[];
  download_options?: Partial<DownloadPathSettings>;
  quality?: string;
  allow_downgrade?: boolean;
}

interface ResolvedDownloadItem {
  item: SearchSongItem;
  sourceData: Record<string, any>;
  source: PlatformId;
  resolved: ResolvedUrl;
  fallbackMessage: string;
}

interface LyricPreviewData {
  job_id: string;
  song_id: number;
  title: string;
  artist: string;
  file_path: string;
  status: string;
  source: string;
  fallback: boolean;
  message: string;
  written: string;
  lyric: string;
  tlyric: string;
  lxlyric: string;
  word_lyric_status: WordLyricStatus;
}

function isPlatform(value: unknown): value is PlatformId {
  return ['kw', 'kg', 'tx', 'wy', 'mg'].includes(String(value));
}

function parseSourceData(value: unknown): Record<string, any> | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
}

const PLATFORM_NAMES: Record<PlatformId, string> = {
  kw: '酷我', kg: '酷狗', tx: 'QQ 音乐', wy: '网易云', mg: '咪咕',
};

async function resolveDownloadItem(
  runtimeManager: RuntimeManager,
  item: SearchSongItem,
  quality: string,
  allowDowngrade: boolean,
): Promise<ResolvedDownloadItem> {
  const originalData = item.source_data || {};
  const originalSource = String(originalData.platform || '') as PlatformId;
  const originalSong = originalData.songInfo as MusicInfo | undefined;
  if (!isPlatform(originalSource) || !originalSong) throw new Error('歌曲缺少有效 source_data');

  let originalError = '';
  if (runtimeManager.hasPlatform(originalSource)) {
    try {
      return {
        item,
        sourceData: originalData,
        source: originalSource,
        resolved: await runtimeManager.getMusicUrl(originalSource, originalSong, quality, allowDowngrade),
        fallbackMessage: '',
      };
    } catch (error) {
      originalError = String((error as Error)?.message || error);
    }
  } else {
    originalError = `没有已启用且支持 ${originalSource} 的洛雪音源`;
  }

  const keyword = `${item.title || originalSong.name || ''} ${item.artist || originalSong.singer || ''}`.trim();
  const duration = Number(item.duration || originalSong.duration || 0) || undefined;
  const candidates = (await searchAcross(keyword, 1, 10, quality))
    .filter(candidate => {
      const platform = String(candidate.source_data?.platform || '');
      return isPlatform(platform) && platform !== originalSource && runtimeManager.hasPlatform(platform);
    })
    .map(candidate => ({ candidate, score: matchScore(candidate, item.title || originalSong.name || '', item.artist || originalSong.singer || '', duration) }))
    .filter(entry => entry.score >= 100)
    .sort((a, b) => b.score - a.score);

  const fallbackErrors: string[] = [];
  for (const { candidate } of candidates.slice(0, 5)) {
    const sourceData = candidate.source_data || {};
    const source = String(sourceData.platform || '') as PlatformId;
    const songInfo = sourceData.songInfo as MusicInfo | undefined;
    if (!isPlatform(source) || !songInfo) continue;
    try {
      const resolved = await runtimeManager.getMusicUrl(source, songInfo, quality, allowDowngrade);
      return {
        item: candidate as SearchSongItem,
        sourceData,
        source,
        resolved,
        fallbackMessage: `原平台${PLATFORM_NAMES[originalSource]}不可用，已自动切换到${PLATFORM_NAMES[source]}`,
      };
    } catch (error) {
      fallbackErrors.push(`${source}: ${String((error as Error)?.message || error)}`);
    }
  }

  const fallbackDetail = candidates.length
    ? fallbackErrors.length ? `；替代候选解析失败：${fallbackErrors.join('；')}` : '；没有可安全匹配的可用替代版本'
    : '；没有找到歌名、歌手和时长匹配的其他平台版本';
  throw new Error(`原平台解析失败：${originalError}${fallbackDetail}`);
}

export function downloadHandlers(manager: DownloadManager, runtimeManager: RuntimeManager): {
  create: (req: HTTPRequest) => Promise<HTTPResponse>;
  createBatch: (req: HTTPRequest) => Promise<HTTPResponse>;
  status: (req: HTTPRequest) => Promise<HTTPResponse>;
  lyric: (req: HTTPRequest) => Promise<HTTPResponse>;
  lyricFile: (req: HTTPRequest) => Promise<HTTPResponse>;
  retry: (req: HTTPRequest) => Promise<HTTPResponse>;
  retryLyric: (req: HTTPRequest) => Promise<HTTPResponse>;
  remove: (req: HTTPRequest) => Promise<HTTPResponse>;
  queue: (req: HTTPRequest) => Promise<HTTPResponse>;
} {
  async function loadLyricPreview(id: string): Promise<LyricPreviewData> {
    if (!id) throw new Error('缺少下载任务 id');
    const job = manager.get(id);
    if (!job?.song_id) throw new Error('该任务还没有可查看的歌曲记录');
    const snapshot = await getDownloadLyricSnapshot(id);
    const song = await songloft.songs.getById(job.song_id) as unknown as Record<string, unknown> | null;
    if (!song) throw new Error('歌曲记录不存在');
    const sourceData = parseSourceData(song.source_data);
    const lyrics = sourceData?.lyrics || {};
    const stored = snapshot?.result;
    return {
      job_id: job.id,
      song_id: job.song_id,
      title: String(song.title || job.title || ''),
      artist: String(song.artist || job.artist || ''),
      file_path: String(song.file_path || job.path || ''),
      status: job.lyric_status || stored?.status || lyrics.status || 'skipped',
      source: job.lyric_source_id || stored?.source || lyrics.source || '',
      fallback: stored?.fallback ?? Boolean(lyrics.fallback),
      message: job.lyric_message || stored?.message || lyrics.message || '',
      written: stored?.displayLyric || String(song.lyric || ''),
      lyric: stored?.lyric || String(lyrics.lyric || ''),
      tlyric: stored?.tlyric || String(lyrics.tlyric || ''),
      lxlyric: stored?.lxlyric || String(lyrics.lxlyric || ''),
      word_lyric_status: stored?.wordLyricStatus || (stored?.lxlyric || lyrics.lxlyric ? 'available' : ['tx', 'kw', 'mg'].includes(String(job.lyric_source_id || stored?.source || lyrics.source || '')) ? 'unsupported' : 'unknown'),
    };
  }

  return {
    create: async (req: HTTPRequest): Promise<HTTPResponse> => {
      try {
        const body = parseJSONBody<DownloadRequest>(req);
        if (!body.song || typeof body.song !== 'object') throw new Error('song 不能为空');

        let selectedSong = body.song;
        let fallbackMessage = '';
        const originalSource = String(body.song.source_data?.platform || '') as PlatformId;
        if (isPlatform(originalSource) && !runtimeManager.hasPlatform(originalSource)) {
          const quality = String(body.song.source_data?.quality || '320k');
          const selected = await resolveDownloadItem(runtimeManager, body.song, quality, body.song.source_data?.allow_downgrade !== false);
          selectedSong = selected.item;
          selectedSong.source_data.requested_quality = selected.resolved.requestedQuality || quality;
          selectedSong.source_data.quality = selected.resolved.actualQuality || quality;
          selectedSong.source_data.allow_downgrade = body.song.source_data?.allow_downgrade !== false;
          fallbackMessage = selected.fallbackMessage;
        }

        const upgradeSuffix = body.upgrade_meta?.source_song_id
          ? `:upgrade:${Number(body.upgrade_meta.source_song_id)}:${String(body.upgrade_meta.target_quality || 'quality')}`
          : '';
        const lyricSettings = await getLyricSettings();
        const shouldFetchLyric = lyricSettings.auto_fetch;
        let lyricResult: ResolvedLyrics | undefined;
        const created = await upsertSearchSongs([selectedSong], shouldFetchLyric, upgradeSuffix, result => { lyricResult = result; });
        const record = created[0];
        if (!record?.id) throw new Error('写入 Songloft 歌曲库失败');

        let current = await songloft.songs.getById(record.id);
        if (!current) throw new Error('无法读取已导入的歌曲记录');
        if (current.type === 'local' && await localAudioFileStatus(current.file_path) === 'missing') {
          const recovered = await upsertSearchSongs([selectedSong], lyricSettings.auto_fetch, `${upgradeSuffix}:missing-file-recovery:${Date.now()}`);
          current = recovered[0]?.id ? await songloft.songs.getById(recovered[0].id) : null;
          if (!current) throw new Error('本地文件已丢失，创建恢复下载记录失败');
        }
        const pathSettings = await getDownloadPathSettings();
        const selectedSettings = resolveDownloadPathSettings(body.download_options || {}, pathSettings);
        if (body.upgrade_meta?.source_song_id) {
          if (!selectedSettings.target_dir) throw new Error('安全洗版必须使用独立的新版保存目录');
          const oldSong = await songloft.songs.getById(Number(body.upgrade_meta.source_song_id));
          if (!oldSong || oldSong.type !== 'local') throw new Error('洗版源歌曲不存在或已被修改');
          const oldPath = String(oldSong.file_path || '').replace(/\\/g, '/');
          const oldDirectory = oldPath.slice(0, oldPath.lastIndexOf('/')).replace(/\/+$/, '');
          if (oldDirectory && selectedSettings.target_dir === oldDirectory) {
            throw new Error('新版保存目录不能与旧文件所在目录相同，请使用独立目录');
          }
        }
        const job = manager.enqueue(current, {
          ...(body.download_meta || {}),
          source_id: String(selectedSong.source_data?.platform || '') || undefined,
          lyric_status: lyricResult?.status || (shouldFetchLyric ? 'failed' : 'skipped'),
          lyric_source_id: String(lyricResult?.source || '') || undefined,
          lyric_message: lyricResult?.message,
          lyric_error: lyricResult?.error,
          target_dir: selectedSettings.target_dir || undefined,
          path_template: selectedSettings.target_dir ? (body.upgrade_meta?.source_song_id ? '{title}-{artist}' : selectedSettings.path_template) : undefined,
          upgrade_source_song_id: Number(body.upgrade_meta?.source_song_id || 0) || undefined,
          upgrade_source_bitrate: Number(body.upgrade_meta?.source_bitrate || 0) || undefined,
          upgrade_target_quality: String(body.upgrade_meta?.target_quality || '') || undefined,
        });
        if (lyricResult) {
          try { await saveDownloadLyricSnapshot(job.id, current.id, selectedSong, lyricResult); }
          catch (error) { songloft.log.warn(`保存歌词预览失败 ${job.title}: ${errorMessage(error)}`); }
        }
        if (fallbackMessage) manager.setResolvedSource(job.id, String(selectedSong.source_data?.platform || ''), fallbackMessage);
        return ok({ job });
      } catch (error) {
        return fail(errorMessage(error), 400);
      }
    },

    createBatch: async (req: HTTPRequest): Promise<HTTPResponse> => {
      try {
        const body = parseJSONBody<BatchDownloadRequest>(req);
        if (!Array.isArray(body.songs) || !body.songs.length) throw new Error('songs 不能为空');
        if (body.songs.length > 500) throw new Error('单次批量下载最多支持 500 首');
        const defaults = await getDownloadPathSettings();
        const selected = resolveDownloadPathSettings(body.download_options || {}, defaults);
        const jobs = body.songs.map(song => manager.reserve(song, {
          target_dir: selected.target_dir || undefined,
          path_template: selected.target_dir ? selected.path_template : undefined,
          client_key: String((song as SearchSongItem & { _download_client_key?: string })._download_client_key || '') || undefined,
          source_id: String(song.source_data?.platform || '') || undefined,
          lyric_status: 'pending',
        }));
        const requestedQuality = String(body.quality || '320k');
        const allowDowngrade = body.allow_downgrade !== false;
        const lyricSettings = await getLyricSettings();
        setTimeout(() => {
          void (async () => {
            for (let index = 0; index < body.songs!.length; index += 1) {
              const item = body.songs![index]; const job = jobs[index];
              try {
                manager.setStage(job.id, 'resolving', 10, '正在解析播放地址');
                const quality = String(item.source_data?.quality || requestedQuality);
                const selected = await resolveDownloadItem(runtimeManager, item, quality, allowDowngrade);
                const resolvedItem = selected.item;
                const sourceData = selected.sourceData;
                const resolved = selected.resolved;
                manager.setResolvedSource(job.id, selected.source, selected.fallbackMessage);
                manager.setStage(job.id, 'resolving', 20, '正在探测文件信息');
                let probe: { total_bytes: number | null; content_type: string } = { total_bytes: null, content_type: '' };
                try { probe = await probeAudio(resolved.url, Object.fromEntries(Object.entries(resolved.headers || {}).map(([key,value]) => [key,String(value)]))); }
                catch { /* 文件大小探测失败不阻止下载 */ }
                sourceData.requested_quality = resolved.requestedQuality || quality;
                sourceData.quality = resolved.actualQuality || quality;
                sourceData.allow_downgrade = allowDowngrade;
                manager.setStage(job.id, 'resolving', 28, '正在写入 Songloft 曲库');
                if (lyricSettings.auto_fetch) manager.setLyricState(job.id, 'fetching', { message: '正在获取歌词' });
                let lyricResult: ResolvedLyrics | undefined;
                const created = await upsertSearchSongs([resolvedItem], lyricSettings.auto_fetch, '', result => {
                  lyricResult = result;
                  manager.setLyricState(job.id, result.status, result);
                });
                const record = created[0];
                if (!record?.id) throw new Error('写入 Songloft 曲库失败');
                let current = await songloft.songs.getById(record.id);
                if (!current) throw new Error('无法读取已入库歌曲');
                if (current.type === 'local' && await localAudioFileStatus(current.file_path) === 'missing') {
                  const recovered = await upsertSearchSongs([resolvedItem], true, `:missing-file-recovery:${Date.now()}:${index}`);
                  current = recovered[0]?.id ? await songloft.songs.getById(recovered[0].id) : null;
                  if (!current) throw new Error('本地文件已丢失，创建恢复下载记录失败');
                }
                if (lyricResult) {
                  try { await saveDownloadLyricSnapshot(job.id, current.id, resolvedItem, lyricResult); }
                  catch (error) { songloft.log.warn(`保存歌词预览失败 ${job.title}: ${errorMessage(error)}`); }
                }
                manager.activate(job.id, current, {
                  total_bytes: probe.total_bytes,
                  content_type: probe.content_type,
                  actual_quality: resolved.actualQuality || quality,
                });
              } catch (error) {
                // 用户可能在解析请求尚未返回时取消任务；已移除的任务无需重新写回失败状态。
                if (manager.get(job.id)) manager.fail(job.id, error);
              }
            }
          })();
        }, 0);
        return ok({ jobs, count: jobs.length });
      } catch (error) { return fail(errorMessage(error), 400); }
    },

    status: async (req: HTTPRequest): Promise<HTTPResponse> => {
      const id = parseQuery(req.query || '').id || '';
      if (!id) return ok({ jobs: manager.list(), queue: manager.getQueueState() });
      const job = manager.get(id);
      if (!job) return fail('下载任务不存在或已过期', 404);
      return ok({ job });
    },

    lyric: async (req: HTTPRequest): Promise<HTTPResponse> => {
      try {
        const id = parseQuery(req.query || '').id || '';
        return ok(await loadLyricPreview(id));
      } catch (error) {
        return fail(errorMessage(error), 400);
      }
    },

    lyricFile: async (req: HTTPRequest): Promise<HTTPResponse> => {
      try {
        const id = parseQuery(req.query || '').id || '';
        const preview = await loadLyricPreview(id);
        const content = preview.written || preview.lyric || preview.tlyric || preview.lxlyric;
        if (!content) return fail('当前歌曲没有可导出的歌词', 404);
        const pathName = preview.file_path.replace(/\\/g, '/').split('/').pop() || '';
        const baseName = pathName.replace(/\.[^.]+$/, '') || `${preview.title}${preview.artist ? `-${preview.artist}` : ''}` || 'lyrics';
        const safeName = `${baseName.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || 'lyrics'}.lrc`;
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="lyrics.lrc"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
            'Cache-Control': 'no-store',
          },
          body: `\uFEFF${content}`,
        };
      } catch (error) {
        return fail(errorMessage(error), 400);
      }
    },

    retry: async (req: HTTPRequest): Promise<HTTPResponse> => {
      try {
        const body = parseJSONBody<{ id?: string }>(req);
        if (!body.id) throw new Error('缺少下载任务 id');
        return ok({ job: manager.retry(body.id) });
      } catch (error) {
        return fail(errorMessage(error), 400);
      }
    },

    retryLyric: async (req: HTTPRequest): Promise<HTTPResponse> => {
      let jobId = '';
      try {
        const body = parseJSONBody<{ id?: string; preferred_source?: LyricPreferredSource }>(req);
        jobId = String(body.id || '');
        if (!jobId) throw new Error('缺少下载任务 id');
        const job = manager.get(jobId);
        if (!job?.song_id) throw new Error('该任务还没有可用于获取歌词的歌曲记录');
        const snapshot = await getDownloadLyricSnapshot(jobId);
        const song = await songloft.songs.getById(job.song_id) as unknown as Record<string, unknown> | null;
        if (!song) throw new Error('歌曲记录不存在');
        const sourceData = parseSourceData(song.source_data);
        let item = snapshot?.item as SearchSongItem | undefined;
        if (!item?.source_data?.songInfo) {
          if (sourceData?.songInfo) {
            item = {
              title: String(song.title || job.title || ''), artist: String(song.artist || job.artist || ''),
              album: String(song.album || ''), duration: Number(song.duration || 0), cover_url: String(song.cover_url || ''),
              source_data: sourceData,
            };
          } else {
            const title = String(song.title || job.title || '');
            const artist = String(song.artist || job.artist || '');
            const duration = Number(song.duration || 0) || undefined;
            item = (await searchAcross(`${title} ${artist}`.trim(), 1, 10, '128k'))
              .map(candidate => ({ candidate, score: matchScore(candidate, title, artist, duration) }))
              .filter(entry => entry.score >= 130)
              .sort((a, b) => b.score - a.score)[0]?.candidate;
            if (!item) throw new Error('未找到歌名、歌手和时长均安全匹配的歌词来源');
          }
        }
        manager.setLyricState(jobId, 'fetching', { message: '正在重新获取歌词' });
        let lyricResult: ResolvedLyrics | undefined;
        await upsertSearchSongs([item], true, '', result => {
          lyricResult = result;
          manager.setLyricState(jobId, result.status, result);
        }, body.preferred_source);
        if (lyricResult) await saveDownloadLyricSnapshot(jobId, job.song_id, item, lyricResult);
        return ok({ job: manager.get(jobId) });
      } catch (error) {
        if (jobId && manager.get(jobId)) manager.setLyricState(jobId, 'failed', { message: '重新获取歌词失败', error: errorMessage(error) });
        return fail(errorMessage(error), 400);
      }
    },

    remove: async (req: HTTPRequest): Promise<HTTPResponse> => {
      const query = parseQuery(req.query || '');
      if (query.all === 'finished') return ok({ removed: manager.clearFinished() });
      if (!query.id) return fail('缺少下载任务 id', 400);
      if (!manager.remove(query.id)) return fail('任务不存在，或已进入实际下载阶段，Songloft 暂不支持中止传输', 409);
      return ok({ removed: 1 });
    },

    queue: async (req: HTTPRequest): Promise<HTTPResponse> => {
      try {
        const body = parseJSONBody<{ action?: string; id?: string; direction?: 'up' | 'down'; ids?: string[] }>(req);
        if (body.action === 'pause') return ok({ queue: manager.pause() });
        if (body.action === 'resume') return ok({ queue: manager.resume() });
        if (body.action === 'move') {
          if (!body.id || !['up', 'down'].includes(String(body.direction))) throw new Error('调整顺序需要任务 id 和方向');
          return ok({ queue: manager.move(body.id, body.direction as 'up' | 'down') });
        }
        if (body.action === 'cancel_batch') {
          if (!Array.isArray(body.ids) || !body.ids.length) throw new Error('请至少选择一个等待任务');
          return ok({ removed: manager.cancelMany(body.ids), queue: manager.getQueueState() });
        }
        throw new Error('不支持的队列操作');
      } catch (error) {
        return fail(errorMessage(error), 400);
      }
    },
  };
}
