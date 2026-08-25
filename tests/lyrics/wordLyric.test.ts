import { describe, expect, it } from 'vitest';
import { deflate } from 'pako';
import { decodeKugouKrc, parseNeteaseYrc } from '../../src/lyrics/wordLyric';

function encodeKrc(text: string): string {
  const key = [0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69];
  const compressed = deflate(new TextEncoder().encode(text));
  for (let index = 0; index < compressed.length; index += 1) compressed[index] ^= key[index % key.length];
  return Buffer.from(new Uint8Array([0x6b, 0x72, 0x63, 0x31, ...compressed])).toString('base64');
}

describe('逐字歌词格式', () => {
  it('把网易云 YRC 转为普通歌词和洛雪逐字歌词', () => {
    const result = parseNeteaseYrc('[1000,900](1000,300,0)你(1300,600,0)好');
    expect(result.lyric).toBe('[00:01.000]你好');
    expect(result.lxlyric).toBe('[00:01.000]<0,300>你<300,600>好');
  });

  it('解码酷狗 KRC 并保留逐字时间', () => {
    const result = decodeKugouKrc(encodeKrc('[1000,900]<0,300,0>你<300,600,0>好'));
    expect(result.lyric).toBe('[00:01.000]你好');
    expect(result.lxlyric).toBe('[00:01.000]<0,300>你<300,600>好');
  });
});
