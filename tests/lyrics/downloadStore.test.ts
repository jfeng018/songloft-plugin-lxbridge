import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('download lyric snapshots', () => {
  const values = new Map<string, unknown>();

  beforeEach(() => {
    values.clear();
    vi.resetModules();
    (globalThis as typeof globalThis & { songloft: unknown }).songloft = {
      persistentStorage: {
        get: vi.fn(async (key: string) => values.get(key)),
        set: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
      },
    };
  });

  it('keeps the preview text and source item independently from the Songloft song record', async () => {
    const store = await import('../../src/lyrics/downloadStore');
    const item = {
      title: '测试歌曲', artist: '测试歌手', duration: 180,
      source_data: { platform: 'wy', songInfo: { id: '123', name: '测试歌曲', singer: '测试歌手' } },
    } as any;
    const result = {
      status: 'completed', lyric: '[00:01]原文', tlyric: '[00:01]翻译', lxlyric: '',
      displayLyric: '[00:01]原文\n[00:01]翻译', source: 'wy', fallback: false, message: '已获取歌词', error: '',
    } as any;

    await store.saveDownloadLyricSnapshot('job-1', 7, item, result);
    store.resetDownloadLyricStore();

    await expect(store.getDownloadLyricSnapshot('job-1')).resolves.toMatchObject({
      job_id: 'job-1', song_id: 7, item, result,
    });
  });
});
