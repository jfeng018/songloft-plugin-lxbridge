import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: { auto_fetch: true, provider_enabled: false, fallback_enabled: true, preferred_source: 'auto', translation_mode: 'merge', request_interval_ms: 300 },
  searchAcross: vi.fn(),
  matchScore: vi.fn(() => 150),
  getLyric: { kw: vi.fn(), kg: vi.fn(), tx: vi.fn(), wy: vi.fn(), mg: vi.fn() },
  getLrclibLyrics: vi.fn(),
}));

vi.mock('../../src/lyrics/settings', () => ({ getLyricSettings: vi.fn(async () => mocks.settings) }));
vi.mock('../../src/handlers/search', () => ({ searchAcross: mocks.searchAcross, matchScore: mocks.matchScore }));
vi.mock('../../src/musicSdk/facade', () => ({ musicSdk: Object.fromEntries(Object.entries(mocks.getLyric).map(([key, getLyric]) => [key, { getLyric }])) }));
vi.mock('../../src/lyrics/lrclib', () => ({ getLrclibLyrics: mocks.getLrclibLyrics }));

import { clearLyricCache, mergeTranslatedLyric, resolveLyrics, resolveLyricsByMetadata } from '../../src/lyrics/resolver';

describe('歌词合并', () => {
  beforeEach(() => {
    clearLyricCache();
    vi.clearAllMocks();
    Object.assign(mocks.settings, { fallback_enabled: true, preferred_source: 'auto' });
  });
  it('按时间轴把翻译歌词放在原文后面', () => {
    expect(mergeTranslatedLyric(
      '[00:01.00]Hello\n[00:02.00]World',
      '[00:01.00]你好\n[00:02.00]世界',
    )).toBe('[00:01.00]Hello\n[00:01.00]你好\n[00:02.00]World\n[00:02.00]世界');
  });

  it('没有翻译时保持原歌词不变', () => {
    expect(mergeTranslatedLyric('[00:01.00]原歌词', '')).toBe('[00:01.00]原歌词');
  });

  it('没有原文时仍保留翻译歌词', () => {
    expect(mergeTranslatedLyric('', '[00:01.00]翻译')).toBe('[00:01.00]翻译');
  });

  it('不会重复写入完全相同的行', () => {
    expect(mergeTranslatedLyric('[00:01.00]相同', '[00:01.00]相同')).toBe('[00:01.00]相同');
  });

  it('优先尝试用户指定的歌词来源', async () => {
    mocks.settings.preferred_source = 'wy';
    mocks.searchAcross.mockResolvedValue([{
      title: '测试歌曲', artist: '测试歌手', duration: 180,
      source_data: { platform: 'wy', songInfo: { id: 'wy-1', name: '测试歌曲', singer: '测试歌手', duration: 180 } },
    }]);
    mocks.getLyric.wy.mockResolvedValue({ lyric: '[00:01.00]网易歌词' });
    const result = await resolveLyrics({
      title: '测试歌曲', artist: '测试歌手', duration: 180,
      source_data: { platform: 'tx', songInfo: { id: 'tx-1', name: '测试歌曲', singer: '测试歌手', duration: 180 } },
    });
    expect(result).toMatchObject({ status: 'completed', source: 'wy', fallback: true });
    expect(mocks.getLyric.wy).toHaveBeenCalledOnce();
    expect(mocks.getLyric.tx).not.toHaveBeenCalled();
  });

  it('关闭跨平台补全后不会退回其他来源', async () => {
    Object.assign(mocks.settings, { preferred_source: 'wy', fallback_enabled: false });
    mocks.searchAcross.mockResolvedValue([{
      title: '测试歌曲', artist: '测试歌手', duration: 180,
      source_data: { platform: 'wy', songInfo: { id: 'wy-2', name: '测试歌曲', singer: '测试歌手', duration: 180 } },
    }]);
    mocks.getLyric.wy.mockResolvedValue({ lyric: '', lxlyric: '' });
    const result = await resolveLyrics({
      title: '测试歌曲', artist: '测试歌手', duration: 180,
      source_data: { platform: 'tx', songInfo: { id: 'tx-2', name: '测试歌曲', singer: '测试歌手', duration: 180 } },
    });
    expect(result).toMatchObject({ status: 'not_found', source: 'wy' });
    expect(mocks.getLyric.tx).not.toHaveBeenCalled();
  });

  it('可以只根据 Songloft 提供的歌曲元数据返回原生歌词', async () => {
    mocks.settings.preferred_source = 'tx';
    mocks.searchAcross.mockResolvedValue([{
      title: '原生测试', artist: '测试歌手', album: '测试专辑', duration: 200,
      source_data: { platform: 'tx', songInfo: { id: 'tx-native', name: '原生测试', singer: '测试歌手', albumName: '测试专辑', duration: 200 } },
    }]);
    mocks.getLyric.tx.mockResolvedValue({ lyric: '[00:01.00]原生歌词' });
    await expect(resolveLyricsByMetadata({ title: '原生测试', artist: '测试歌手', album: '测试专辑', duration: 200 })).resolves.toMatchObject({
      status: 'completed', source: 'tx', lyric: '[00:01.00]原生歌词',
    });
  });

  it('可以把 LRCLIB 作为独立首选来源', async () => {
    Object.assign(mocks.settings, { preferred_source: 'lrclib', fallback_enabled: false });
    mocks.getLrclibLyrics.mockResolvedValue({ lyric: '[00:01.00]LRCLIB 歌词', wordLyricSupported: false });
    const result = await resolveLyrics({
      title: '测试歌曲', artist: '测试歌手', album: '测试专辑', duration: 180,
      source_data: { platform: 'wy', songInfo: { id: 'wy-lrclib', name: '测试歌曲', singer: '测试歌手', duration: 180 } },
    });
    expect(result).toMatchObject({ status: 'completed', source: 'lrclib', lyric: '[00:01.00]LRCLIB 歌词' });
    expect(mocks.getLyric.wy).not.toHaveBeenCalled();
  });
});
