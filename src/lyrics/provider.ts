import type { LyricSettings } from './settings';

let registered = false;

export interface LyricProviderStatus {
  enabled: boolean;
  registered: boolean;
  available: boolean;
}

function available(): boolean {
  return Boolean(songloft.lyrics && typeof songloft.lyrics.registerProvider === 'function');
}

export function getLyricProviderStatus(enabled = false): LyricProviderStatus {
  return { enabled, registered, available: available() };
}

export function applyLyricProvider(settings: Pick<LyricSettings, 'provider_enabled'>): void {
  if (settings.provider_enabled && !registered) {
    if (!available()) throw new Error('当前 Songloft 版本不支持原生歌词提供者接口');
    songloft.lyrics.registerProvider();
    registered = true;
    songloft.log.info('[neo-lxbridge] native lyric provider registered');
  } else if (!settings.provider_enabled && registered) {
    songloft.lyrics.unregisterProvider();
    registered = false;
    songloft.log.info('[neo-lxbridge] native lyric provider unregistered');
  }
}

export function unregisterLyricProvider(): void {
  if (!registered) return;
  try { songloft.lyrics.unregisterProvider(); } finally { registered = false; }
}
