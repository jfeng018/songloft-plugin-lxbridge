import { inflate } from 'pako';

export type WordLyricStatus = 'available' | 'not_found' | 'unsupported' | 'unknown';

export function formatLyricTime(timeMs: number): string {
  const value = Math.max(0, Math.floor(timeMs));
  const minutes = Math.floor(value / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  const milliseconds = value % 1000;
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}]`;
}

export function parseNeteaseYrc(input: unknown): { lyric: string; lxlyric: string } {
  const lrcLines: string[] = [];
  const wordLines: string[] = [];
  for (const rawLine of String(input || '').replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    const header = /^\[(\d+),\d+\]/.exec(line);
    if (!header) continue;
    const lineStart = Number(header[1]);
    const body = line.slice(header[0].length);
    const tokenPattern = /\((\d+),(\d+),\d+\)([^()]*)/g;
    const plain: string[] = [];
    const enhanced: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(body))) {
      const word = match[3];
      if (!word) continue;
      plain.push(word);
      enhanced.push(`<${Math.max(0, Number(match[1]) - lineStart)},${Math.max(0, Number(match[2]))}>${word}`);
    }
    if (!plain.length) continue;
    const time = formatLyricTime(lineStart);
    lrcLines.push(`${time}${plain.join('')}`);
    wordLines.push(`${time}${enhanced.join('')}`);
  }
  return { lyric: lrcLines.join('\n'), lxlyric: wordLines.join('\n') };
}

function base64Bytes(input: string): Uint8Array {
  const hex = Buffer.from(input, 'base64').toString('hex');
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export function decodeKugouKrc(input: unknown): { lyric: string; tlyric: string; lxlyric: string } {
  const encoded = String(input || '').trim();
  if (!encoded) return { lyric: '', tlyric: '', lxlyric: '' };
  const source = base64Bytes(encoded);
  if (source.length <= 4) return { lyric: '', tlyric: '', lxlyric: '' };
  const key = [0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69];
  const encrypted = source.slice(4);
  for (let index = 0; index < encrypted.length; index += 1) encrypted[index] ^= key[index % key.length];
  const text = new TextDecoder('utf-8').decode(inflate(encrypted)).replace(/\r/g, '');
  let body = text.replace(/^.*\[id:\$\w+\]\n/, '');
  let tlyric = '';
  const language = /\[language:([\w=\\/+]+)\]/.exec(body);
  if (language) {
    body = body.replace(language[0], '').trim();
    try {
      const metadata = JSON.parse(new TextDecoder('utf-8').decode(base64Bytes(language[1]))) as { content?: Array<{ type?: number; lyricContent?: string[][] }> };
      const translated = metadata.content?.find(item => item.type === 1)?.lyricContent;
      if (translated) tlyric = translated.map(row => row.join('')).join('\n');
    } catch { /* optional translation metadata */ }
  }
  const lyricLines: string[] = [];
  const wordLines: string[] = [];
  const translatedLines = tlyric ? tlyric.split('\n') : [];
  const timedTranslations: string[] = [];
  let lineIndex = 0;
  for (const line of body.split('\n')) {
    const header = /^\[(\d+),(\d+)\]/.exec(line.trim());
    if (!header) continue;
    const time = formatLyricTime(Number(header[1]));
    const enhanced = line.trim().slice(header[0].length).replace(/<(\d+),(\d+),\d+>/g, '<$1,$2>');
    const plain = enhanced.replace(/<\d+,\d+>/g, '');
    if (!plain) continue;
    lyricLines.push(`${time}${plain}`);
    wordLines.push(`${time}${enhanced}`);
    if (translatedLines[lineIndex]) timedTranslations.push(`${time}${translatedLines[lineIndex]}`);
    lineIndex += 1;
  }
  return { lyric: lyricLines.join('\n'), tlyric: timedTranslations.join('\n'), lxlyric: wordLines.join('\n') };
}
