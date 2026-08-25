import { describe, expect, it } from 'vitest';
import { mergeTranslatedLyric } from '../../src/lyrics/resolver';

describe('歌词合并', () => {
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
});
