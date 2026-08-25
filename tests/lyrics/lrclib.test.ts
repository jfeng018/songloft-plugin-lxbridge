import { describe, expect, it } from 'vitest';
import { parseLrclibResponse } from '../../src/lyrics/lrclib';

describe('LRCLIB 歌词', () => {
  it('优先保留同步歌词', () => {
    expect(parseLrclibResponse({
      plainLyrics: 'Hello', syncedLyrics: '[00:01.00]Hello', instrumental: false,
    })).toMatchObject({ lyric: '[00:01.00]Hello', wordLyricSupported: false });
  });

  it('没有同步歌词时使用纯文本歌词', () => {
    expect(parseLrclibResponse({ plainLyrics: 'Hello', syncedLyrics: null })).toMatchObject({ lyric: 'Hello' });
  });

  it('纯音乐或空响应不会伪造歌词', () => {
    expect(parseLrclibResponse({ instrumental: true, plainLyrics: 'instrumental' })).toBeNull();
    expect(parseLrclibResponse({ plainLyrics: '', syncedLyrics: '' })).toBeNull();
  });
});
